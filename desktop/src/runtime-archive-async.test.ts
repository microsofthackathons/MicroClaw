import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitRuntimeArchive,
  materializeRuntimeArchive,
  materializeRuntimeArchiveAsync,
  type RuntimeArchiveRequest,
} from "./runtime-archive";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-async-runtime-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const worker = new EventEmitter() as unknown as Worker;
  const startWorker = vi.fn((_request: RuntimeArchiveRequest) => worker);
  const extract = (_archive: string, destination: string) => {
    const packageRoot = path.join(destination, "node_modules", "openclaw");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};");
  };
  return { runtimeRoot, worker, startWorker, extract };
}

describe("asynchronous bundled runtime preparation", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries temporary rename failures: %s", (code) => {
    const failure = Object.assign(new Error("temporarily locked"), { code });
    const renameDirectory = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const wait = vi.fn();
    commitRuntimeArchive("staging", "runtime", renameDirectory, wait);
    expect(renameDirectory).toHaveBeenCalledTimes(2);
    expect(renameDirectory).toHaveBeenCalledWith("staging", "runtime");
    expect(wait).toHaveBeenCalledExactlyOnceWith(100);
  });

  it("bounds rename retries and preserves the final error", () => {
    const failure = Object.assign(new Error("still locked"), { code: "EPERM" });
    const renameDirectory = vi.fn(() => {
      throw failure;
    });
    const wait = vi.fn();
    expect(() => commitRuntimeArchive("staging", "runtime", renameDirectory, wait)).toThrow(
      failure,
    );
    expect(renameDirectory).toHaveBeenCalledTimes(11);
    expect(wait).toHaveBeenCalledTimes(10);
    expect(wait.mock.calls.flat().reduce((total, milliseconds) => total + milliseconds, 0)).toBe(
      5500,
    );
  });

  it("does not retry unrelated rename failures", () => {
    const failure = Object.assign(new Error("missing directory"), { code: "ENOENT" });
    const renameDirectory = vi.fn(() => {
      throw failure;
    });
    const wait = vi.fn();
    expect(() => commitRuntimeArchive("staging", "runtime", renameDirectory, wait)).toThrow(
      failure,
    );
    expect(renameDirectory).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reuses a current cache without starting a worker", async () => {
    const { runtimeRoot, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract);
    await expect(
      materializeRuntimeArchiveAsync("archive", runtimeRoot, "current", startWorker),
    ).resolves.toBe(runtimeRoot);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it("keeps the event loop responsive and waits for a verified worker result", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    let completed = false;
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    ).then((result) => {
      completed = true;
      return result;
    });
    expect(startWorker).toHaveBeenCalledWith({
      archivePath: "archive",
      runtimeRoot,
      version: "current",
    });
    await setImmediate();
    expect(completed).toBe(false);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract);
    worker.emit("exit", 0);
    await expect(preparation).resolves.toBe(runtimeRoot);
  });

  it("propagates worker errors without discarding the previous runtime", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    const preparation = materializeRuntimeArchiveAsync("archive", runtimeRoot, "next", startWorker);
    const assertion = expect(preparation).rejects.toThrow("disk full");
    worker.emit("error", new Error("disk full"));
    worker.emit("exit", 1);
    await assertion;
    expect(fs.readFileSync(path.join(runtimeRoot, ".microclaw-version"), "utf8").trim()).toBe(
      "previous",
    );
  });

  it("rejects abnormal worker exits", async () => {
    const { runtimeRoot, worker, startWorker } = fixture();
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    );
    const assertion = expect(preparation).rejects.toThrow("exited with code 7");
    worker.emit("exit", 7);
    await assertion;
  });

  it("rejects a clean exit with a missing or stale result", async () => {
    const { runtimeRoot, worker, startWorker, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    const preparation = materializeRuntimeArchiveAsync(
      "archive",
      runtimeRoot,
      "current",
      startWorker,
    );
    const assertion = expect(preparation).rejects.toThrow("did not produce a valid runtime");
    worker.emit("exit", 0);
    await assertion;
  });

  it("rejects worker construction failures", async () => {
    const { runtimeRoot } = fixture();
    await expect(
      materializeRuntimeArchiveAsync("archive", runtimeRoot, "current", () => {
        throw new Error("worker unavailable");
      }),
    ).rejects.toThrow("worker unavailable");
  });

  it("cleans failed staging without changing a previous cache", () => {
    const { runtimeRoot, extract } = fixture();
    materializeRuntimeArchive("archive", runtimeRoot, "previous", extract);
    expect(() =>
      materializeRuntimeArchive("archive", runtimeRoot, "current", (_archive, stagingRoot) => {
        fs.mkdirSync(stagingRoot, { recursive: true });
        fs.writeFileSync(path.join(stagingRoot, "partial"), "incomplete");
        throw new Error("disk full");
      }),
    ).toThrow("Failed to prepare");
    expect(fs.existsSync(`${runtimeRoot}.staging-${process.pid}`)).toBe(false);
    expect(fs.readFileSync(path.join(runtimeRoot, ".microclaw-version"), "utf8").trim()).toBe(
      "previous",
    );
  });
});
