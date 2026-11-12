import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FIXED_PROMPT, FIXED_TEXT } from "./model-service.mjs";
import { collectStartupTiming } from "./startup.mjs";

export class UnavailableError extends Error {}

export async function readLifecycle(fixture) {
  try {
    return (
      await readFile(
        path.join(fixture.root, "userData", "diagnostics", "electron-lifecycle.jsonl"),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export class DesktopDriver {
  constructor(options, fixture, electron, { isProcessAlive = alive } = {}) {
    this.options = options;
    this.fixture = fixture;
    this.electron = electron;
    this.isProcessAlive = isProcessAlive;
    this.application = null;
    this.mainProcessId = null;
    this.usedSessions = new Set();
    this.chatPreparation = null;
  }

  static async create(options, fixture) {
    let electron;
    try {
      ({ _electron: electron } = await import("playwright"));
    } catch {
      throw new UnavailableError("Playwright is missing; run npm install at the repository root");
    }
    return new DesktopDriver(options, fixture, electron);
  }

  async launch({ timeoutMs = this.options.timeoutMs } = {}) {
    this.application = await this.electron.launch({
      executablePath: this.options.app,
      env: this.fixture.environment,
      timeout: timeoutMs,
    });
    this.mainProcessId = await this.application.evaluate(() => process.pid);
    if (!Number.isInteger(this.mainProcessId) || this.mainProcessId <= 0) {
      throw new Error("Electron did not return a valid main-process PID");
    }
    const child = this.application.process();
    child.stdout?.resume();
    child.stderr?.resume();
    this.page = await this.application.firstWindow({ timeout: timeoutMs });
    await this.page.waitForFunction(() => Boolean(window.__microclawPerf), null, {
      timeout: timeoutMs,
    });
    const probeVersion = await this.page.evaluate(() => window.__microclawPerf.version);
    if (probeVersion !== 2)
      throw new UnavailableError(
        "Performance probe v2 is required; this app uses an older test contract",
      );
    await this.page.waitForFunction(() => window.__microclawPerf.ready().ready, null, {
      timeout: timeoutMs,
    });
    return this.page.evaluate(() => window.__microclawPerf.ready());
  }

  async shutdown(preparedRecords) {
    if (!this.application) return;
    const application = this.application;
    const mainProcessId = this.mainProcessId;
    const child = application.process();
    const records = preparedRecords ?? (await readLifecycle(this.fixture));
    const epochStart = records.findLastIndex(
      (record) => record.event === "main-process-start" && record.processId === this.mainProcessId,
    );
    const gatewayPids = new Set(
      records
        .slice(epochStart < 0 ? records.length : epochStart)
        .map((record) => record.gatewayPid)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    this.lastShutdown = {
      mainProcessId,
      epochObserved: epochStart >= 0,
      gateways: records
        .slice(epochStart < 0 ? records.length : epochStart)
        .filter((record) => record.event === "gateway-spawned"),
    };
    const started = performance.now();
    await application.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    while (
      (child.exitCode === null && child.signalCode === null) ||
      (Number.isInteger(mainProcessId) && this.isProcessAlive(mainProcessId)) ||
      [...gatewayPids].some(this.isProcessAlive)
    ) {
      if (performance.now() - started > this.options.timeoutMs) {
        throw new Error("Timed out waiting for the owned desktop/Gateway to exit normally");
      }
      await delay(25);
    }
    this.lastShutdown.exitCode = child.exitCode;
    this.lastShutdown.signal = child.signalCode;
    this.application = null;
    this.mainProcessId = null;
    return performance.now();
  }

  async restart() {
    const previousRecords = await readLifecycle(this.fixture);
    const started = performance.now();
    const stopped = await this.shutdown(previousRecords);
    const launching = performance.now();
    const readiness = await this.launch();
    const completed = performance.now();
    const records = await readLifecycle(this.fixture);
    const epochStart = records.findLastIndex(
      (record) => record.event === "main-process-start" && record.processId === this.mainProcessId,
    );
    const startupRecords = records.slice(epochStart < 0 ? records.length : epochStart);
    const summary = startupRecords.filter((record) => record.event === "startup-summary").at(-1);
    const shutdownRecords = records.slice(
      previousRecords.length,
      epochStart < 0 ? records.length : epochStart,
    );
    const forced = shutdownRecords.some(
      (record) =>
        record.event === "gateway-stop-force-fallback" ||
        (record.event === "gateway-stop-complete" && record.mode === "forced"),
    );
    const uncleanShutdown =
      this.lastShutdown.exitCode !== 0 ||
      this.lastShutdown.signal !== null ||
      shutdownRecords.some(
        (record) =>
          record.event === "gateway-stop-failed" ||
          (record.event === "gateway-stop-complete" &&
            (record.exitCode !== 0 || record.signal !== null)),
      );
    const sameGateway = (expected, observed) =>
      expected.gatewayPid === observed.gatewayPid &&
      expected.gatewayGeneration === observed.gatewayGeneration;
    const validGateway = (record) =>
      Number.isInteger(record.gatewayPid) &&
      record.gatewayPid > 0 &&
      typeof record.gatewayGeneration === "string" &&
      Boolean(record.gatewayGeneration.trim());
    const stoppedGateways = this.lastShutdown.gateways;
    const shutdownObserved =
      this.lastShutdown.epochObserved &&
      stoppedGateways.length > 0 &&
      stoppedGateways.every(
        (gateway) =>
          validGateway(gateway) &&
          shutdownRecords.some(
            (record) =>
              record.event === "gateway-stop-requested" &&
              record.mode === "graceful" &&
              sameGateway(gateway, record),
          ) &&
          shutdownRecords.some(
            (record) =>
              record.event === "gateway-stop-complete" &&
              sameGateway(gateway, record) &&
              record.mode === "graceful" &&
              record.exitCode === 0 &&
              record.signal === null,
          ),
      );
    const spawned = startupRecords.filter((record) => record.event === "gateway-spawned");
    const startupObserved =
      epochStart >= previousRecords.length &&
      this.mainProcessId !== this.lastShutdown.mainProcessId &&
      this.isProcessAlive(this.mainProcessId) &&
      summary?.mode === "spawned" &&
      spawned.length > 0 &&
      spawned.every(
        (gateway) =>
          validGateway(gateway) &&
          !stoppedGateways.some((previous) => previous.gatewayPid === gateway.gatewayPid),
      ) &&
      this.isProcessAlive(spawned.at(-1).gatewayPid);
    const complete = startupObserved && shutdownObserved && !forced && !uncleanShutdown;
    const metrics = {
      totalMs: completed - started,
      shutdownMs: stopped - started,
      launchToChatReadyMs: completed - launching,
    };
    if (summary) {
      for (const key of [
        "appBeforeAttemptMs",
        "microclawPreflightMs",
        "openclawHttpMs",
        "integrationMs",
      ]) {
        metrics[`stage.${key}`] = Number.isFinite(summary[key]) ? summary[key] : null;
      }
    }
    return {
      outcome: complete ? "success" : "incomplete-restart",
      metrics,
      readiness,
      gatewayMode: summary?.mode ?? "unknown",
      shutdown: { ...this.lastShutdown, receiptsObserved: shutdownObserved },
      startup: { mainProcessId: this.mainProcessId, gateways: spawned, observed: startupObserved },
      startupTiming: collectStartupTiming(records, this.mainProcessId),
      failure: complete
        ? null
        : {
            classification: forced
              ? "forced-shutdown"
              : uncleanShutdown
                ? "unclean-shutdown"
                : !shutdownObserved
                  ? "shutdown-not-observed"
                  : "gateway-not-spawned",
            message:
              "A normal full restart requires clean graceful shutdown and an observed newly spawned Gateway",
          },
    };
  }

  async firstLaunch() {
    if (this.application || (await readLifecycle(this.fixture)).length)
      throw new Error("First launch requires an unused fixture with no previous process epoch");
    const started = performance.now();
    const readiness = await this.launch({ timeoutMs: this.options.firstLaunchTimeoutMs });
    const completed = performance.now();
    const records = await readLifecycle(this.fixture);
    const startupTiming = collectStartupTiming(records, this.mainProcessId);
    const summary = startupTiming.summaries.at(-1);
    const spawned = records.filter((event) => event.event === "gateway-spawned");
    const observed =
      summary?.mode === "spawned" &&
      this.isProcessAlive(this.mainProcessId) &&
      spawned.some(
        (event) =>
          Number.isInteger(event.gatewayPid) &&
          event.gatewayPid > 0 &&
          event.gatewayGeneration === summary.gatewayGeneration &&
          this.isProcessAlive(event.gatewayPid),
      );
    return {
      outcome: observed ? "success" : "incomplete-startup",
      metrics: { totalMs: completed - started },
      readiness,
      startupTiming,
      failure: observed
        ? null
        : {
            classification: "startup-not-observed",
            message: "First launch requires timing v2 and an observed newly spawned Gateway",
          },
    };
  }

  async startupTiming() {
    return collectStartupTiming(await readLifecycle(this.fixture), this.mainProcessId);
  }

  async waitForSession() {
    await this.page.waitForFunction(
      () => {
        const snapshot = window.__microclawPerf.snapshot();
        return Boolean(snapshot && (snapshot.outcome || snapshot.metrics.sessionReadyMs !== null));
      },
      null,
      { timeout: this.options.timeoutMs },
    );
    return this.page.evaluate(() => window.__microclawPerf.snapshot());
  }

  async completeChat() {
    const composer = this.page.locator(".chat-view textarea");
    await composer.fill(FIXED_PROMPT, { timeout: this.options.timeoutMs });
    await this.page.evaluate(() => window.__microclawPerf.armSend());
    await composer.press("Enter", { timeout: this.options.timeoutMs });
    await this.page.waitForFunction(
      () => Boolean(window.__microclawPerf.snapshot()?.outcome),
      null,
      { timeout: this.options.timeoutMs },
    );
    const result = await this.page.evaluate(() => window.__microclawPerf.snapshot());
    if (result.outcome === "success" && this.options.profile === "fixed-response") {
      if (result.responseText !== FIXED_TEXT) result.outcome = "unexpected-response";
    }
    if (result.outcome !== "success")
      result.failure = {
        classification: result.outcome,
        message: `Chat ended with ${result.outcome}`,
      };
    return result;
  }

  async chat() {
    this.chatPreparation = null;
    const initial = await this.page.evaluate(() => window.__microclawPerf.state());
    if (initial.messageCount === 0) {
      await this.page.evaluate(() => window.__microclawPerf.beginExisting());
      try {
        const prepared = await this.waitForSession();
        this.chatPreparation = prepared.outcome ? prepared : await this.completeChat();
      } catch (error) {
        this.chatPreparation = await this.snapshot();
        await this.page.evaluate(() => window.__microclawPerf.reset());
        throw error;
      }
      await this.page.evaluate(() => window.__microclawPerf.reset());
      if (this.chatPreparation.outcome !== "success")
        return {
          outcome: "preparation-failed",
          metrics: {},
          preparation: this.chatPreparation,
          failure: {
            classification: "preparation-failed",
            message: "Unmeasured chat preparation failed",
          },
        };
    }
    const previous = await this.page.evaluate(() => window.__microclawPerf.state());
    await this.page.evaluate(() => window.__microclawPerf.arm());
    await this.page.locator(".sp-create-btn").click({ timeout: this.options.timeoutMs });
    const before = await this.waitForSession();
    const state = await this.page.evaluate(() => window.__microclawPerf.state());
    if (
      before.outcome ||
      !before.sessionKey ||
      !before.emptySessionVerified ||
      before.previousSessionKey !== previous.sessionKey ||
      before.sessionKey === previous.sessionKey ||
      state.sessionKey !== before.sessionKey ||
      state.messageCount !== 0 ||
      this.usedSessions.has(before.sessionKey)
    )
      throw new Error("New-conversation action did not produce a different unused empty session");
    this.usedSessions.add(before.sessionKey);
    return { ...(await this.completeChat()), preparation: this.chatPreparation };
  }

  async snapshot() {
    if (!this.application || this.page?.isClosed()) return null;
    return this.page.evaluate(() => window.__microclawPerf?.snapshot() ?? null).catch(() => null);
  }

  async close() {
    try {
      await this.shutdown();
    } catch (error) {
      const child = this.application?.process();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      throw error;
    }
  }
}
