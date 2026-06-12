import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Sandbox project configuration sourced from `t3codable.json` at the project
 * root. Preview URLs are returned with variables (e.g. `$tailscale_ip`)
 * already interpolated; script fields carry the raw commands to execute from
 * the project root.
 */
export const SandboxPreviewUrl = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type SandboxPreviewUrl = typeof SandboxPreviewUrl.Type;

export const SandboxConfig = Schema.Struct({
  previewUrls: Schema.Array(SandboxPreviewUrl),
  /**
   * Provider keys from `providers_to_configure` whose value is `true` —
   * these get signed in and enabled during the app-open sequence.
   */
  providersToConfigure: Schema.Array(TrimmedNonEmptyString),
  /** Runs once per app open, before the startup script. */
  setupCommand: Schema.NullOr(TrimmedNonEmptyString),
  startupCommand: Schema.NullOr(TrimmedNonEmptyString),
  shutdownCommand: Schema.NullOr(TrimmedNonEmptyString),
  healthcheckCommand: Schema.NullOr(TrimmedNonEmptyString),
});
export type SandboxConfig = typeof SandboxConfig.Type;

export const SandboxScriptStatus = Schema.Literals(["passed", "failed", "no-script"]);
export type SandboxScriptStatus = typeof SandboxScriptStatus.Type;

export const SandboxScriptResult = Schema.Struct({
  status: SandboxScriptStatus,
  exitCode: Schema.NullOr(Schema.Int),
});
export type SandboxScriptResult = typeof SandboxScriptResult.Type;

export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()("SandboxError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}
