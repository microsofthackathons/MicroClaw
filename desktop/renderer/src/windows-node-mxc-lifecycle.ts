import type { InjectionKey, Ref } from "vue";

export type WindowsNodeMxcLifecycleState = Awaited<
  ReturnType<OpenClawAPI["windowsNodeMxc"]["getStatus"]>
>["lifecycleState"];

export const windowsNodeMxcLifecycleStateKey: InjectionKey<
  Readonly<Ref<WindowsNodeMxcLifecycleState | null>>
> = Symbol("windows-node-mxc-lifecycle");
