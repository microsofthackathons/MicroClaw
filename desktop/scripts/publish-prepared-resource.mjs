import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

function inventory(root) {
  const entries = [];
  const visit = (relative) => {
    const file = path.join(root, relative);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing a linked prepared resource: ${file}`);
    if (stat.isDirectory()) {
      entries.push([relative, "directory"]);
      for (const name of readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile() && stat.nlink === 1) {
      entries.push([
        relative,
        stat.size,
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]);
    } else throw new Error(`Refusing a non-regular prepared resource: ${file}`);
  };
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Refusing an invalid prepared resource directory: ${root}`);
  visit("");
  return entries;
}

export function publishPreparedResource(
  staging,
  destination,
  {
    rename = renameSync,
    remove = rmSync,
    warn = console.warn,
    sleep = (milliseconds) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  } = {},
) {
  staging = path.resolve(staging);
  destination = path.resolve(destination);
  const parent = path.dirname(destination);
  if (
    path.dirname(staging) !== parent ||
    !path.basename(staging).startsWith(`${path.basename(destination)}.staging-`)
  )
    throw new Error("Prepared resource staging must be a named sibling of its destination");
  const prepared = inventory(staging);
  let present = false;
  try {
    const current = inventory(destination);
    present = true;
    if (JSON.stringify(current) === JSON.stringify(prepared)) {
      remove(staging, { recursive: true, force: true });
      return "unchanged";
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      lstatSync(destination);
      throw new Error("Prepared resource destination changed during verification", {
        cause: error,
      });
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  const backup = path.join(parent, `${path.basename(destination)}.previous-${randomUUID()}`);
  const renameWithRetry = (source, target) => {
    for (let attempt = 0; ; attempt++) {
      try {
        rename(source, target);
        return;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          attempt >= 9
        )
          throw error;
        sleep(500);
      }
    }
  };
  if (present) {
    try {
      renameWithRetry(destination, backup);
    } catch (error) {
      throw new Error(
        "Cannot replace prepared resources while they are in use. The previous resources were preserved; close the development app before retrying.",
        { cause: error },
      );
    }
  }
  try {
    renameWithRetry(staging, destination);
  } catch (error) {
    if (present) {
      try {
        renameWithRetry(backup, destination);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Prepared resource publication and rollback failed; previous resources remain at ${backup}`,
        );
      }
    }
    throw error;
  }
  if (present) {
    warn(`Previous prepared resources retained for safe cleanup after the app exits: ${backup}`);
  }
  return "published";
}
