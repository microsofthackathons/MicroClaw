import {
  shouldStopManagedGatewayForWindowsNodeMxc,
  type WindowsNodeMxcRuntimeStatus,
} from "./windows-node-mxc-service";

type HealthStatus = Pick<
  WindowsNodeMxcRuntimeStatus,
  "effectiveEnabled" | "effectiveToolsState" | "gatewayPolicyState" | "blockers"
>;

interface HealthCheckHooks {
  isCurrent(): boolean;
  inspect(): Promise<HealthStatus>;
  renewLease(): Promise<unknown>;
  failClosed(reason: string): Promise<void>;
}

/** Returns false when the tick failed closed or was superseded by a lifecycle transition. */
export async function checkWindowsNodeMxcHealth(hooks: HealthCheckHooks): Promise<boolean> {
  if (!hooks.isCurrent()) return false;
  let status: HealthStatus;
  try {
    status = await hooks.inspect();
  } catch (error) {
    if (!hooks.isCurrent()) return false;
    await hooks.failClosed(
      `Health attestation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  if (!hooks.isCurrent()) return false;
  if (shouldStopManagedGatewayForWindowsNodeMxc(status)) {
    await hooks.failClosed(
      `Readiness drifted: ${status.blockers.join("; ") || "unknown readiness failure"}`,
    );
    return false;
  }
  if (status.effectiveEnabled) {
    try {
      await hooks.renewLease();
    } catch (error) {
      if (!hooks.isCurrent()) return false;
      await hooks.failClosed(
        `Activation lease renewal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  return hooks.isCurrent();
}
