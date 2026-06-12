import type { EnvironmentId, SandboxConfig } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readEnvironmentApi } from "~/environmentApi";

const HEALTHCHECK_INTERVAL_MS = 30_000;
const HEALTHCHECK_RETRY_DELAY_MS = 5_000;
const HEALTHCHECK_RETRY_ATTEMPTS = 5;

/**
 * The initial "is the sandbox up?" check (and the startup script it may
 * trigger) must run once per environment per page load, not once per
 * ChatView mount.
 */
const initialHealthcheckStartedEnvironments = new Set<EnvironmentId>();

export interface SandboxRuntime {
  readonly config: SandboxConfig | null;
}

/**
 * Drives the sandbox lifecycle defined by the project's `t3codable.json`:
 *
 * - On startup, runs the healthcheck script in the background; when it fails,
 *   the startup script is launched in the visible bottom terminal.
 * - Re-runs the healthcheck every 30s. A failure is retried 5 times at 5s
 *   intervals; if all retries fail, an error toast offers a full
 *   shutdown-and-restart of the system.
 */
export function useSandboxRuntime(input: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
  onRunStartupScript: (command: string) => void;
}): SandboxRuntime {
  const { environmentId, enabled } = input;
  const [config, setConfig] = useState<SandboxConfig | null>(null);
  const onRunStartupScriptRef = useRef(input.onRunStartupScript);
  onRunStartupScriptRef.current = input.onRunStartupScript;

  useEffect(() => {
    if (!enabled || !environmentId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    let cancelled = false;
    let pendingTimeoutId: number | null = null;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        pendingTimeoutId = window.setTimeout(resolve, ms);
      });

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

    const restartSystem = async (startupCommand: string | null) => {
      try {
        await api.sandbox.runShutdown();
      } catch {
        // Best effort: still attempt to start back up.
      }
      if (cancelled) {
        return;
      }
      if (startupCommand !== null) {
        onRunStartupScriptRef.current(startupCommand);
      }
      scheduleNextHealthcheck();
    };

    const showHealthcheckFailedToast = (startupCommand: string | null) => {
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
              void restartSystem(startupCommand);
            },
          },
        }),
      );
    };

    const scheduleNextHealthcheck = () => {
      if (cancelled) {
        return;
      }
      pendingTimeoutId = window.setTimeout(() => {
        void monitorTick();
      }, HEALTHCHECK_INTERVAL_MS);
    };

    let activeConfig: SandboxConfig | null = null;

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
      showHealthcheckFailedToast(activeConfig?.startupCommand ?? null);
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

      if (fetchedConfig.healthcheckCommand === null) {
        return;
      }

      if (!initialHealthcheckStartedEnvironments.has(environmentId)) {
        initialHealthcheckStartedEnvironments.add(environmentId);
        const healthy = await runHealthcheck();
        if (cancelled) {
          return;
        }
        if (healthy === false && fetchedConfig.startupCommand !== null) {
          onRunStartupScriptRef.current(fetchedConfig.startupCommand);
        }
      }

      scheduleNextHealthcheck();
    };

    void start();

    return () => {
      cancelled = true;
      if (pendingTimeoutId !== null) {
        window.clearTimeout(pendingTimeoutId);
      }
    };
  }, [enabled, environmentId]);

  return { config };
}
