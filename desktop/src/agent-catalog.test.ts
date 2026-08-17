import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG,
  AGENT_OWNED_SKILL_IDS,
  ALL_SKILL_IDS,
  getAgentSkills,
  getAgentOwnedSkillIds,
  isKnownSkillId,
  matchesSkill,
  canonicalAgentId,
  resolveSkillFilterNames,
  sanitizeAgentSkillIds,
  SKILL_MATCH_NAMES,
  SHARED_SKILL_IDS,
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
  "rednote-publisher",
  "security-practice",
  "session-logs",
  "sherpa-onnx-tts",
  "skill-creator",
  "songsee",
  "sonoscli",
  "video-frames",
  "word-docx",
];

describe("agent catalog artwork", () => {
  const assetDirectory = path.resolve(__dirname, "../renderer/src/assets");

  function readPngDimensions(filename: string): { width: number; height: number } {
    const data = fs.readFileSync(path.join(assetDirectory, filename));
    expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }

  it("uses one existing square compact-avatar asset per agent", () => {
    const avatars = new Set<string>();
    for (const agent of AGENT_CATALOG) {
      const expectedFilename = `${agent.id}-avatar.png`;
      expect(agent.avatar).toBe(expectedFilename);
      expect(fs.existsSync(path.join(assetDirectory, agent.avatar))).toBe(true);
      expect(avatars.has(agent.avatar)).toBe(false);
      avatars.add(agent.avatar);

      const { width, height } = readPngDimensions(agent.avatar);
      expect(width).toBe(height);
      expect(width).toBeLessThanOrEqual(512);
    }
  });

  it("keeps compact avatars separate from non-main Marketplace artwork", () => {
    for (const agent of AGENT_CATALOG) {
      expect(fs.existsSync(path.join(assetDirectory, agent.image))).toBe(true);
      if (agent.id !== "main") {
        expect(agent.avatar).not.toBe(agent.image);
      }
    }
  });
});

describe("agent catalog skills binding", () => {
  it("exposes exactly the 24 expected skill IDs", () => {
    expect(ALL_SKILL_IDS).toEqual(EXPECTED_SKILL_IDS);
    expect(ALL_SKILL_IDS).toHaveLength(24);
  });

  it("keeps ALL_SKILL_IDS sorted with no duplicates", () => {
    const sorted = [...ALL_SKILL_IDS].sort((a, b) => a.localeCompare(b, "en"));
    expect([...ALL_SKILL_IDS]).toEqual(sorted);
    expect(new Set(ALL_SKILL_IDS).size).toBe(ALL_SKILL_IDS.length);
  });

  it("binds shared skills to every agent and the owned skill only to Creative Muse", () => {
    for (const agent of AGENT_CATALOG) {
      expect(agent.skills).toEqual(agent.id === "creative-muse" ? ALL_SKILL_IDS : SHARED_SKILL_IDS);
    }
    expect(AGENT_OWNED_SKILL_IDS).toEqual(["rednote-publisher"]);
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
      expect(second.skills).toEqual(SHARED_SKILL_IDS);
      expect(ALL_SKILL_IDS).toEqual(EXPECTED_SKILL_IDS);
    } finally {
      (first.skills as string[]).pop();
    }
  });

  it("resolves skills for a known agent and returns [] for an unknown one", () => {
    expect(getAgentSkills("code-geek")).toEqual(SHARED_SKILL_IDS);
    expect(getAgentSkills("creative-muse")).toEqual(ALL_SKILL_IDS);
    expect(getAgentOwnedSkillIds("creative-muse")).toEqual(["rednote-publisher"]);
    expect(getAgentOwnedSkillIds("code-geek")).toEqual([]);
    expect(getAgentSkills("does-not-exist")).toEqual([]);
  });

  it("configures Code Geek with a dedicated persona workspace", () => {
    expect(AGENT_CATALOG.find((agent) => agent.id === "code-geek")).toMatchObject({
      name: "Code Geek",
      workspaceDirName: "workspace-code-geek",
      personaProfile: "code-geek",
    });
  });

  it("replaces Growth Hacker with the dedicated Intel Analyst persona", () => {
    expect(AGENT_CATALOG.some((agent) => agent.id === "growth-hacker")).toBe(false);
    expect(AGENT_CATALOG.find((agent) => agent.id === "intel-analyst")).toMatchObject({
      name: "Intel Analyst",
      image: "Scientist.png",
      workspaceDirName: "workspace-intel-analyst",
      personaProfile: "intel-analyst",
    });
  });

  it("replaces Master with the dedicated Dr. Pulse persona", () => {
    expect(AGENT_CATALOG.some((agent) => agent.id === "master")).toBe(false);
    expect(AGENT_CATALOG.find((agent) => agent.id === "dr-pulse")).toMatchObject({
      name: "Dr. Pulse",
      avatar: "dr-pulse-avatar.png",
      image: "Diviner.png",
      workspaceDirName: "workspace-dr-pulse",
      personaProfile: "dr-pulse",
    });
    expect(canonicalAgentId("master")).toBe("dr-pulse");
  });

  it("replaces Leopard with the dedicated Market Sentinel persona", () => {
    expect(AGENT_CATALOG.some((agent) => agent.id === "leopard")).toBe(false);
    expect(AGENT_CATALOG.find((agent) => agent.id === "market-sentinel")).toMatchObject({
      name: "Market Sentinel",
      avatar: "market-sentinel-avatar.png",
      image: "stock.png",
      workspaceDirName: "workspace-market-sentinel",
      personaProfile: "market-sentinel",
    });
    expect(canonicalAgentId("leopard")).toBe("market-sentinel");
  });

  it("replaces Singer with the dedicated Creative Muse persona", () => {
    expect(AGENT_CATALOG.some((agent) => agent.id === "singer")).toBe(false);
    expect(AGENT_CATALOG.find((agent) => agent.id === "creative-muse")).toMatchObject({
      name: "Creative Muse",
      image: "CreativeMuse.png",
      workspaceDirName: "workspace-creative-muse",
      personaProfile: "creative-muse",
      ownedSkills: ["rednote-publisher"],
    });
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
    "rednote-publisher": "Rednote Publisher",
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
