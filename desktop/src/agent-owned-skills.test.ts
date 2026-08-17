import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentOwnedSkillMatchNames,
  commitAgentOwnedSkillInstalls,
  commitAgentOwnedSkillRemovals,
  disableUnreferencedAgentOwnedSkills,
  installAgentOwnedSkills,
  inspectConfiguredAgentOwnedSkills,
  prepareUnusedAgentOwnedSkillRemoval,
  reconcileConfiguredAgentOwnedSkills,
  resolveAgentOwnedSkillBundleRoot,
  rollbackAgentOwnedSkillInstalls,
  rollbackAgentOwnedSkillRemovals,
  setAgentOwnedSkillsEnabled,
} from "./agent-owned-skills";

const tempDirectories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-agent-skills-"));
  tempDirectories.push(directory);
  return directory;
}

function seedBundle(root: string, contents = "skill contents"): string {
  const skillDirectory = path.join(root, "rednote-publisher");
  fs.mkdirSync(path.join(skillDirectory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), contents);
  fs.writeFileSync(path.join(skillDirectory, "scripts", "render.ps1"), "Write-Output ok");
  return skillDirectory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent-owned skills", () => {
  it("packages the Creative Muse skill as a dormant desktop resource", () => {
    const repositoryRoot = path.resolve(__dirname, "../..");
    expect(
      fs.existsSync(path.join(repositoryRoot, "skills", "rednote-publisher", "SKILL.md")),
    ).toBe(true);
    const builderConfig = fs.readFileSync(
      path.join(repositoryRoot, "desktop", "electron-builder.yml"),
      "utf-8",
    );
    expect(builderConfig).toContain("from: ../skills/rednote-publisher/");
    expect(builderConfig).toContain("to: agent-skills/rednote-publisher/");
    const installerSpec = fs.readFileSync(
      path.join(repositoryRoot, "MicroClawDeployer.spec"),
      "utf-8",
    );
    expect(installerSpec).toContain('skill_dir.name != "rednote-publisher"');
  });

  it("installs Rednote Publisher atomically only for Creative Muse", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);

    expect(installAgentOwnedSkills("code-geek", state, bundle)).toEqual([]);
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(false);

    const installs = installAgentOwnedSkills("creative-muse", state, bundle);
    expect(installs).toEqual([
      {
        skillId: "rednote-publisher",
        destination: path.join(state, "skills", "rednote-publisher"),
        created: true,
        markerCreated: false,
        upgraded: false,
      },
    ]);
    expect(
      fs.readFileSync(path.join(state, "skills", "rednote-publisher", "SKILL.md"), "utf-8"),
    ).toBe("skill contents");
    expect(
      fs.existsSync(path.join(state, "skills", "rednote-publisher", ".microclaw-agent-skill.json")),
    ).toBe(true);
  });

  it("reuses an identical existing skill but rejects conflicting contents", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const existing = seedBundle(path.join(state, "skills"));

    expect(installAgentOwnedSkills("creative-muse", state, bundle)[0]).toMatchObject({
      created: false,
      markerCreated: true,
      destination: existing,
    });
    fs.writeFileSync(path.join(existing, "SKILL.md"), "customized");
    expect(() => installAgentOwnedSkills("creative-muse", state, bundle)).toThrow(
      /differs from the packaged/,
    );
    expect(fs.readFileSync(path.join(existing, "SKILL.md"), "utf-8")).toBe("customized");
  });

  it("rolls back a newly installed skill without touching an existing skill", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const installs = installAgentOwnedSkills("creative-muse", state, bundle);

    rollbackAgentOwnedSkillInstalls(installs);

    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(false);
  });

  it("removes an adopted ownership marker when agent addition rolls back", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const existing = seedBundle(path.join(state, "skills"));
    const installs = installAgentOwnedSkills("creative-muse", state, bundle);
    const markerPath = path.join(existing, ".microclaw-agent-skill.json");
    expect(fs.existsSync(markerPath)).toBe(true);

    rollbackAgentOwnedSkillInstalls(installs);

    expect(fs.existsSync(existing)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("removes an unmodified owned skill and supports rollback", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    installAgentOwnedSkills("creative-muse", state, bundle);
    const config = { agents: { list: [{ id: "main", skills: [] }] } };

    const removals = prepareUnusedAgentOwnedSkillRemoval(config, "creative-muse", state, bundle);
    expect(removals).toHaveLength(1);
    expect(removals[0].quarantine.startsWith(path.join(state, ".agent-skill-quarantine"))).toBe(
      true,
    );
    expect(removals[0].quarantine.startsWith(path.join(state, "skills"))).toBe(false);
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(false);

    rollbackAgentOwnedSkillRemovals(removals);
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(true);

    const secondRemoval = prepareUnusedAgentOwnedSkillRemoval(
      config,
      "creative-muse",
      state,
      bundle,
    );
    commitAgentOwnedSkillRemovals(secondRemoval);
    expect(fs.existsSync(secondRemoval[0].quarantine)).toBe(false);
  });

  it("preserves modified or still-referenced skills during agent removal", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    installAgentOwnedSkills("creative-muse", state, bundle);
    const destination = path.join(state, "skills", "rednote-publisher");
    fs.writeFileSync(path.join(destination, "SKILL.md"), "user customization");

    expect(
      prepareUnusedAgentOwnedSkillRemoval(
        { agents: { list: [{ id: "main", skills: [] }] } },
        "creative-muse",
        state,
        bundle,
      ),
    ).toEqual([]);
    expect(fs.existsSync(destination)).toBe(true);

    fs.rmSync(destination, { recursive: true, force: true });
    installAgentOwnedSkills("creative-muse", state, bundle);
    expect(
      prepareUnusedAgentOwnedSkillRemoval(
        {
          agents: {
            list: [{ id: "custom", skills: ["Rednote Publisher"] }],
          },
        },
        "creative-muse",
        state,
        bundle,
      ),
    ).toEqual([]);

    expect(
      prepareUnusedAgentOwnedSkillRemoval(
        {
          agents: {
            list: [{ id: "unrestricted-custom-agent" }],
          },
        },
        "creative-muse",
        state,
        bundle,
      ),
    ).toEqual([]);
  });

  it("enables the owned skill on add and disables it only when unreferenced", () => {
    const config = {
      agents: {
        list: [
          {
            id: "creative-muse",
            skills: ["Rednote Publisher"],
          },
        ],
      },
      skills: { entries: { "rednote-publisher": { enabled: false } } },
    };

    expect(setAgentOwnedSkillsEnabled(config, "creative-muse", true)).toBe(true);
    expect(config.skills.entries["rednote-publisher"].enabled).toBe(true);
    expect(agentOwnedSkillMatchNames("creative-muse")).toEqual(["Rednote Publisher"]);
    expect(disableUnreferencedAgentOwnedSkills(config, "creative-muse")).toBe(false);

    config.agents.list = [];
    expect(disableUnreferencedAgentOwnedSkills(config, "creative-muse")).toBe(true);
    expect(config.skills.entries["rednote-publisher"].enabled).toBe(false);

    expect(disableUnreferencedAgentOwnedSkills({ agents: { list: [] } }, "creative-muse")).toBe(
      false,
    );
  });

  it("resolves packaged and development bundle roots", () => {
    expect(resolveAgentOwnedSkillBundleRoot(true, "C:\\resources", "C:\\module")).toBe(
      path.join("C:\\resources", "agent-skills"),
    );
    expect(
      resolveAgentOwnedSkillBundleRoot(false, "unused", path.join("C:\\repo", "desktop", "dist")),
    ).toBe(path.join("C:\\repo", "skills"));
  });

  it("preserves an older owned skill version during startup reconciliation", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle, "version one");
    installAgentOwnedSkills("creative-muse", state, bundle);
    seedBundle(bundle, "version two");
    const config = {
      agents: {
        list: [{ id: "creative-muse", skills: ["Rednote Publisher"] }],
      },
      skills: { entries: { "rednote-publisher": { enabled: true } } },
    };

    const reconciliation = reconcileConfiguredAgentOwnedSkills(config, state, bundle);

    expect(reconciliation.installs[0]).toMatchObject({
      created: false,
      markerCreated: false,
      upgraded: false,
    });

    expect(reconciliation.runtimeChanged).toBe(false);
    expect(
      fs.readFileSync(path.join(state, "skills", "rednote-publisher", "SKILL.md"), "utf-8"),
    ).toBe("version one");

    expect(
      disableUnreferencedAgentOwnedSkills(
        {
          agents: { list: [{ id: "unrestricted-custom-agent" }] },
          skills: { entries: { "rednote-publisher": { enabled: true } } },
        },
        "creative-muse",
      ),
    ).toBe(false);
  });

  it("atomically upgrades a signed clean prior version and supports rollback", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle, "version one");
    installAgentOwnedSkills("creative-muse", state, bundle);
    seedBundle(bundle, "version two");

    const installs = installAgentOwnedSkills("creative-muse", state, bundle, {
      isTrustedInstalledSkill: () => true,
    });

    expect(installs[0]).toMatchObject({
      created: false,
      markerCreated: false,
      upgraded: true,
    });
    expect(
      fs.readFileSync(path.join(state, "skills", "rednote-publisher", "SKILL.md"), "utf-8"),
    ).toBe("version two");

    rollbackAgentOwnedSkillInstalls(installs);
    expect(
      fs.readFileSync(path.join(state, "skills", "rednote-publisher", "SKILL.md"), "utf-8"),
    ).toBe("version one");

    const committed = installAgentOwnedSkills("creative-muse", state, bundle, {
      isTrustedInstalledSkill: () => true,
    });
    expect(commitAgentOwnedSkillInstalls(committed)).toEqual([]);
    expect(fs.existsSync(committed[0].backup!)).toBe(false);
  });

  it("preserves a user-modified owned skill during startup reconciliation", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle, "version one");
    installAgentOwnedSkills("creative-muse", state, bundle);
    const destination = path.join(state, "skills", "rednote-publisher");
    fs.writeFileSync(path.join(destination, "SKILL.md"), "user changes");
    seedBundle(bundle, "version two");
    const config = {
      agents: {
        list: [{ id: "creative-muse", skills: ["Rednote Publisher"] }],
      },
      skills: { entries: { "rednote-publisher": { enabled: true } } },
    };

    const reconciliation = reconcileConfiguredAgentOwnedSkills(config, state, bundle);

    expect(reconciliation.installs[0]).toMatchObject({
      created: false,
      markerCreated: false,
    });
    expect(fs.readFileSync(path.join(destination, "SKILL.md"), "utf-8")).toBe("user changes");
  });

  it("preserves an explicit global disable during startup reconciliation", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const config = {
      agents: {
        list: [{ id: "creative-muse", skills: ["Rednote Publisher"] }],
      },
      skills: { entries: { "rednote-publisher": { enabled: false } } },
    };

    const reconciliation = reconcileConfiguredAgentOwnedSkills(config, state, bundle);

    expect(reconciliation.runtimeChanged).toBe(true);
    expect(reconciliation.configChanged).toBe(false);
    expect(reconciliation.installs).toHaveLength(1);
    expect(reconciliation.removals).toEqual([]);
    expect(config.skills.entries["rednote-publisher"].enabled).toBe(false);
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(true);
  });

  it("reports required reconciliation without mutating files or config", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const config = {
      agents: {
        list: [{ id: "creative-muse", skills: ["Rednote Publisher"] }],
      },
    };

    const plan = inspectConfiguredAgentOwnedSkills(config, state, bundle);

    expect(plan.required).toBe(true);
    expect(plan.reasons).toEqual(
      expect.arrayContaining(["configure rednote-publisher", "install rednote-publisher"]),
    );
    expect(config).not.toHaveProperty("skills");
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(false);
  });

  it("preserves a markerless legacy skill while disabling it", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    seedBundle(path.join(state, "skills"));
    const config = {
      agents: { list: [{ id: "main", skills: [] }] },
      skills: { entries: { "rednote-publisher": { enabled: true } } },
    };

    const reconciliation = reconcileConfiguredAgentOwnedSkills(config, state, bundle);

    expect(reconciliation.runtimeChanged).toBe(true);
    expect(reconciliation.removals).toEqual([]);
    expect(config.skills.entries["rednote-publisher"].enabled).toBe(false);
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(true);
  });

  it("does not create an owned-skill config entry on a fresh base install", () => {
    const root = tempDirectory();
    const bundle = path.join(root, "bundle");
    const state = path.join(root, "state");
    seedBundle(bundle);
    const config = { agents: { list: [{ id: "main", skills: [] }] } };

    const reconciliation = reconcileConfiguredAgentOwnedSkills(config, state, bundle);

    expect(reconciliation).toEqual({
      installs: [],
      removals: [],
      configChanged: false,
      runtimeChanged: false,
    });
    expect(config).not.toHaveProperty("skills");
    expect(fs.existsSync(path.join(state, "skills", "rednote-publisher"))).toBe(false);
  });
});
