export interface GatewayStatusTransition {
  resetReadiness: boolean;
  refreshPort: boolean;
}

export function planGatewayStatusTransition(
  previousStatus: string,
  nextStatus: string,
): GatewayStatusTransition {
  return {
    resetReadiness: nextStatus === "restarting" && previousStatus !== "restarting",
    refreshPort: nextStatus === "running",
  };
}
