import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import type { SessionModelRecovery } from "../../../src/session-model-types";
import SessionModelRecoveryNotice from "./SessionModelRecoveryNotice.vue";

let active: SessionModelRecovery | null;
let changed: () => void;
const unsubscribe = vi.fn();
const wrappers: Array<ReturnType<typeof mount>> = [];
beforeEach(() => {
  setLocale("en-US");
  active = { id: "uncertain", requiresRestart: true, recovering: false, canRecover: true };
  const api = createBrowserOpenClawMock();
  api.model.session.getRecovery = vi.fn(async () => active);
  api.model.session.onRecoveryChanged = vi.fn((callback) => {
    changed = callback;
    return unsubscribe;
  });
  api.model.session.recover = vi.fn(async () => {
    active = null;
    changed();
  });
  api.model.session.select = vi.fn();
  api.config.write = vi.fn();
  api.gateway.restart = vi.fn();
  window.openclaw = api;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
});
async function open() {
  const wrapper = mount(SessionModelRecoveryNotice);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("session model recovery notice", () => {
  it("requires confirmation for a Gateway restart and never retries a model write", async () => {
    const confirm = vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const wrapper = await open();
    expect(wrapper.text()).toContain("does not retry or roll back");
    await wrapper.get('[data-testid="recover-session-model"]').trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.openclaw.model.session.recover).toHaveBeenCalledExactlyOnceWith({
      recoveryId: "uncertain",
      confirmed: true,
      restart: true,
    });
    expect(wrapper.emitted("recovered")).toHaveLength(1);
    expect(wrapper.find('[data-testid="session-model-recovery"]').exists()).toBe(false);
    expect(window.openclaw.model.session.select).not.toHaveBeenCalled();
    expect(window.openclaw.config.write).not.toHaveBeenCalled();
    expect(window.openclaw.gateway.restart).not.toHaveBeenCalled();
  });

  it("does not restart or recover when the user declines", async () => {
    vi.spyOn(ElMessageBox, "confirm").mockRejectedValue("cancel");
    const wrapper = await open();
    await wrapper.get('[data-testid="recover-session-model"]').trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.recover).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted("busy")?.at(-1)).toEqual([false]);
  });

  it("confirms settled saved state without displaying a restart confirmation", async () => {
    active!.requiresRestart = false;
    const confirm = vi.spyOn(ElMessageBox, "confirm");
    const wrapper = await open();
    expect(wrapper.get("button").text()).toBe("Confirm saved state and recover");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(confirm).not.toHaveBeenCalled();
    expect(window.openclaw.model.session.recover).toHaveBeenCalledExactlyOnceWith({
      recoveryId: "uncertain",
      confirmed: true,
      restart: false,
    });
  });

  it("prevents duplicate recovery while confirmation is pending", async () => {
    let confirm!: () => void;
    vi.spyOn(ElMessageBox, "confirm").mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = () => resolve("confirm" as never);
        }),
    );
    const wrapper = await open();
    const button = wrapper.get("button");
    await button.trigger("click");
    expect(button.attributes("disabled")).toBeDefined();
    await button.trigger("click");
    expect(window.openclaw.model.session.recover).not.toHaveBeenCalled();
    confirm();
    await flushPromises();
    expect(window.openclaw.model.session.recover).toHaveBeenCalledOnce();
  });

  it.each(["changed", "unmounted"])("does not act on a %s confirmation", async (reason) => {
    let confirm!: () => void;
    vi.spyOn(ElMessageBox, "confirm").mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = () => resolve("confirm" as never);
        }),
    );
    const wrapper = await open();
    await wrapper.get("button").trigger("click");
    if (reason === "changed") {
      active = { ...active!, id: "new-uncertain-operation" };
      changed();
      await flushPromises();
    } else wrapper.unmount();
    confirm();
    await flushPromises();
    expect(window.openclaw.model.session.recover).not.toHaveBeenCalled();
    if (reason === "changed") expect(wrapper.get('[role="alert"]').text()).toContain("has changed");
  });

  it("keeps failure visible and uses read-only recovery if the Gateway has already restarted", async () => {
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    vi.mocked(window.openclaw.model.session.recover).mockImplementationOnce(async () => {
      active = { ...active!, requiresRestart: false };
      changed();
      throw new Error("Saved state is temporarily unreadable");
    });
    const wrapper = await open();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("temporarily unreadable");
    expect(wrapper.get("button").text()).toBe("Confirm saved state and recover");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(window.openclaw.model.session.recover).toHaveBeenLastCalledWith({
      recoveryId: "uncertain",
      confirmed: true,
      restart: false,
    });
    expect(wrapper.emitted("recovered")).toHaveLength(1);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it("shows blocked reasons and follows recovery completed elsewhere", async () => {
    active = { ...active!, canRecover: false, blockedReason: "Chat is still active" };
    const wrapper = await open();
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Chat is still active");
    active = { ...active!, recovering: true };
    changed();
    await flushPromises();
    expect(wrapper.emitted("busy")?.at(-1)).toEqual([true]);
    active = null;
    changed();
    await flushPromises();
    expect(wrapper.emitted("recovered")).toHaveLength(1);
    expect(wrapper.emitted("busy")?.at(-1)).toEqual([false]);
  });
});
