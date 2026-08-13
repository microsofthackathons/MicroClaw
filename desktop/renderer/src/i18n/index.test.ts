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
});
