import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG,
  ALL_SKILL_IDS,
  getAgentSkills,
  isKnownSkillId,
  sanitizeAgentSkillIds,
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
