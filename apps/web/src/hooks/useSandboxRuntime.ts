import type { EnvironmentId, SandboxConfig, ServerProvider } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";

const HEALTHCHECK_INTERVAL_MS = 30_000;
const HEALTHCHECK_RETRY_DELAY_MS = 5_000;
const HEALTHCHECK_RETRY_ATTEMPTS = 5;
/** Grace period after launching the startup script before failures count. */
const HEALTHCHECK_STARTUP_GRACE_MS = 60_000;

const PROVIDER_SIGN_IN_POLL_MS = 5_000;
const PROVIDER_SIGN_IN_TIMEOUT_MS = 15 * 60_000;

/**
 * Provider keys accepted in `providers_to_configure`, mapped to the t3
 * driver/instance they control. Only Claude is supported for now.
 */
const CONFIGURABLE_PROVIDERS: Record<string, { instanceId: string; signInCommand: string }> = {
  claude: {
    instanceId: "claudeAgent",
    signInCommand: "claude setup-token",
  },
};

export interface SandboxBranchOption {
  readonly name: string;
  readonly isRemote: boolean;
  readonly current: boolean;
}

export type SandboxGate =
  | { readonly phase: "hidden" }
  | { readonly phase: "loading" }
  | {
      readonly phase: "select";
      readonly branches: ReadonlyArray<SandboxBranchOption>;
      readonly currentBranch: string | null;
      readonly busy: boolean;
    };

export interface SandboxTerminalScript {
  readonly name: string;
  readonly command: string;
}

export interface SandboxRuntime {
  readonly config: SandboxConfig | null;
  readonly gate: SandboxGate;
  readonly confirmBranch: (branchName: string | null) => void;
  /** Runs the shutdown + startup scripts visibly in the bottom terminal. */
  readonly restartSystem: (() => void) | null;
}

/**
 * The app-open sequence runs once per environment per page load, not once
 * per ChatView render cycle. `graceUntilMs` survives remounts so the
 * healthcheck grace period isn't reset by navigation.
 */
interface SandboxAppOpenState {
  gateCompleted: boolean;
  graceUntilMs: number;
}

const appOpenStateByEnvironment = new Map<EnvironmentId, SandboxAppOpenState>();

function appOpenState(environmentId: EnvironmentId): SandboxAppOpenState {
  let state = appOpenStateByEnvironment.get(environmentId);
  if (!state) {
    state = { gateCompleted: false, graceUntilMs: 0 };
    appOpenStateByEnvironment.set(environmentId, state);
  }
  return state;
}

function joinCommands(commands: ReadonlyArray<string | null>): string | null {
  const joined = commands.filter((command): command is string => command !== null).join(" && ");
  return joined.length > 0 ? joined : null;
}

/**
 * Drives the single-project sandbox lifecycle defined by `t3codable.json`:
 *
 * 1. On page load a branch gate is shown: branches are fetched and listed,
 *    with the current branch preselected. Picking a different branch checks
 *    it out and prepends the shutdown script to the startup chain.
 * 2. Providers from `providers_to_configure` are signed in via the visible
 *    terminal (headless device-code flow) and enabled once authenticated.
 * 3. The setup script (`setup_sandbox`) and startup script run chained in
 *    the bottom terminal. When the project is already healthy on an
 *    unchanged branch, both are skipped.
 * 4. The healthcheck runs every 30s with a 1 minute grace period after
 *    startup. A failure is retried 5 times at 5s intervals; if all fail, a
 *    toast offers a shutdown-and-restart, which runs visibly in the
 *    terminal. The same restart is exposed for the header button.
 */
export function useSandboxRuntime(input: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
  gitCwd: string | null;
  onRunScriptInTerminal: (script: SandboxTerminalScript) => void;
}): SandboxRuntime {
  const { environmentId, enabled, gitCwd } = input;
  const [config, setConfig] = useState<SandboxConfig | null>(null);
  const [gate, setGate] = useState<SandboxGate>({ phase: "hidden" });
  const onRunScriptInTerminalRef = useRef(input.onRunScriptInTerminal);
  onRunScriptInTerminalRef.current = input.onRunScriptInTerminal;
  const confirmBranchRef = useRef<(branchName: string | null) => void>(() => undefined);
  const restartSystemRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled || !environmentId || !gitCwd) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    let cancelled = false;
    let pendingTimeoutId: number | null = null;
    let activeConfig: SandboxConfig | null = null;
    let currentBranch: string | null = null;
    const openState = appOpenState(environmentId);

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        pendingTimeoutId = window.setTimeout(resolve, ms);
      });

    const clearPendingTimeout = () => {
      if (pendingTimeoutId !== null) {
        window.clearTimeout(pendingTimeoutId);
        pendingTimeoutId = null;
      }
    };

    const runScriptInTerminal = (script: SandboxTerminalScript) => {
      onRunScriptInTerminalRef.current(script);
    };

    /**
     * `true`/`false` for a real pass/fail; `null` when the result is not a
     * health signal (no script configured, or the RPC itself failed — e.g.
     * a dropped connection should not count as an unhealthy sandbox).
     */
    const runHealthcheck = async (): Promise<boolean | null> => {
      try {
        const result = await api.sandbox.runHealthcheck();
        if (result.status === "no-script") {
          return null;
        }
        return result.status === "passed";
      } catch {
        return null;
      }
    };

    const restartSystem = () => {
      const restartCommand = joinCommands([
        activeConfig?.shutdownCommand ?? null,
        activeConfig?.startupCommand ?? null,
      ]);
      if (restartCommand === null) {
        return;
      }
      clearPendingTimeout();
      runScriptInTerminal({ name: "Shutdown & restart", command: restartCommand });
      openState.graceUntilMs = Date.now() + HEALTHCHECK_STARTUP_GRACE_MS;
      scheduleNextHealthcheck();
    };
    restartSystemRef.current = restartSystem;

    const showHealthcheckFailedToast = () => {
      const toastId = toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Healthcheck failed",
          description:
            "The project healthcheck keeps failing. Restart to shut down and start the system again.",
          timeout: 0,
          actionProps: {
            children: "Shutdown & restart",
            onClick: () => {
              toastManager.close(toastId);
              restartSystemRef.current();
            },
          },
        }),
      );
    };

    const scheduleNextHealthcheck = () => {
      if (cancelled || activeConfig?.healthcheckCommand == null) {
        return;
      }
      const graceRemaining = Math.max(0, openState.graceUntilMs - Date.now());
      pendingTimeoutId = window.setTimeout(
        () => {
          void monitorTick();
        },
        Math.max(graceRemaining, HEALTHCHECK_INTERVAL_MS),
      );
    };

    const monitorTick = async () => {
      if (cancelled) {
        return;
      }
      const healthy = await runHealthcheck();
      if (cancelled) {
        return;
      }
      if (healthy !== false) {
        scheduleNextHealthcheck();
        return;
      }

      for (let attempt = 0; attempt < HEALTHCHECK_RETRY_ATTEMPTS; attempt++) {
        await wait(HEALTHCHECK_RETRY_DELAY_MS);
        if (cancelled) {
          return;
        }
        const retryHealthy = await runHealthcheck();
        if (cancelled) {
          return;
        }
        if (retryHealthy !== false) {
          scheduleNextHealthcheck();
          return;
        }
      }

      // All retries failed: surface the restart toast and pause monitoring
      // until the user restarts the system.
      showHealthcheckFailedToast();
    };

    const readConfiguredProviderSnapshot = (
      providers: ReadonlyArray<ServerProvider>,
      instanceId: string,
    ) => providers.find((provider) => provider.instanceId === instanceId) ?? null;

    /**
     * Signs in and enables every provider listed in
     * `providers_to_configure`. Sign-in runs in the visible terminal
     * (headless device-code flow) while the provider status is polled until
     * it reports authenticated.
     */
    const ensureProvidersConfigured = async (sandboxConfig: SandboxConfig) => {
      const localApi = readLocalApi();
      if (!localApi) {
        return;
      }

      for (const providerKey of sandboxConfig.providersToConfigure) {
        const configurable = CONFIGURABLE_PROVIDERS[providerKey];
        if (!configurable) {
          continue;
        }

        let snapshot: ServerProvider | null = null;
        try {
          snapshot = readConfiguredProviderSnapshot(
            (await localApi.server.refreshProviders()).providers,
            configurable.instanceId,
          );
        } catch {
          continue;
        }
        if (cancelled) {
          return;
        }
        if (snapshot === null) {
          continue;
        }

        if (snapshot.auth.status !== "authenticated") {
          runScriptInTerminal({
            name: `${providerKey} sign-in`,
            command: configurable.signInCommand,
          });

          const pollAttempts = Math.ceil(PROVIDER_SIGN_IN_TIMEOUT_MS / PROVIDER_SIGN_IN_POLL_MS);
          for (let attempt = 0; attempt < pollAttempts; attempt++) {
            await wait(PROVIDER_SIGN_IN_POLL_MS);
            if (cancelled) {
              return;
            }
            try {
              snapshot = readConfiguredProviderSnapshot(
                (await localApi.server.refreshProviders()).providers,
                configurable.instanceId,
              );
            } catch {
              continue;
            }
            if (snapshot?.auth.status === "authenticated") {
              break;
            }
          }
        }
        if (cancelled) {
          return;
        }

        if (snapshot?.auth.status === "authenticated" && !snapshot.enabled) {
          try {
            if (providerKey === "claude") {
              await localApi.server.updateSettings({
                providers: { claudeAgent: { enabled: true } },
              });
            }
            await localApi.server.refreshProviders();
          } catch {
            // Provider stays disabled; the user can enable it in settings.
          }
        }
      }
    };

    /**
     * Runs after the branch gate is confirmed: provider sign-in, then the
     * setup/startup chain in the terminal, then the healthcheck loop.
     */
    const runOpenSequence = async (sandboxConfig: SandboxConfig, branchChanged: boolean) => {
      await ensureProvidersConfigured(sandboxConfig);
      if (cancelled) {
        return;
      }

      // On an unchanged branch, a passing healthcheck means the system is
      // already up — skip setup/startup instead of double-starting it.
      const healthy = branchChanged ? false : await runHealthcheck();
      if (cancelled) {
        return;
      }

      const openCommand =
        healthy === true
          ? null
          : joinCommands([
              branchChanged ? sandboxConfig.shutdownCommand : null,
              sandboxConfig.setupCommand,
              sandboxConfig.startupCommand,
            ]);
      if (openCommand !== null) {
        runScriptInTerminal({
          name: branchChanged ? "Switch branch & start" : "Setup & start",
          command: openCommand,
        });
        if (sandboxConfig.startupCommand !== null) {
          openState.graceUntilMs = Date.now() + HEALTHCHECK_STARTUP_GRACE_MS;
        }
      }

      scheduleNextHealthcheck();
    };

    const confirmBranch = (branchName: string | null) => {
      const sandboxConfig = activeConfig;
      if (sandboxConfig === null) {
        return;
      }
      setGate((current) => (current.phase === "select" ? { ...current, busy: true } : current));
      void (async () => {
        const branchChanged =
          branchName !== null && currentBranch !== null && branchName !== currentBranch;
        if (branchChanged) {
          try {
            await api.vcs.switchRef({ cwd: gitCwd, refName: branchName });
          } catch (error) {
            if (cancelled) {
              return;
            }
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Could not switch to ${branchName}`,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            setGate((current) =>
              current.phase === "select" ? { ...current, busy: false } : current,
            );
            return;
          }
        }
        if (cancelled) {
          return;
        }

        openState.gateCompleted = true;
        setGate({ phase: "hidden" });
        await runOpenSequence(sandboxConfig, branchChanged);
      })();
    };
    confirmBranchRef.current = confirmBranch;

    const loadBranchOptions = async (): Promise<{
      branches: ReadonlyArray<SandboxBranchOption>;
      currentBranch: string | null;
    } | null> => {
      try {
        await api.sandbox.gitFetch();
      } catch {
        // Offline fetches shouldn't block the gate; list what's local.
      }
      if (cancelled) {
        return null;
      }

      try {
        const result = await api.vcs.listRefs({ cwd: gitCwd, limit: 200 });
        if (!result.isRepo) {
          return null;
        }
        const localNames = new Set(
          result.refs.filter((ref) => !ref.isRemote).map((ref) => ref.name),
        );
        const branches = result.refs
          .filter((ref) => {
            if (!ref.isRemote) {
              return true;
            }
            // Hide remote refs that already have a local branch of the same
            // short name (e.g. origin/main when main exists locally).
            const shortName = ref.remoteName ? ref.name.slice(ref.remoteName.length + 1) : ref.name;
            return !localNames.has(shortName);
          })
          .map((ref) => ({
            name: ref.name,
            isRemote: ref.isRemote ?? false,
            current: ref.current,
          }));
        return {
          branches,
          currentBranch: branches.find((branch) => branch.current)?.name ?? null,
        };
      } catch {
        return null;
      }
    };

    const start = async () => {
      let fetchedConfig: SandboxConfig;
      try {
        fetchedConfig = await api.sandbox.getConfig();
      } catch {
        return;
      }
      if (cancelled) {
        return;
      }
      activeConfig = fetchedConfig;
      setConfig(fetchedConfig);

      if (openState.gateCompleted) {
        // Remount after the app-open sequence already ran: resume monitoring.
        scheduleNextHealthcheck();
        return;
      }

      setGate({ phase: "loading" });
      const branchOptions = await loadBranchOptions();
      if (cancelled) {
        return;
      }
      if (branchOptions === null || branchOptions.branches.length === 0) {
        // Not a git repo (or git unavailable): skip the gate entirely.
        openState.gateCompleted = true;
        setGate({ phase: "hidden" });
        await runOpenSequence(fetchedConfig, false);
        return;
      }

      currentBranch = branchOptions.currentBranch;
      setGate({
        phase: "select",
        branches: branchOptions.branches,
        currentBranch: branchOptions.currentBranch,
        busy: false,
      });
    };

    void start();

    return () => {
      cancelled = true;
      clearPendingTimeout();
      confirmBranchRef.current = () => undefined;
      restartSystemRef.current = () => undefined;
    };
  }, [enabled, environmentId, gitCwd]);

  const confirmBranch = useCallback((branchName: string | null) => {
    confirmBranchRef.current(branchName);
  }, []);

  const restartSystem = useCallback(() => {
    restartSystemRef.current();
  }, []);

  const canRestart =
    config !== null && (config.shutdownCommand !== null || config.startupCommand !== null);

  return {
    config,
    gate,
    confirmBranch,
    restartSystem: canRestart ? restartSystem : null,
  };
}
