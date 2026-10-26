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
    expect(t("settings.windowsNodeMxcTechnicalDetails")).toBe("Security diagnostics");
    expect(
      t("settings.windowsNodeMxcCompactStatus", {
        mode: t("settings.windowsNodeMxcModeLimited"),
        state: t("settings.windowsNodeMxcStatusActive"),
      }),
    ).toBe("Limited containment (DACL) — Active");
    expect(t("settings.windowsNodeMxcAmbientAllDenied", { denied: 18, total: 18 })).toBe(
      "No inherited filesystem access detected (18/18 denied)",
    );
    expect(t("settings.windowsNodeMxcAmbientBeforeGrants")).toBe(
      "Ambient access before selected-folder grants",
    );
    expect(t("settings.windowsNodeMxcProtected")).toBe("Protected");
    expect(t("settings.windowsNodeMxcStarting")).toBe("Starting");
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("Action required");
    expect(t("settings.windowsNodeMxcFolders")).toBe("Global MXC approved folders");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("global capability ceiling");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("never grant access");
    expect(t("settings.windowsNodeMxcFoldersLocked")).toContain("Disable Windows Node + MXC");
    expect(t("settings.windowsNodeMxcModeFull")).toBe("Full containment");
    expect(t("settings.windowsNodeMxcModeLimited")).toBe("Limited containment (DACL)");
    expect(t("settings.windowsNodeMxcOffWarning")).toContain("No execution sandbox");
    expect(t("settings.windowsNodeMxcFullFolders")).toBe("Full hard-boundary approved folders");
    expect(t("settings.windowsNodeMxcLimitedFolders")).toBe("Limited additional filesystem grants");
    expect(t("settings.windowsNodeMxcLimitedFoldersHint")).toContain("not an exclusive allowlist");
    expect(t("settings.windowsNodeMxcLimitedFoldersHint")).toContain("Read-only cannot reduce");
    expect(t("settings.windowsNodeMxcLimitedCommandApprovalsHint")).toContain(
      "does not offer Allow always",
    );
    expect(t("settings.windowsNodeMxcAmbientCategory.browser-edge")).toBe("Edge data");

    setLocale("zh-CN");
    expect(t("settings.windowsNodeMxcTechnicalDetails")).toBe("安全诊断");
    expect(
      t("settings.windowsNodeMxcCompactStatus", {
        mode: t("settings.windowsNodeMxcModeLimited"),
        state: t("settings.windowsNodeMxcStatusActive"),
      }),
    ).toBe("有限隔离（DACL） — 已启用");
    expect(t("settings.windowsNodeMxcAmbientAllDenied", { denied: 18, total: 18 })).toBe(
      "未检测到继承的文件系统访问（18/18 均被拒绝）",
    );
    expect(t("settings.windowsNodeMxcAmbientBeforeGrants")).toBe("所选文件夹授权前的环境访问");
    expect(t("settings.windowsNodeMxcProtected")).toBe("已保护");
    expect(t("settings.windowsNodeMxcStarting")).toBe("正在启动");
    expect(t("settings.windowsNodeMxcActionRequired")).toBe("需要操作");
    expect(t("settings.windowsNodeMxcFolders")).toBe("MXC 全局批准文件夹");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("全局能力上限");
    expect(t("settings.windowsNodeMxcFoldersHint")).toContain("绝不会授予访问权限");
    expect(t("settings.windowsNodeMxcFoldersLocked")).toContain("请先禁用 Windows Node + MXC");
    expect(t("settings.windowsNodeMxcModeFull")).toBe("完整隔离");
    expect(t("settings.windowsNodeMxcModeLimited")).toBe("有限隔离（DACL）");
    expect(t("settings.windowsNodeMxcOffWarning")).toContain("无执行沙箱");
    expect(t("settings.windowsNodeMxcFullFolders")).toBe("完整强边界批准文件夹");
    expect(t("settings.windowsNodeMxcLimitedFolders")).toBe("有限模式额外文件系统授权");
    expect(t("settings.windowsNodeMxcLimitedFoldersHint")).toContain("并非排他允许列表");
    expect(t("settings.windowsNodeMxcLimitedFoldersHint")).toContain("只读无法降低");
    expect(t("settings.windowsNodeMxcLimitedCommandApprovalsHint")).toContain("不提供“始终允许”");
    expect(t("settings.windowsNodeMxcAmbientCategory.browser-edge")).toBe("Edge 数据");
    setLocale("en-US");
  });

  it("localizes Limited MXC approval warnings", () => {
    setLocale("en-US");
    expect(t("perm.titleMxcLimited")).toBe("Limited filesystem containment");
    expect(t("perm.mxcLimitedScope")).toContain("additive, not an exclusive allowlist");
    expect(t("perm.mxcAllowAlways")).toBe("Always allow in this conversation");

    setLocale("zh-CN");
    expect(t("perm.titleMxcLimited")).toBe("有限文件系统隔离");
    expect(t("perm.mxcLimitedScope")).toContain("叠加式授权");
    expect(t("perm.mxcAllowAlways")).toBe("在此对话中始终允许");
    setLocale("en-US");
  });

  it("localizes the complete MXC capability consent in English and Chinese", () => {
    setLocale("en-US");
    expect(
      t("settings.windowsNodeMxcConsent.title", {
        mode: t("settings.windowsNodeMxcModeFull"),
      }),
    ).toBe("Enable Full containment?");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.disabled")).toContain(
      "Gateway file tools",
    );
    expect(t("settings.windowsNodeMxcConsent.groupSummary.paused")).toContain("no catch-up");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.paused")).toContain("503");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.available-restricted")).toContain(
      "reviewed Canvas A2UI",
    );
    expect(t("settings.windowsNodeMxcConsent.fullNote")).toContain("exclusive filesystem boundary");
    expect(t("settings.windowsNodeMxcConsent.limitedNote")).toContain("separate acknowledgement");
    expect(t("common.cancel")).toBe("Cancel");

    setLocale("zh-CN");
    expect(
      t("settings.windowsNodeMxcConsent.title", {
        mode: t("settings.windowsNodeMxcModeLimited"),
      }),
    ).toBe("启用有限隔离（DACL）？");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.disabled")).toContain("网关文件工具");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.paused")).toContain("不会补跑");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.paused")).toContain("503");
    expect(t("settings.windowsNodeMxcConsent.groupSummary.available-restricted")).toContain(
      "画布 A2UI",
    );
    expect(t("settings.windowsNodeMxcConsent.fullNote")).toContain("后端预检");
    expect(t("settings.windowsNodeMxcConsent.limitedNote")).toContain("单独确认");
    expect(t("common.cancel")).toBe("取消");
    setLocale("en-US");
  });
});
