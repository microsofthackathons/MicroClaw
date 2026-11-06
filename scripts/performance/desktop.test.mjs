import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { runInNewContext } from "node:vm";
import { DesktopDriver } from "./desktop.mjs";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), await realpath(os.tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  }
});

async function createHarness(mainProcessIds = [10001, 10002]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "microclaw-perf-driver-"));
  roots.push(root);
  const diagnostics = path.join(root, "userData", "diagnostics");
  await mkdir(diagnostics, { recursive: true });
  const records = [];
  const launches = [];
  const windows = [];
  const waits = [];
  const readiness = { ready: true };
  const live = new Set();
  const controls = { keepMainAlive: false, omitStopReceipts: false, exitCode: 0, signal: null };
  const persist = () =>
    writeFile(
      path.join(diagnostics, "electron-lifecycle.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
  const electron = {
    async launch(options) {
      const mainProcessId = mainProcessIds[launches.length];
      const gatewayPid = controls.reuseGatewayPid ? 30001 : 30001 + launches.length;
      const gatewayGeneration = `generation-${launches.length}`;
      live.add(mainProcessId);
      live.add(gatewayPid);
      const child = { pid: 20001 + launches.length, exitCode: null, signalCode: null };
      launches.push(options);
      records.push({ event: "main-process-start", processId: mainProcessId });
      records.push({ event: "gateway-spawned", gatewayPid, gatewayGeneration });
      records.push({
        event: "startup-summary",
        mode: "spawned",
        microclawPreflightMs: 42,
      });
      await persist();
      let evaluations = 0;
      return {
        process: () => child,
        async evaluate(callback) {
          if (evaluations++ === 0) return mainProcessId;
          return callback({
            app: {
              quit: async () => {
                if (!controls.omitStopReceipts) {
                  const identity = {
                    gatewayPid,
                    gatewayGeneration: controls.stopGeneration ?? gatewayGeneration,
                  };
                  records.push({ event: "gateway-stop-requested", ...identity, mode: "graceful" });
                  records.push({
                    event: "gateway-stop-complete",
                    ...identity,
                    mode: "graceful",
                    exitCode: 0,
                    signal: null,
                  });
                }
                await persist();
                live.delete(gatewayPid);
                if (!controls.keepMainAlive) live.delete(mainProcessId);
                child.exitCode = controls.exitCode;
                child.signalCode = controls.signal;
              },
            },
          });
        },
        async firstWindow(options) {
          windows.push(options);
          return {
            async waitForFunction(_callback, _argument, options) {
              waits.push(options);
            },
            async evaluate(callback) {
              if (callback.toString().includes(".version")) return controls.probeVersion ?? 2;
              return readiness;
            },
          };
        },
      };
    },
  };
  const options = { app: "test-desktop.exe", timeoutMs: 2000 };
  const fixture = { root, environment: { PERFORMANCE_TEST: "1" } };
  return {
    driver: new DesktopDriver(options, fixture, electron, {
      isProcessAlive: (pid) => live.has(pid),
    }),
    records,
    launches,
    windows,
    waits,
    readiness,
    persist,
    live,
    controls,
  };
}

test("startup records Electron's main PID rather than its Windows shell wrapper", async () => {
  const harness = await createHarness();
  assert.deepEqual(await harness.driver.launch(), harness.readiness);
  assert.equal(harness.driver.mainProcessId, 10001);
  assert.equal(harness.driver.application.process().pid, 20001);
  await harness.driver.shutdown();
  assert.equal(harness.driver.application, null);
  assert.equal(harness.driver.mainProcessId, null);
});

test("the initial setup timeout does not leak into measured restart launches", async () => {
  const harness = await createHarness();
  await harness.driver.launch({ timeoutMs: 900000 });
  const result = await harness.driver.restart();
  assert.equal(result.outcome, "success");
  assert.equal(result.gatewayMode, "spawned");
  assert.equal(result.metrics["stage.microclawPreflightMs"], 42);
  assert.equal(harness.driver.mainProcessId, 10002);
  assert.deepEqual(
    harness.launches.map((options) => options.timeout),
    [900000, 2000],
  );
  assert.deepEqual(
    harness.windows.map((options) => options.timeout),
    [900000, 2000],
  );
  assert.deepEqual(
    harness.waits.map((options) => options.timeout),
    [900000, 900000, 2000, 2000],
  );
  await harness.driver.shutdown();
});

test("shutdown tracks the real main process's Gateway even after the wrapper exits", async () => {
  const harness = await createHarness();
  await harness.driver.launch();
  harness.records.push({ event: "gateway-spawned", gatewayPid: process.pid });
  harness.live.add(process.pid);
  await harness.persist();
  harness.driver.options.timeoutMs = 30;
  await assert.rejects(harness.driver.shutdown(), /owned desktop\/Gateway to exit normally/);
  assert.equal(harness.driver.application.process().exitCode, 0);
});

test("restart never credits a previous main process's startup summary", async () => {
  const harness = await createHarness();
  await harness.driver.launch();
  const originalLaunch = harness.driver.launch.bind(harness.driver);
  harness.driver.launch = async () => {
    const readiness = await originalLaunch();
    harness.records.pop();
    await harness.persist();
    return readiness;
  };
  const result = await harness.driver.restart();
  assert.equal(result.outcome, "incomplete-restart");
  assert.equal(result.failure.classification, "gateway-not-spawned");
  assert.equal(result.gatewayMode, "unknown");
  await harness.driver.shutdown();
});

for (const [description, stopRecord, classification] of [
  ["supervisor force fallback", { event: "gateway-stop-force-fallback" }, "forced-shutdown"],
  [
    "forced exit receipt without a fallback event",
    { event: "gateway-stop-complete", mode: "forced", exitCode: 1, signal: null },
    "forced-shutdown",
  ],
  [
    "Gateway's own shutdown watchdog exit",
    { event: "gateway-stop-complete", mode: "graceful", exitCode: 1, signal: null },
    "unclean-shutdown",
  ],
  [
    "signal exit during graceful shutdown",
    { event: "gateway-stop-complete", mode: "graceful", exitCode: null, signal: "SIGKILL" },
    "unclean-shutdown",
  ],
  ["failed stop observation", { event: "gateway-stop-failed" }, "unclean-shutdown"],
]) {
  test(`restart does not report success after ${description}`, async () => {
    const harness = await createHarness();
    await harness.driver.launch();
    const originalShutdown = harness.driver.shutdown.bind(harness.driver);
    harness.driver.shutdown = async (...args) => {
      const stopped = await originalShutdown(...args);
      harness.records.push(stopRecord);
      await harness.persist();
      return stopped;
    };
    const result = await harness.driver.restart();
    assert.equal(result.outcome, "incomplete-restart");
    assert.equal(result.failure.classification, classification);
    assert.equal(result.gatewayMode, "spawned");
    await harness.driver.shutdown();
  });
}

test("restart accepts an observed clean graceful Gateway exit", async () => {
  const harness = await createHarness();
  await harness.driver.launch();
  const originalShutdown = harness.driver.shutdown.bind(harness.driver);
  harness.driver.shutdown = async (...args) => {
    const stopped = await originalShutdown(...args);
    harness.records.push({
      event: "gateway-stop-complete",
      mode: "graceful",
      exitCode: 0,
      signal: null,
    });
    await harness.persist();
    return stopped;
  };
  const result = await harness.driver.restart();
  assert.equal(result.outcome, "success");
  assert.equal(result.failure, null);
  await harness.driver.shutdown();
});

for (const invalidPid of [undefined, 0, -1, "10001"]) {
  test(`invalid Electron main PID is rejected: ${String(invalidPid)}`, async () => {
    const harness = await createHarness([invalidPid]);
    await assert.rejects(harness.driver.launch(), /valid main-process PID/);
    await harness.driver.shutdown();
  });
}

test("restart never launches while the actual Electron main process is still alive", async () => {
  const harness = await createHarness();
  await harness.driver.launch();
  harness.controls.keepMainAlive = true;
  harness.driver.options.timeoutMs = 30;
  await assert.rejects(harness.driver.restart(), /owned desktop\/Gateway to exit normally/);
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.driver.application.process().exitCode, 0);
});

for (const [description, controls, classification] of [
  ["missing stop receipts", { omitStopReceipts: true }, "shutdown-not-observed"],
  ["receipt for a different generation", { stopGeneration: "unrelated" }, "shutdown-not-observed"],
  ["nonzero wrapper exit", { exitCode: 1 }, "unclean-shutdown"],
  ["wrapper signal", { exitCode: null, signal: "SIGKILL" }, "unclean-shutdown"],
  ["reuse of the old Gateway PID", { reuseGatewayPid: true }, "gateway-not-spawned"],
]) {
  test(`restart rejects ${description}`, async () => {
    const harness = await createHarness();
    Object.assign(harness.controls, controls);
    await harness.driver.launch();
    const result = await harness.driver.restart();
    assert.equal(result.outcome, "incomplete-restart");
    assert.equal(result.failure.classification, classification);
    await harness.driver.shutdown();
  });
}

test("restart cannot credit stale stop receipts before the exit request", async () => {
  const harness = await createHarness();
  await harness.driver.launch();
  harness.records.push(
    { event: "gateway-stop-requested", gatewayPid: 30001, gatewayGeneration: "generation-0" },
    {
      event: "gateway-stop-complete",
      gatewayPid: 30001,
      gatewayGeneration: "generation-0",
      mode: "graceful",
      exitCode: 0,
      signal: null,
    },
  );
  await harness.persist();
  harness.controls.omitStopReceipts = true;
  const result = await harness.driver.restart();
  assert.equal(result.failure.classification, "shutdown-not-observed");
  await harness.driver.shutdown();
});

test("restart rejects reuse of the old main-process PID", async () => {
  const harness = await createHarness([10001, 10001]);
  await harness.driver.launch();
  assert.equal((await harness.driver.restart()).outcome, "incomplete-restart");
  await harness.driver.shutdown();
});

test("old packaged probes are rejected instead of using the weaker contract", async () => {
  const harness = await createHarness();
  harness.controls.probeVersion = 1;
  await assert.rejects(harness.driver.launch(), /probe v2 is required/);
  await harness.driver.shutdown();
});

function chatHarness({
  initialCount = 1,
  reused = false,
  responseText = "MICROCLAW_PERF_OK",
  preparationOutcome = "success",
} = {}) {
  const driver = new DesktopDriver({ timeoutMs: 100, profile: "fixed-response" }, {}, null);
  const state = { sessionKey: "old", messageCount: initialCount, ready: true };
  const calls = [];
  let snapshot = null;
  let preparing = false;
  const probe = {
    state: () => ({ ...state }),
    snapshot: () => snapshot && { ...snapshot, metrics: { ...snapshot.metrics } },
    reset: () => {
      snapshot = null;
    },
    arm: () => {
      preparing = false;
      calls.push("arm");
    },
    beginExisting: () => {
      preparing = true;
      calls.push("prepare");
      snapshot = { sessionKey: state.sessionKey, outcome: null, metrics: { sessionReadyMs: 1 } };
    },
    armSend: () => calls.push("send"),
  };
  driver.application = {};
  driver.page = {
    isClosed: () => false,
    evaluate: async (callback) =>
      runInNewContext(`(${callback.toString()})()`, { window: { __microclawPerf: probe } }),
    waitForFunction: async (callback) => {
      if (!runInNewContext(`(${callback.toString()})()`, { window: { __microclawPerf: probe } }))
        throw new Error("Timed out waiting for session");
    },
    locator: (selector) => ({
      click: async () => {
        calls.push("click");
        const previousSessionKey = state.sessionKey;
        if (!reused) {
          state.sessionKey = "new";
          state.messageCount = 0;
        }
        snapshot = {
          sessionKey: state.sessionKey,
          previousSessionKey,
          emptySessionVerified: !reused,
          outcome: reused ? "session-not-new" : null,
          metrics: { sessionReadyMs: 1 },
        };
      },
      fill: async () => calls.push("fill"),
      press: async () => {
        state.messageCount = 2;
        snapshot = {
          ...snapshot,
          runId: "submitted-run",
          outcome: preparing ? preparationOutcome : "success",
          responseText: preparing ? "MICROCLAW_PERF_OK" : responseText,
          metrics: { totalMs: preparing ? 999 : 10, sessionReadyMs: 1 },
        };
      },
      allInnerTexts: async () => {
        throw new Error(`Unscoped DOM read: ${selector}`);
      },
    }),
  };
  return { driver, calls };
}

test("chat checks only the attributed response, not an old matching body", async () => {
  const { driver } = chatHarness({ responseText: "wrong answer" });
  assert.equal((await driver.chat()).outcome, "unexpected-response");
});

test("chat refuses reuse before submitting a measured request", async () => {
  const { driver, calls } = chatHarness({ reused: true });
  await assert.rejects(driver.chat(), /different unused empty session/);
  assert.equal(calls.includes("send"), false);
});

test("chat primes an empty fixture outside measured metrics and retains its evidence", async () => {
  const { driver, calls } = chatHarness({ initialCount: 0 });
  const result = await driver.chat();
  assert.equal(result.outcome, "success");
  assert.equal(result.metrics.totalMs, 10);
  assert.equal(result.preparation.metrics.totalMs, 999);
  assert.deepEqual(calls, ["prepare", "fill", "send", "arm", "click", "fill", "send"]);
});

test("failed preparation cannot be counted as a measured chat success", async () => {
  const { driver, calls } = chatHarness({ initialCount: 0, preparationOutcome: "model-error" });
  const result = await driver.chat();
  assert.equal(result.outcome, "preparation-failed");
  assert.deepEqual(result.metrics, {});
  assert.equal(result.preparation.outcome, "model-error");
  assert.equal(calls.includes("click"), false);
});
