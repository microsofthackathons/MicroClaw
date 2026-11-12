import {
  shouldStopManagedGatewayForWindowsNodeMxc,
  type WindowsNodeMxcRuntimeStatus,
} from "./windows-node-mxc-service";
import { MxcStatusContextChangedError } from "./windows-node-mxc-status-cache";

type HealthStatus = Pick<
  WindowsNodeMxcRuntimeStatus,
  "effectiveEnabled" | "gatewayPolicyState" | "blockers"
>;

interface HealthCheckHooks {
  isCurrent(): boolean;
  inspect(): Promise<HealthStatus>;
  renewLease(): Promise<unknown>;
  failClosed(reason: string): Promise<void>;
}

const MAX_STALE_INSPECTION_RETRIES = 2;

/** Returns false when the tick failed closed or was superseded by a lifecycle transition. */
export async function checkWindowsNodeMxcHealth(hooks: HealthCheckHooks): Promise<boolean> {
  if (!hooks.isCurrent()) return false;
  let status: HealthStatus;
  for (let attempt = 0; ; attempt += 1) {
    try {
      status = await hooks.inspect();
      break;
    } catch (error) {
      if (!hooks.isCurrent()) return false;
      if (error instanceof MxcStatusContextChangedError) {
        if (attempt < MAX_STALE_INSPECTION_RETRIES) continue;
        await hooks.failClosed(
          "Health attestation remained unstable after refreshing the current MXC state",
        );
        return false;
      }
      await hooks.failClosed(
        `Health attestation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
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
