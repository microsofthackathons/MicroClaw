import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishPreparedResource } from "./publish-prepared-resource.mjs";

function fixture(context) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "microclaw-resource-publish-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, "windows-node.staging-test");
  const destination = path.join(root, "windows-node");
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, "host.exe"), "verified host");
  return { root, staging, destination };
}

test("publishes a completely prepared resource directory", (context) => {
  const setup = fixture(context);
  assert.equal(publishPreparedResource(setup.staging, setup.destination), "published");
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "verified host");
  assert.equal(fs.existsSync(setup.staging), false);
});

test("reuses identical active resources without renaming or overwriting them", (context) => {
  const setup = fixture(context);
  fs.cpSync(setup.staging, setup.destination, { recursive: true });
  assert.equal(
    publishPreparedResource(setup.staging, setup.destination, {
      rename() {
        throw new Error("active resources must not be renamed");
      },
    }),
    "unchanged",
  );
  assert.equal(fs.existsSync(setup.staging), false);
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "verified host");
});

test("replaces a changed directory only after staging is complete", (context) => {
  const setup = fixture(context);
  fs.mkdirSync(setup.destination);
  fs.writeFileSync(path.join(setup.destination, "host.exe"), "previous host");
  assert.equal(publishPreparedResource(setup.staging, setup.destination), "published");
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "verified host");
  const entries = fs.readdirSync(setup.root);
  assert.equal(entries.length, 2);
  const backup = entries.find((name) => name.startsWith("windows-node.previous-"));
  assert.equal(fs.readFileSync(path.join(setup.root, backup, "host.exe"), "utf8"), "previous host");
});

test("preserves every existing file when an active directory cannot be moved", (context) => {
  const setup = fixture(context);
  fs.mkdirSync(setup.destination);
  fs.writeFileSync(path.join(setup.destination, "host.exe"), "previous host");
  assert.throws(
    () =>
      publishPreparedResource(setup.staging, setup.destination, {
        rename() {
          throw Object.assign(new Error("in use"), { code: "EPERM" });
        },
      }),
    /previous resources were preserved/,
  );
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "previous host");
  assert.equal(fs.existsSync(setup.staging), true);
});

test("rolls back the previous directory if publishing staging fails", (context) => {
  const setup = fixture(context);
  fs.mkdirSync(setup.destination);
  fs.writeFileSync(path.join(setup.destination, "host.exe"), "previous host");
  assert.throws(
    () =>
      publishPreparedResource(setup.staging, setup.destination, {
        rename(source, destination) {
          if (source === setup.staging) throw new Error("publication failed");
          fs.renameSync(source, destination);
        },
      }),
    /publication failed/,
  );
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "previous host");
  assert.equal(fs.existsSync(setup.staging), true);
});

test("never attempts to delete potentially active previous resources after publication", (context) => {
  const setup = fixture(context);
  fs.mkdirSync(setup.destination);
  fs.writeFileSync(path.join(setup.destination, "host.exe"), "previous host");
  const warnings = [];
  assert.equal(
    publishPreparedResource(setup.staging, setup.destination, {
      remove() {
        throw new Error("previous resources must not be deleted");
      },
      warn(message) {
        warnings.push(message);
      },
    }),
    "published",
  );
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(path.join(setup.destination, "host.exe"), "utf8"), "verified host");
  const backup = fs
    .readdirSync(setup.root)
    .find((name) => name.startsWith("windows-node.previous-"));
  assert.equal(fs.readFileSync(path.join(setup.root, backup, "host.exe"), "utf8"), "previous host");
});

test("rejects unexpected staging locations before mutating anything", (context) => {
  const setup = fixture(context);
  assert.throws(
    () => publishPreparedResource(setup.staging, path.join(setup.root, "other")),
    /named sibling/,
  );
  assert.equal(fs.existsSync(setup.staging), true);
});

test("rejects redirected prepared directories", (context) => {
  const setup = fixture(context);
  fs.symlinkSync(
    setup.staging,
    setup.destination,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => publishPreparedResource(setup.staging, setup.destination),
    /invalid prepared/,
  );
  assert.equal(fs.existsSync(setup.staging), true);
});
