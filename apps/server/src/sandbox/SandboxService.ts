import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type SandboxConfig, SandboxError, type SandboxScriptResult } from "@t3tools/contracts";
import { readTailscaleStatus } from "@t3tools/tailscale";

import { ServerConfig } from "../config.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../processRunner.ts";

export const SANDBOX_CONFIG_FILENAME = "t3codable.json";

const TAILSCALE_IP_VARIABLE = "$tailscale_ip";
const T3CODE_BASE_URL_VARIABLE = "$t3code_base_url";

const HEALTHCHECK_TIMEOUT = "25 seconds";
const SHUTDOWN_TIMEOUT = "60 seconds";

const RawSandboxPreviewUrl = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
});

const RawSandboxConfigFile = Schema.Struct({
  preview_urls: Schema.optional(Schema.Array(RawSandboxPreviewUrl)),
  providers_to_configure: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  setup_sandbox: Schema.optional(Schema.String),
  startup_script: Schema.optional(Schema.String),
  shutdown_script: Schema.optional(Schema.String),
  healthcheck_script: Schema.optional(Schema.String),
  pair_code: Schema.optional(Schema.String),
});
type RawSandboxConfigFile = typeof RawSandboxConfigFile.Type;

const isRawSandboxConfigFile = Schema.is(RawSandboxConfigFile);

const EMPTY_CONFIG: SandboxConfig = {
  previewUrls: [],
  providersToConfigure: [],
  setupCommand: null,
  startupCommand: null,
  shutdownCommand: null,
  healthcheckCommand: null,
};

const GIT_FETCH_COMMAND = "git fetch --all --prune";
const GIT_FETCH_TIMEOUT = "60 seconds";

function parseConfigFile(raw: string): RawSandboxConfigFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRawSandboxConfigFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(script: string | undefined): string | null {
  const trimmed = script?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads the static pairing code (`pair_code`) from the project's
 * `t3codable.json`, if present. Tolerant by design: a missing or invalid
 * config file yields `null` so server startup never fails on it.
 *
 * Deliberately NOT part of `SandboxConfig` / the `sandbox.getConfig` RPC —
 * the pair code is a credential and must not be served to clients.
 */
export const readSandboxPairCode = Effect.fn("readSandboxPairCode")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(cwd, SANDBOX_CONFIG_FILENAME);

  const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return null;
  }

  const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => null));
  if (raw === null) {
    return null;
  }

  const parsed = parseConfigFile(raw);
  if (parsed === null) {
    return null;
  }

  return normalizeNonEmptyString(parsed.pair_code);
});

/**
 * Replaces every `$tailscale_ip` occurrence in a preview URL. When no
 * tailscale ip could be resolved the URL is returned unchanged so the
 * variable stays visible to the user instead of producing a broken URL.
 */
export function interpolateTailscaleIp(url: string, tailscaleIp: string | null): string {
  if (tailscaleIp === null) {
    return url;
  }
  return url.replaceAll(TAILSCALE_IP_VARIABLE, tailscaleIp);
}

function normalizeT3CodeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

export function interpolateT3CodeBaseUrl(url: string, t3codeBaseUrl: string | null): string {
  if (t3codeBaseUrl === null) {
    return url;
  }
  return url.replaceAll(T3CODE_BASE_URL_VARIABLE, t3codeBaseUrl);
}

export interface SandboxServiceShape {
  readonly getConfig: Effect.Effect<SandboxConfig, SandboxError>;
  readonly gitFetch: Effect.Effect<SandboxScriptResult, SandboxError>;
  readonly runHealthcheck: Effect.Effect<SandboxScriptResult, SandboxError>;
  readonly runShutdown: Effect.Effect<SandboxScriptResult, SandboxError>;
}

export class SandboxService extends Context.Service<SandboxService, SandboxServiceShape>()(
  "t3/sandbox/SandboxService",
) {}

export const make = Effect.fn("makeSandboxService")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;
  const serverConfig = yield* ServerConfig;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cachedTailscaleIp = yield* Ref.make<Option.Option<string>>(Option.none());
  const t3codeBaseUrl = normalizeT3CodeBaseUrl(process.env.T3CODE_BASE_URL);

  const configPath = path.join(serverConfig.cwd, SANDBOX_CONFIG_FILENAME);

  const resolveTailscaleIp = Effect.gen(function* () {
    const cached = yield* Ref.get(cachedTailscaleIp);
    if (Option.isSome(cached)) {
      return cached.value;
    }

    const ip = yield* readTailscaleStatus.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.map((status) => status.tailnetIpv4Addresses[0] ?? null),
      Effect.catch((cause) =>
        Effect.logWarning("failed to resolve tailscale ip for sandbox preview urls", {
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (ip !== null) {
      yield* Ref.set(cachedTailscaleIp, Option.some(ip));
    }
    return ip;
  });

  const interpolateUrl = Effect.fn("SandboxService.interpolateUrl")(function* (url: string) {
    let interpolated = url;
    if (interpolated.includes(TAILSCALE_IP_VARIABLE)) {
      interpolated = interpolateTailscaleIp(interpolated, yield* resolveTailscaleIp);
    }
    if (interpolated.includes(T3CODE_BASE_URL_VARIABLE)) {
      interpolated = interpolateT3CodeBaseUrl(interpolated, t3codeBaseUrl);
    }
    return interpolated;
  });

  const getConfig: SandboxServiceShape["getConfig"] = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return EMPTY_CONFIG;
    }

    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new SandboxError({
            message: `Failed to read sandbox config at ${configPath}.`,
            cause,
          }),
      ),
    );

    const parsed = parseConfigFile(raw);
    if (parsed === null) {
      yield* Effect.logWarning("invalid sandbox config file", { configPath });
      return EMPTY_CONFIG;
    }

    const previewUrls: Array<{ name: string; url: string }> = [];
    for (const previewUrl of parsed.preview_urls ?? []) {
      const name = previewUrl.name.trim();
      const url = previewUrl.url.trim();
      if (name.length === 0 || url.length === 0) {
        continue;
      }
      previewUrls.push({ name, url: yield* interpolateUrl(url) });
    }

    const providersToConfigure = Object.entries(parsed.providers_to_configure ?? {})
      .filter(([provider, configure]) => configure && provider.trim().length > 0)
      .map(([provider]) => provider.trim());

    return {
      previewUrls,
      providersToConfigure,
      setupCommand: normalizeNonEmptyString(parsed.setup_sandbox),
      startupCommand: normalizeNonEmptyString(parsed.startup_script),
      shutdownCommand: normalizeNonEmptyString(parsed.shutdown_script),
      healthcheckCommand: normalizeNonEmptyString(parsed.healthcheck_script),
    } satisfies SandboxConfig;
  }).pipe(Effect.withSpan("SandboxService.getConfig"));

  const runScript = Effect.fn("SandboxService.runScript")(function* (input: {
    readonly command: string | null;
    readonly label: string;
    readonly timeout: Duration.Input;
  }) {
    if (input.command === null) {
      return { status: "no-script", exitCode: null } satisfies SandboxScriptResult;
    }

    const output = yield* processRunner
      .run({
        command: input.command,
        args: [],
        cwd: serverConfig.cwd,
        shell: true,
        timeout: input.timeout,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SandboxError({
              message: `Failed to run sandbox ${input.label} script.`,
              cause,
            }),
        ),
      );

    if (output.timedOut) {
      yield* Effect.logWarning(`sandbox ${input.label} script timed out`, {
        command: input.command,
      });
      return { status: "failed", exitCode: null } satisfies SandboxScriptResult;
    }

    const exitCode = output.code === null ? null : Number(output.code);
    return {
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
    } satisfies SandboxScriptResult;
  });

  const gitFetch: SandboxServiceShape["gitFetch"] = runScript({
    command: GIT_FETCH_COMMAND,
    label: "git-fetch",
    timeout: GIT_FETCH_TIMEOUT,
  });

  const runHealthcheck: SandboxServiceShape["runHealthcheck"] = getConfig.pipe(
    Effect.flatMap((config) =>
      runScript({
        command: config.healthcheckCommand,
        label: "healthcheck",
        timeout: HEALTHCHECK_TIMEOUT,
      }),
    ),
  );

  const runShutdown: SandboxServiceShape["runShutdown"] = getConfig.pipe(
    Effect.flatMap((config) =>
      runScript({
        command: config.shutdownCommand,
        label: "shutdown",
        timeout: SHUTDOWN_TIMEOUT,
      }),
    ),
  );

  return SandboxService.of({
    getConfig,
    gitFetch,
    runHealthcheck,
    runShutdown,
  });
});

export const layer = Layer.effect(SandboxService, make()).pipe(Layer.provide(ProcessRunnerLive));

/**
 * Runs the sandbox shutdown script when the server scope closes (process
 * shutdown). Best-effort: failures are logged, never propagated.
 */
export const SandboxShutdownOnExitLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sandbox = yield* SandboxService;
    yield* Effect.addFinalizer(() =>
      sandbox.runShutdown.pipe(
        Effect.tap((result) =>
          result.status === "no-script"
            ? Effect.void
            : Effect.logInfo("sandbox shutdown script finished", { status: result.status }),
        ),
        Effect.ignore({ log: true }),
      ),
    );
  }),
);
