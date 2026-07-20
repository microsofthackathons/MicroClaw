import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  recoverInterruptedOpenClawUpgrade,
  UpgradeInProgressError,
} from "./openclaw-upgrade-recovery";

const roots: string[] = [];

function fixture(phase = "installing") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-upgrade-"));
  roots.push(root);
  const microclawRoot = path.join(root, ".microclaw");
  const prefix = path.join(root, "npm");
  const packageDir = path.join(prefix, "node_modules", "openclaw");
  const stateDir = path.join(root, ".openclaw");
  const transactionId = "20260720T000000Z-1234abcd";
  const backupDir = path.join(microclawRoot, "backups", "openclaw", transactionId);
  const manifestPath = path.join(microclawRoot, "upgrade", "openclaw-upgrade.json");
  const lockPath = path.join(microclawRoot, "upgrade", "openclaw-upgrade.lock");
  fs.mkdirSync(path.join(backupDir, "package"), { recursive: true });
  fs.mkdirSync(path.join(backupDir, "state"), { recursive: true });
  fs.mkdirSync(path.join(backupDir, "shims"), { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "version.txt"), "new");
  fs.writeFileSync(path.join(stateDir, "state.txt"), "migrated");
  fs.writeFileSync(path.join(backupDir, "package", "version.txt"), "old");
  fs.writeFileSync(path.join(backupDir, "state", "state.txt"), "old-state");
  const shim = path.join(prefix, "openclaw.cmd");
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(shim, "@new");
  fs.writeFileSync(path.join(backupDir, "shims", "openclaw.cmd"), "@old");
  const manifest = {
    schema_version: 1,
    transaction_id: transactionId,
    owner_pid: 999999,
    source_version: "2026.3.12",
    target_version: "2026.7.1-1",
    prefix,
    package_dir: packageDir,
    state_dir: stateDir,
    backup_dir: backupDir,
    shim_paths: [shim],
    package_existed: true,
    state_existed: true,
    phase,
    created_at: "2026-07-20T00:00:00+00:00",
    updated_at: "2026-07-20T00:00:00+00:00",
    validation_results: {},
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      schema: 1,
      owner_pid: 999999,
      transaction_id: transactionId,
      owner_token: "dead",
    }),
  );
  return {
    microclawRoot,
    prefix,
    packageDir,
    stateDir,
    backupDir,
    manifestPath,
    lockPath,
    shim,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("recoverInterruptedOpenClawUpgrade", () => {
  it("restores package, state, and shims from an abandoned transaction", () => {
    const item = fixture();

    const result = recoverInterruptedOpenClawUpgrade(item.microclawRoot, {
      expectedStateDir: item.stateDir,
      trustedPrefixes: [item.prefix],
      processIsAlive: () => false,
    });

    expect(result.status).toBe("rolled-back");
    expect(fs.readFileSync(path.join(item.packageDir, "version.txt"), "utf-8")).toBe("old");
    expect(fs.readFileSync(path.join(item.stateDir, "state.txt"), "utf-8")).toBe("old-state");
    expect(fs.readFileSync(item.shim, "utf-8")).toBe("@old");
    expect(JSON.parse(fs.readFileSync(item.manifestPath, "utf-8")).phase).toBe("rolled-back");
  });

  it("does not mutate live data while an installer owns the lock", () => {
    const item = fixture();

    expect(() =>
      recoverInterruptedOpenClawUpgrade(item.microclawRoot, {
        expectedStateDir: item.stateDir,
        trustedPrefixes: [item.prefix],
        claimLock: () => {
          throw new UpgradeInProgressError("installer owns lock");
        },
      }),
    ).toThrow(UpgradeInProgressError);
    expect(fs.readFileSync(path.join(item.packageDir, "version.txt"), "utf-8")).toBe("new");
  });

  it("marks a partial backing-up phase rolled back without replacing live data", () => {
    const item = fixture("backing-up");

    const result = recoverInterruptedOpenClawUpgrade(item.microclawRoot, {
      expectedStateDir: item.stateDir,
      trustedPrefixes: [item.prefix],
      processIsAlive: () => false,
    });

    expect(result.status).toBe("rolled-back");
    expect(fs.readFileSync(path.join(item.packageDir, "version.txt"), "utf-8")).toBe("new");
    expect(fs.readFileSync(path.join(item.stateDir, "state.txt"), "utf-8")).toBe("migrated");
  });

  it("rejects package paths outside the independently trusted prefix", () => {
    const item = fixture();
    const manifest = JSON.parse(fs.readFileSync(item.manifestPath, "utf-8"));
    manifest.prefix = path.join(path.dirname(item.prefix), "outside");
    manifest.package_dir = path.join(manifest.prefix, "node_modules", "openclaw");
    manifest.shim_paths = [path.join(manifest.prefix, "openclaw.cmd")];
    fs.writeFileSync(item.manifestPath, JSON.stringify(manifest));

    expect(() =>
      recoverInterruptedOpenClawUpgrade(item.microclawRoot, {
        expectedStateDir: item.stateDir,
        trustedPrefixes: [item.prefix],
        processIsAlive: () => false,
      }),
    ).toThrow(/trusted OpenClaw prefix/);
  });

  it("rejects a backup directory symlink that escapes the backup root", () => {
    const item = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-outside-"));
    roots.push(outside);
    fs.rmSync(item.backupDir, { recursive: true, force: true });
    fs.symlinkSync(outside, item.backupDir, "junction");

    expect(() =>
      recoverInterruptedOpenClawUpgrade(item.microclawRoot, {
        expectedStateDir: item.stateDir,
        trustedPrefixes: [item.prefix],
        processIsAlive: () => false,
      }),
    ).toThrow(/backup directory/);
  });
});
