import type { InjectionKey, Ref } from "vue";

export type WindowsNodeMxcLifecycleState = Awaited<
  ReturnType<OpenClawAPI["windowsNodeMxc"]["getStatus"]>
>["lifecycleState"];

export const windowsNodeMxcModeTransitionPhases = new Set<WindowsNodeMxcLifecycleState["phase"]>([
  "locking",
  "disabling",
  "validating",
  "persisting",
  "starting-locked",
  "smoking-locked",
  "starting-active",
  "smoking-active",
  "promoting-active",
  "verifying-active",
  "starting-standard",
]);

export const windowsNodeMxcIngressLockedPhases = new Set<WindowsNodeMxcLifecycleState["phase"]>([
  ...windowsNodeMxcModeTransitionPhases,
  "updating-folders",
  "updating-consent",
  "updating-model",
  "connecting-weixin",
  "disconnecting-weixin",
  "failed",
  "locked",
]);

export function isWindowsNodeMxcExecutionBlocked(state: WindowsNodeMxcLifecycleState | null) {
  return !!state && windowsNodeMxcIngressLockedPhases.has(state.phase);
}

export const windowsNodeMxcLifecycleStateKey: InjectionKey<
  Readonly<Ref<WindowsNodeMxcLifecycleState | null>>
> = Symbol("windows-node-mxc-lifecycle");
