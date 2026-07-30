import { describe, expect, it } from "vitest";
import {
  applyAgentSkillsToConfig,
  applyGlobalSkillChange,
  type MutableSkillsConfig,
} from "./skill-config";

describe("applyAgentSkillsToConfig", () => {
  it("writes OpenClaw match-names (not raw slugs) for the differing skills", () => {
    const config: MutableSkillsConfig = {
      agents: { list: [{ id: "main", skills: [] }] },
    };
    applyAgentSkillsToConfig(config, "main", [
      "excel-xlsx",
      "word-docx",
      "powerpoint-pptx",
      "desktop-organizer",
      "security-practice",
      "healthcheck",
    ]);
    const entry = (config.agents!.list as Array<{ id: string; skills: string[] }>)[0];
    expect(entry.skills).toEqual([
      "Excel / XLSX",
      "Word / DOCX",
      "Powerpoint / PPTX",
      "Desktop Organizer",
      "Security Practice",
      "healthcheck",
    ]);
  });

  it("passes through slugs that equal their frontmatter name", () => {
    const config: MutableSkillsConfig = {
      agents: { list: [{ id: "coder", skills: ["stale"] }] },
    };
    applyAgentSkillsToConfig(config, "coder", ["1password", "healthcheck"]);
    const entry = (config.agents!.list as Array<{ id: string; skills: string[] }>)[0];
    expect(entry.skills).toEqual(["1password", "healthcheck"]);
  });

  it("targets the correct agent when several are present", () => {
    const config: MutableSkillsConfig = {
      agents: {
        list: [
          { id: "main", skills: ["keep"] },
          { id: "painter", skills: [] },
        ],
      },
    };
    applyAgentSkillsToConfig(config, "painter", ["excel-xlsx"]);
    const list = config.agents!.list as Array<{ id: string; skills: string[] }>;
    expect(list[0].skills).toEqual(["keep"]);
    expect(list[1].skills).toEqual(["Excel / XLSX"]);
  });

  it("throws when the agent list is missing", () => {
    expect(() => applyAgentSkillsToConfig({}, "main", [])).toThrow(
      /No configured agents/,
    );
  });

  it("throws when the agent id is not present", () => {
    const config: MutableSkillsConfig = { agents: { list: [{ id: "main" }] } };
    expect(() => applyAgentSkillsToConfig(config, "ghost", [])).toThrow(
      /Unknown agent "ghost"/,
    );
  });
});

describe("applyGlobalSkillChange", () => {
  it("enables a skill and clears any global disable", () => {
    const config: MutableSkillsConfig = {
      skills: { entries: { blucli: { enabled: false } } },
    };
    applyGlobalSkillChange(config, "blucli", true, false);
    expect(config.skills!.entries!.blucli.enabled).toBe(true);
  });

  it("adds a bundled skill to a non-empty allowBundled when enabling", () => {
    const config: MutableSkillsConfig = {
      skills: { allowBundled: ["oracle"] },
    };
    applyGlobalSkillChange(config, "healthcheck", true, true);
    expect(config.skills!.allowBundled).toEqual(["oracle", "healthcheck"]);
    expect(config.skills!.entries!.healthcheck.enabled).toBe(true);
  });

  it("does not duplicate an already-present allowBundled entry", () => {
    const config: MutableSkillsConfig = {
      skills: { allowBundled: ["healthcheck"] },
    };
    applyGlobalSkillChange(config, "healthcheck", true, true);
    expect(config.skills!.allowBundled).toEqual(["healthcheck"]);
  });

  it("leaves an absent/empty allowBundled untouched when enabling a bundled skill", () => {
    const empty: MutableSkillsConfig = { skills: { allowBundled: [] } };
    applyGlobalSkillChange(empty, "healthcheck", true, true);
    expect(empty.skills!.allowBundled).toEqual([]);

    const absent: MutableSkillsConfig = {};
    applyGlobalSkillChange(absent, "healthcheck", true, true);
    expect(absent.skills!.allowBundled).toBeUndefined();
    expect(absent.skills!.entries!.healthcheck.enabled).toBe(true);
  });

  it("does not touch allowBundled for a non-bundled (managed) skill", () => {
    const config: MutableSkillsConfig = {
      skills: { allowBundled: ["oracle"] },
    };
    applyGlobalSkillChange(config, "coding-agent", true, false);
    expect(config.skills!.allowBundled).toEqual(["oracle"]);
    expect(config.skills!.entries!["coding-agent"].enabled).toBe(true);
  });

  it("disables a skill by setting entries[key].enabled=false", () => {
    const config: MutableSkillsConfig = {};
    applyGlobalSkillChange(config, "blucli", false, true);
    expect(config.skills!.entries!.blucli.enabled).toBe(false);
  });
});
