export type GatewayRestartReason =
  | "startup-retry"
  | "settings-manual"
  | "plugins-manual"
  | "copilot-plugin-activation";

export interface GatewayRestartOptions {
  hard?: boolean;
  reason?: GatewayRestartReason;
}

const reasons: Record<GatewayRestartReason, string> = {
  "startup-retry": "Retry requested from the startup error screen",
  "settings-manual": "Manual restart requested from Settings",
  "plugins-manual": "Manual restart requested from Plugins",
  "copilot-plugin-activation":
    "Restart required while activating the GitHub Copilot provider plugin",
};

export function resolveGatewayRestartReason(options: unknown): string {
  if (options === undefined) return "Renderer requested restart (reason unspecified)";
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("Invalid Gateway restart options");
  const reason = (options as GatewayRestartOptions).reason;
  if (reason === undefined) return "Renderer requested restart (reason unspecified)";
  if (typeof reason !== "string" || !Object.hasOwn(reasons, reason))
    throw new Error("Unknown Gateway restart reason");
  return reasons[reason];
}
