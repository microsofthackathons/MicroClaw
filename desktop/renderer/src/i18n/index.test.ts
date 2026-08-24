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
    expect(t("settings.windowsNodeMxcTechnicalDetails")).toBe("Technical details");
    expect(t("settings.windowsNodeMxcProtected")).toBe("Protected");
    expect(t("settings.windowsNodeMxcStarting")).toBe("Starting");
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("Action required");
    expect(t("settings.windowsNodeMxcFolders")).toBe("Global MXC approved folders");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("global capability ceiling");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("never grant access");
    expect(t("settings.windowsNodeMxcFoldersLocked")).toContain("Disable Windows Node + MXC");

    setLocale("zh-CN");
    expect(t("settings.windowsNodeMxcTechnicalDetails")).toBe("技术详情");
    expect(t("settings.windowsNodeMxcProtected")).toBe("已保护");
    expect(t("settings.windowsNodeMxcStarting")).toBe("正在启动");
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("需要操作");
    expect(t("settings.windowsNodeMxcFolders")).toBe("MXC 全局批准文件夹");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("全局能力上限");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("绝不会授予访问权限");
    expect(t("settings.windowsNodeMxcFoldersLocked")).toContain("请先禁用 Windows Node + MXC");
    setLocale("en-US");
  });
});
