import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import {
  SANDBOX_CONFIG_FILENAME,
  SandboxService,
  interpolateTailscaleIp,
  layer as SandboxServiceLive,
  readSandboxPairCode,
} from "./SandboxService.ts";

const makeTestLayer = (cwd: string) =>
  SandboxServiceLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-sandbox-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const withProjectDir = <A, E>(
  body: (cwd: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-sandbox-project-" })
      .pipe(Effect.orDie);
    return yield* body(cwd);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writeSandboxConfig = (cwd: string, config: unknown) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem
      .writeFileString(
        path.join(cwd, SANDBOX_CONFIG_FILENAME),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        typeof config === "string" ? config : JSON.stringify(config),
      )
      .pipe(Effect.orDie);
  });

describe("interpolateTailscaleIp", () => {
  it("replaces every occurrence of $tailscale_ip", () => {
    expect(interpolateTailscaleIp("http://$tailscale_ip:3000/$tailscale_ip", "100.64.0.7")).toBe(
      "http://100.64.0.7:3000/100.64.0.7",
    );
  });

  it("leaves the url unchanged when no ip is available", () => {
    expect(interpolateTailscaleIp("http://$tailscale_ip:3000", null)).toBe(
      "http://$tailscale_ip:3000",
    );
  });
});

describe("readSandboxPairCode", () => {
  it.effect("returns the trimmed pair code from t3codable.json", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        yield* writeSandboxConfig(cwd, { pair_code: " MY-STATIC-CODE " });
        const pairCode = yield* readSandboxPairCode(cwd);
        expect(pairCode).toBe("MY-STATIC-CODE");
      }),
    ),
  );

  it.effect("returns null when the config or pair code is absent", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        expect(yield* readSandboxPairCode(cwd)).toBeNull();
        yield* writeSandboxConfig(cwd, { startup_script: "make dev" });
        expect(yield* readSandboxPairCode(cwd)).toBeNull();
      }),
    ),
  );
});

describe("SandboxService", () => {
  it.effect("returns an empty config when t3codable.json is missing", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        const sandbox = yield* SandboxService;
        const config = yield* sandbox.getConfig;
        expect(config).toEqual({
          previewUrls: [],
          startupCommand: null,
          shutdownCommand: null,
          healthcheckCommand: null,
        });
      }).pipe(Effect.provide(makeTestLayer(cwd))),
    ),
  );

  it.effect("returns an empty config when t3codable.json is invalid JSON", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        yield* writeSandboxConfig(cwd, "{not json");
        const sandbox = yield* SandboxService.pipe(Effect.provide(makeTestLayer(cwd)));
        const config = yield* sandbox.getConfig;
        expect(config.previewUrls).toEqual([]);
        expect(config.healthcheckCommand).toBeNull();
      }),
    ),
  );

  it.effect("parses preview urls and scripts from t3codable.json", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        yield* writeSandboxConfig(cwd, {
          preview_urls: [
            { name: "app", url: "http://localhost:3000" },
            { name: "", url: "http://ignored.example" },
          ],
          startup_script: " ./start.sh ",
          shutdown_script: "./stop.sh",
          healthcheck_script: "./health.sh",
        });

        const sandbox = yield* SandboxService.pipe(Effect.provide(makeTestLayer(cwd)));
        const config = yield* sandbox.getConfig;
        expect(config.previewUrls).toEqual([{ name: "app", url: "http://localhost:3000" }]);
        expect(config.startupCommand).toBe("./start.sh");
        expect(config.shutdownCommand).toBe("./stop.sh");
        expect(config.healthcheckCommand).toBe("./health.sh");
      }),
    ),
  );

  it.effect("reports no-script when no healthcheck script is configured", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        const sandbox = yield* SandboxService.pipe(Effect.provide(makeTestLayer(cwd)));
        const result = yield* sandbox.runHealthcheck;
        expect(result).toEqual({ status: "no-script", exitCode: null });
      }),
    ),
  );

  it.effect("runs the healthcheck script and reports pass/fail", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        const sandbox = yield* SandboxService.pipe(Effect.provide(makeTestLayer(cwd)));

        yield* writeSandboxConfig(cwd, { healthcheck_script: "exit 0" });
        const passed = yield* sandbox.runHealthcheck;
        expect(passed.status).toBe("passed");
        expect(passed.exitCode).toBe(0);

        yield* writeSandboxConfig(cwd, { healthcheck_script: "exit 7" });
        const failed = yield* sandbox.runHealthcheck;
        expect(failed.status).toBe("failed");
        expect(failed.exitCode).toBe(7);
      }),
    ),
  );

  it.effect("runs the shutdown script from the project root", () =>
    withProjectDir((cwd) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeSandboxConfig(cwd, { shutdown_script: "touch shutdown-ran" });

        const sandbox = yield* SandboxService.pipe(Effect.provide(makeTestLayer(cwd)));
        const result = yield* sandbox.runShutdown;
        expect(result.status).toBe("passed");

        const markerExists = yield* fileSystem
          .exists(path.join(cwd, "shutdown-ran"))
          .pipe(Effect.orDie);
        expect(markerExists).toBe(true);
      }),
    ),
  );
});
