import { defineComponent } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DockerPrerequisitesPanel from "./DockerPrerequisitesPanel.vue";

const ButtonStub = defineComponent({
  props: { loading: Boolean },
  emits: ["click"],
  template: '<button :disabled="loading" @click="$emit(\'click\')"><slot /></button>',
});

const readyState = { status: "ready", reason: "ready" } as const;
const result: DockerPrerequisites = {
  checkedAt: "2026-08-10T00:00:00.000Z",
  ready: false,
  reasons: ["docker-daemon-unavailable"],
  windows: readyState,
  wslCommand: readyState,
  wsl2: readyState,
  dockerCli: readyState,
  dockerDaemon: { status: "not-ready", reason: "docker-daemon-unavailable" },
  linuxContainers: { status: "not-ready", reason: "docker-daemon-unavailable" },
};

describe("DockerPrerequisitesPanel", () => {
  const check = vi.fn();
  const openExternal = vi.fn();

  beforeEach(() => {
    check.mockReset().mockResolvedValue(result);
    openExternal.mockReset().mockResolvedValue(undefined);
    window.openclaw = {
      dockerPrerequisites: { check },
      shell: { openExternal },
    } as unknown as OpenClawAPI;
  });

  it("checks on mount and renders independent prerequisite states", async () => {
    const wrapper = mount(DockerPrerequisitesPanel, {
      global: { stubs: { "el-button": ButtonStub } },
    });
    await flushPromises();
    expect(check).toHaveBeenCalledOnce();
    expect(wrapper.findAll(".docker-check")).toHaveLength(6);
    expect(wrapper.text()).toContain("Docker daemon is not responding");
    expect(wrapper.text()).toContain("AppContainer");
  });

  it("only opens official guidance links after a user click", async () => {
    const wrapper = mount(DockerPrerequisitesPanel, {
      global: { stubs: { "el-button": ButtonStub } },
    });
    await flushPromises();
    expect(openExternal).not.toHaveBeenCalled();
    await wrapper.get('[data-test="wsl-docs"]').trigger("click");
    await wrapper.get('[data-test="docker-docs"]').trigger("click");
    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      "https://learn.microsoft.com/windows/wsl/install",
    );
    expect(openExternal).toHaveBeenNthCalledWith(
      2,
      "https://docs.docker.com/desktop/setup/install/windows-install/",
    );
  });

  it("rechecks without claiming that opening a link installed anything", async () => {
    const wrapper = mount(DockerPrerequisitesPanel, {
      global: { stubs: { "el-button": ButtonStub } },
    });
    await flushPromises();
    await wrapper.get('[data-test="docker-refresh"]').trigger("click");
    await flushPromises();
    expect(check).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("Docker daemon is not responding");
  });
});
