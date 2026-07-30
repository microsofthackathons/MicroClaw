import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG,
  ALL_SKILL_IDS,
  getAgentSkills,
  isKnownSkillId,
  matchesSkill,
  resolveSkillFilterNames,
  sanitizeAgentSkillIds,
  SKILL_MATCH_NAMES,
} from "./agent-catalog";

const EXPECTED_SKILL_IDS = [
  "1password",
  "blucli",
  "canvas",
  "coding-agent",
  "desktop-organizer",
  "excel-xlsx",
  "healthcheck",
  "mcporter",
  "nano-pdf",
  "obsidian",
  "officecli",
  "openai-whisper",
  "openhue",
  "oracle",
  "powerpoint-pptx",
  "security-practice",
  "session-logs",
  "sherpa-onnx-tts",
  "skill-creator",
  "songsee",
  "sonoscli",
  "video-frames",
  "word-docx",
];

describe("agent catalog skills binding", () => {
  it("exposes exactly the 23 expected skill IDs", () => {
    expect(ALL_SKILL_IDS).toEqual(EXPECTED_SKILL_IDS);
    expect(ALL_SKILL_IDS).toHaveLength(23);
  });

  it("keeps ALL_SKILL_IDS sorted with no duplicates", () => {
    const sorted = [...ALL_SKILL_IDS].sort((a, b) => a.localeCompare(b, "en"));
    expect([...ALL_SKILL_IDS]).toEqual(sorted);
    expect(new Set(ALL_SKILL_IDS).size).toBe(ALL_SKILL_IDS.length);
  });

  it("binds every agent to the full skill list", () => {
    for (const agent of AGENT_CATALOG) {
      expect(agent.skills).toEqual(ALL_SKILL_IDS);
    }
  });

  it("gives each agent its own skills array instance", () => {
    // No agent shares a reference with another agent or with ALL_SKILL_IDS.
    for (const agent of AGENT_CATALOG) {
      expect(agent.skills).not.toBe(ALL_SKILL_IDS);
    }
    const seen = new Set<readonly string[]>();
    for (const agent of AGENT_CATALOG) {
      expect(seen.has(agent.skills)).toBe(false);
      seen.add(agent.skills);
    }

    // Mutating one agent's array does not affect others or ALL_SKILL_IDS.
    const [first, second] = AGENT_CATALOG;
    (first.skills as string[]).push("__mutation-probe__");
    try {
      expect(second.skills).toEqual(ALL_SKILL_IDS);
      expect(ALL_SKILL_IDS).toEqual(EXPECTED_SKILL_IDS);
    } finally {
      (first.skills as string[]).pop();
    }
  });

  it("resolves skills for a known agent and returns [] for an unknown one", () => {
    expect(getAgentSkills("coder")).toEqual(ALL_SKILL_IDS);
    expect(getAgentSkills("does-not-exist")).toEqual([]);
  });

  it("recognizes known skill ids and rejects unknown ones", () => {
    expect(isKnownSkillId("canvas")).toBe(true);
    expect(isKnownSkillId("not-a-skill")).toBe(false);
  });

  it("sanitizes requested skill ids into sorted, de-duplicated known ids", () => {
    expect(sanitizeAgentSkillIds(["canvas", "1password", "canvas"])).toEqual([
      "1password",
      "canvas",
    ]);
    expect(sanitizeAgentSkillIds([])).toEqual([]);
  });

  it("throws when a requested skill id is unknown or malformed", () => {
    expect(() => sanitizeAgentSkillIds(["canvas", "bogus"])).toThrow(/Unknown skill id/);
    expect(() => sanitizeAgentSkillIds(["", "canvas"])).toThrow(/non-empty strings/);
    expect(() => sanitizeAgentSkillIds("canvas" as unknown as string[])).toThrow(
      /must be an array/,
    );
  });
});

describe("OpenClaw skill match-name resolution", () => {
  const EXCEPTIONS: Record<string, string> = {
    "desktop-organizer": "Desktop Organizer",
    "excel-xlsx": "Excel / XLSX",
    "powerpoint-pptx": "Powerpoint / PPTX",
    "security-practice": "Security Practice",
    "word-docx": "Word / DOCX",
  };

  it("maps exactly the five slug/name exceptions", () => {
    expect(SKILL_MATCH_NAMES).toEqual(EXCEPTIONS);
  });

  it("only maps slugs that are real catalog ids", () => {
    for (const slug of Object.keys(SKILL_MATCH_NAMES)) {
      expect(isKnownSkillId(slug)).toBe(true);
    }
  });

  it("resolveSkillFilterNames maps the exceptions and passes others through", () => {
    expect(resolveSkillFilterNames(["excel-xlsx", "1password", "word-docx", "canvas"])).toEqual([
      "Excel / XLSX",
      "1password",
      "Word / DOCX",
      "canvas",
    ]);
  });

  it("resolves every catalog id, leaving non-exception slugs unchanged", () => {
    const resolved = resolveSkillFilterNames(ALL_SKILL_IDS);
    for (let i = 0; i < ALL_SKILL_IDS.length; i++) {
      const slug = ALL_SKILL_IDS[i];
      expect(resolved[i]).toBe(EXCEPTIONS[slug] ?? slug);
    }
  });

  it("matchesSkill recognizes both slug- and name-form stored values", () => {
    // Exception: both slug and mapped name register.
    expect(matchesSkill("excel-xlsx", "excel-xlsx")).toBe(true);
    expect(matchesSkill("Excel / XLSX", "excel-xlsx")).toBe(true);
    // Non-exception: slug matches, unrelated value does not.
    expect(matchesSkill("1password", "1password")).toBe(true);
    expect(matchesSkill("Excel / XLSX", "1password")).toBe(false);
    expect(matchesSkill("word-docx", "excel-xlsx")).toBe(false);
  });
});
