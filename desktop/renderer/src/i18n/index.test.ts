import { describe, it, expect } from "vitest";
import { t, setLocale, getLocale } from "./index";

describe("i18n", () => {
  it("defaults to en-US locale", () => {
    expect(getLocale()).toBe("en-US");
  });

  it("setLocale changes the active locale", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    setLocale("en-US"); // restore
  });

  it("translates known keys in en-US", () => {
    setLocale("en-US");
    expect(t("chat.send")).toBe("Send");
  });

  it("translates known keys in zh-CN", () => {
    setLocale("zh-CN");
    const result = t("chat.send");
    expect(result).toBe("发送");
    setLocale("en-US"); // restore
  });

  it("returns key name for unknown keys", () => {
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("discloses that Gateway filesystem tools run outside MXC in both locales", () => {
    setLocale("en-US");
    expect(t("settings.windowsNodeMxcConsent.item.gateway-native-filesystem")).toContain(
      "not sandboxed by MXC",
    );
    setLocale("zh-CN");
    expect(t("settings.windowsNodeMxcConsent.item.gateway-native-filesystem")).toContain(
      "不受 MXC 沙箱保护",
    );
    setLocale("en-US");
  });

  it("attributes the chat disclaimer to MicroClaw in both locales", () => {
    for (const locale of ["en-US", "zh-CN"] as const) {
      setLocale(locale);
      expect(t("chat.disclaimer")).toContain("MicroClaw");
      expect(t("chat.disclaimer")).not.toContain("Microsoft");
    }
    setLocale("en-US");
  });

  it("interpolates params", () => {
    setLocale("en-US");
    const result = t("integrity.updateFailed", { error: "disk full" });
    expect(result).toContain("disk full");
  });

  it("store.newChat key exists in both locales", () => {
    setLocale("en-US");
    expect(t("store.newChat")).toBe("New Chat");
    setLocale("zh-CN");
    expect(t("store.newChat")).toBe("新对话");
    setLocale("en-US"); // restore
  });

  it("store.defaultAgent key exists in both locales", () => {
    setLocale("en-US");
    expect(t("store.defaultAgent")).toBe("MicroClaw");
    setLocale("zh-CN");
    expect(t("store.defaultAgent")).toBe("阿虾");
    setLocale("en-US"); // restore
  });

  it("Code Geek catalog keys exist in both locales", () => {
    setLocale("en-US");
    expect(t("agent.codeGeek.name")).toBe("Code Geek");
    setLocale("zh-CN");
    expect(t("agent.codeGeek.name")).toBe("灵码极客");
    setLocale("en-US"); // restore
  });

  it("Intel Analyst catalog keys exist in both locales", () => {
    setLocale("en-US");
    expect(t("agent.intelAnalyst.name")).toBe("Intel Analyst");
    setLocale("zh-CN");
    expect(t("agent.intelAnalyst.name")).toBe("前哨智囊");
    setLocale("en-US"); // restore
  });

  it("Market Sentinel catalog keys exist in both locales", () => {
    setLocale("en-US");
    expect(t("agent.marketSentinel.name")).toBe("Market Sentinel");
    setLocale("zh-CN");
    expect(t("agent.marketSentinel.name")).toBe("财经哨兵");
    setLocale("en-US"); // restore
  });

  it("Office Artisan catalog keys exist in both locales", () => {
    setLocale("en-US");
    expect(t("agent.officeArtisan.name")).toBe("Office Artisan");
    setLocale("zh-CN");
    expect(t("agent.officeArtisan.name")).toBe("办公巧匠");
    setLocale("en-US"); // restore
  });

  it("Creative Muse catalog keys exist in both locales", () => {
    setLocale("en-US");
    expect(t("agent.creativeMuse.name")).toBe("Creative Muse");
    setLocale("zh-CN");
    expect(t("agent.creativeMuse.name")).toBe("灵感创客");
    setLocale("en-US"); // restore
  });

  it("localizes Agent Team and Agent Catalog navigation in zh-CN", () => {
    setLocale("zh-CN");
    expect(t("sidebar.agents")).toBe("智能体团队");
    expect(t("agentCatalog.pageTitle")).toBe("智能体目录");
    expect(t("agentCatalog.marketplace")).toBe("智能体市场");
    expect(t("agentCatalog.customAgents")).toBe("自定义智能体");
    setLocale("en-US");
  });

  it("localizes MXC-contained approval wording without outside-sandbox language", () => {
    setLocale("en-US");
    expect(t("perm.mxcDesc")).toBe("AI wants to run this command inside the MXC sandbox.");
    expect(t("perm.mxcAccessLabel")).toBe("Declared folder use");
    expect(t("perm.mxcAccessRw")).toBe("Read and write");
    expect(t("perm.mxcScopeOnce")).toContain("approval does not grant or change folder access");
    expect(t("perm.mxcScopeOnce")).not.toContain("requested");
    expect(t("perm.mxcDesc")).not.toContain("outside");

    setLocale("zh-CN");
    expect(t("perm.mxcDesc")).toBe("AI 助手想在 MXC 沙箱内运行此命令。");
    expect(t("perm.mxcAccessLabel")).toBe("声明的文件夹用途");
    expect(t("perm.mxcAccessRw")).toBe("读写");
    expect(t("perm.mxcScopeOnce")).toContain("批准不会授予或更改文件夹访问权限");
    expect(t("perm.mxcDesc")).not.toContain("沙箱外");
    setLocale("en-US");
  });

  it("localizes the global MXC folder policy and remediation", () => {
    setLocale("en-US");
    expect(
      t("settings.windowsNodeMxcCompactStatus", {
        mode: t("settings.windowsNodeMxcModeFull"),
        state: t("settings.windowsNodeMxcStatusActive"),
      }),
    ).toBe("Full containment — Active");
    expect(t("settings.windowsNodeMxcLearnMore")).toBe("Learn more about sandboxing");
    expect(t("settings.windowsNodeMxcProtected")).toBe("Protected");
    expect(t("settings.windowsNodeMxcStarting")).toBe("Starting");
    expect(t("settings.windowsNodeMxcStopping")).toBe("Turning MXC off");
    expect(t("settings.windowsNodeMxcOffDisclosure")).toBe(
      "MXC is off. Tools run without MXC isolation.",
    );
    expect(t("settings.windowsNodeMxcAvailabilityOnEnable")).toBe(
      "Sandbox availability is checked when you turn it on.",
    );
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("Action required");
    expect(t("settings.windowsNodeMxcFolders")).toBe("Global MXC approved folders");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("global capability ceiling");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("never grant access");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("not security boundaries");
    for (const key of [
      "settings.windowsNodeMxcFoldersHint",
      "settings.windowsNodeMxcConfiguredFoldersHint",
    ]) {
      expect(t(key)).toContain("OpenClawWorkspaces");
      expect(t(key)).toContain("for all agents");
    }
    expect(t("settings.windowsNodeMxcModeFull")).toBe("Full containment");
    expect(t("settings.windowsNodeMxcOffWarning")).toContain("No execution sandbox");
    expect(t("settings.windowsNodeMxcFullFolders")).toBe("Full hard-boundary approved folders");

    setLocale("zh-CN");
    expect(
      t("settings.windowsNodeMxcCompactStatus", {
        mode: t("settings.windowsNodeMxcModeFull"),
        state: t("settings.windowsNodeMxcStatusActive"),
      }),
    ).toBe("完整隔离 — 已启用");
    expect(t("settings.windowsNodeMxcLearnMore")).toBe("了解有关沙盒隔离的更多信息");
    expect(t("settings.windowsNodeMxcProtected")).toBe("已保护");
    expect(t("settings.windowsNodeMxcStarting")).toBe("正在启动");
    expect(t("settings.windowsNodeMxcStopping")).toBe("正在关闭 MXC");
    expect(t("settings.windowsNodeMxcOffDisclosure")).toBe(
      "MXC 已关闭。工具运行时不受 MXC 隔离保护。",
    );
    expect(t("settings.windowsNodeMxcAvailabilityOnEnable")).toBe("开启沙箱时会检查其可用性。");
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("需要操作");
    expect(t("settings.windowsNodeMxcFolders")).toBe("MXC 全局批准文件夹");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("全局能力上限");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("绝不会授予访问权限");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("不构成安全边界");
    for (const key of [
      "settings.windowsNodeMxcFoldersHint",
      "settings.windowsNodeMxcConfiguredFoldersHint",
    ]) {
      expect(t(key)).toContain("OpenClawWorkspaces");
      expect(t(key)).toContain("所有代理");
    }
    expect(t("settings.windowsNodeMxcModeFull")).toBe("完整隔离");
    expect(t("settings.windowsNodeMxcOffWarning")).toContain("无执行沙箱");
    expect(t("settings.windowsNodeMxcFullFolders")).toBe("完整强边界批准文件夹");
    setLocale("en-US");
  });

  it("localizes remembered command approval", () => {
    setLocale("en-US");
    expect(t("perm.mxcAllowAlways")).toBe("Remember for this agent");

    setLocale("zh-CN");
    expect(t("perm.mxcAllowAlways")).toBe("为此智能体记住");
    setLocale("en-US");
  });

  it("localizes the complete MXC capability consent in English and Chinese", () => {
    setLocale("en-US");
    expect(
      t("settings.windowsNodeMxcConsent.title", {
        mode: t("settings.windowsNodeMxcModeFull"),
      }),
    ).toBe("Enable Full containment?");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.contained")).toContain(
      "Only Windows Node command execution",
    );
    expect(t("settings.windowsNodeMxcConsent.groupSummary.outside-mxc")).toContain(
      "remain enabled",
    );
    expect(t("settings.windowsNodeMxcConsent.fullNote")).toContain("exclusive filesystem boundary");
    expect(t("settings.windowsNodeMxcSandboxing")).toBe("Sandboxing");
    expect(t("common.cancel")).toBe("Cancel");

    setLocale("zh-CN");
    expect(
      t("settings.windowsNodeMxcConsent.title", {
        mode: t("settings.windowsNodeMxcModeFull"),
      }),
    ).toBe("启用完整隔离？");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.contained")).toContain(
      "只有 Windows Node 命令执行",
    );
    expect(t("settings.windowsNodeMxcConsent.groupSummary.outside-mxc")).toContain("仍保持启用");
    expect(t("settings.windowsNodeMxcConsent.fullNote")).toContain("后端预检");
    expect(t("settings.windowsNodeMxcSandboxing")).toBe("沙箱保护");
    expect(t("common.cancel")).toBe("取消");
    setLocale("en-US");
  });
});
