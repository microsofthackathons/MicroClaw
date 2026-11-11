import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCENARIOS, compare, emptyMetrics, renderReport, summarize } from "./results.mjs";
import { createFixture, sanitizeError } from "./fixtures.mjs";
import { DesktopDriver, UnavailableError, readLifecycle } from "./desktop.mjs";
import { collectArtifact, collectEnvironment, collectSource, inspectFile } from "./provenance.mjs";
import { startModelService } from "./model-service.mjs";
import { runInstall, validateInstallFixture } from "./install.mjs";

export async function runPerformance(options) {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = path.join(options.output, runId);
  await mkdir(options.output, { recursive: true });
  await mkdir(output);
  const source = await collectSource(options.root);
  try {
    source.artifact = await collectArtifact(options.app);
  } catch (error) {
    source.artifact = {
      available: false,
      sourceAssociation: "unknown",
      reason: sanitizeError(error),
    };
  }
  const environment = await collectEnvironment();
  const scenarios = options.scenarios.map((id) => ({
    id,
    ...SCENARIOS[id],
    profile: id === "install.clean" ? "installer" : options.profile,
    packaging: id === "install.clean" ? "installed" : "packaged",
    fixture:
      id === "install.clean"
        ? { version: 2, imageId: null, vmId: null }
        : {
            version: 2,
            promptVersion: 1,
            model: options.model,
            provider:
              options.profile === "fixed-response" ? "local-deterministic" : options.endpoint,
            inference: {
              contextWindow: 32768,
              maxTokens: 256,
              temperature: "provider-default",
              localModelArtifact: null,
            },
            toolPolicy: "deny-all",
            streamingCadenceMs: options.profile === "fixed-response" ? 20 : null,
            warmup:
              id === "app.first-launch"
                ? "none; first desktop launch is measured"
                : "normal-startup-and-optional-ui-chat-preparation; outside scenario timing; included in model request budget",
            modelRequestBudget: options.maxRequests,
          },
    cachePolicy:
      id === "install.clean"
        ? "restore-vm-before-each-sample"
        : id === "app.first-launch"
          ? "fresh-isolated-profile-per-sample; OS-cache-uncontrolled"
          : "retained-disk-caches-after-unmeasured-initial-launch",
    requestedSamples: options.samples,
  }));
  const result = {
    schemaVersion: 1,
    mode: options.mode,
    runId,
    startedAt,
    finishedAt: null,
    source,
    environment,
    scenarios,
    samples: [],
    limitations: [
      "Binary/source association is unknown unless separately established by a trusted build pipeline. Current source fingerprints are not attributed to an existing binary.",
      "UI timings observe DOM visibility after paint opportunities, not a physical screen presentation timestamp. Automation/observer scheduling adds measurement overhead.",
      "app.first-launch measures the first launch of each fresh isolated profile, including runtime preparation; it is not an OS cold boot or a post-installer VM launch. Other desktop scenarios exclude initial fixture startup. All proxy requests count toward the shared model request budget.",
      "GPU identity, provider output token counts and internal model-runtime stages are unavailable. Real-model networking and inference are uncontrolled sources of variation.",
      "Synthetic fixture has no personal sessions, plugins or bundled skills enabled; it is not a measurement of a user's populated profile.",
    ],
  };
  let activeDriver = null;
  const interrupt = () => {
    void activeDriver?.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  const secrets = [options.apiKey];
  const budget = { remaining: options.maxRequests };
  try {
    for (const scenario of scenarios) {
      let driver = null;
      let modelService = null;
      let fixture = null;
      let installFixture = null;
      let unavailable = options.signal?.aborted ? "Run cancelled before scenario setup" : null;
      let setupError = null;
      try {
        if (!unavailable && scenario.id === "install.clean") {
          if (!options.installFixture || !options.installer)
            unavailable =
              "--installer and a disposable VM adapter via --install-fixture are required; host installation is never attempted";
          else {
            source.installer = {
              sha256: (await inspectFile(options.installer)).sha256,
              sourceAssociation: "unknown",
            };
            installFixture = validateInstallFixture(
              JSON.parse(await readFile(options.installFixture, "utf8")),
            );
            scenario.fixture = {
              version: 2,
              imageId: installFixture.imageId,
              vmId: installFixture.vmId,
              prerequisites: installFixture.prerequisites ?? "unknown",
            };
          }
        } else if (!unavailable) {
          if (!source.artifact.available) unavailable = source.artifact.reason;
          else {
            modelService = await startModelService({
              profile: options.profile,
              model: options.model,
              endpoint: options.endpoint,
              apiKey: options.apiKey,
              maxRequests: options.maxRequests,
              budget,
            });
            if (scenario.id !== "app.first-launch") {
              fixture = await createFixture(path.join(output, `fixture-${scenario.id}`), {
                baseUrl: modelService.baseUrl,
                model: options.model,
                secretEnvironmentKeys: [options.apiKeyEnv],
              });
              secrets.push(fixture.token);
              driver = await DesktopDriver.create(options, fixture);
              activeDriver = driver;
              const setupStarted = performance.now();
              try {
                await driver.launch({ timeoutMs: options.setupTimeoutMs });
              } finally {
                await writeFile(
                  path.join(output, `${scenario.id}.setup.json`),
                  JSON.stringify(
                    {
                      elapsedMs: performance.now() - setupStarted,
                      boundary: "unmeasured-initial-launch",
                      timeoutMs: options.setupTimeoutMs,
                    },
                    null,
                    2,
                  ),
                );
              }
            }
          }
        }
      } catch (error) {
        unavailable = sanitizeError(error, secrets);
        setupError = error instanceof UnavailableError ? "driver-unavailable" : "setup-failed";
      }
      try {
        let priorFailure = false;
        for (let index = 0; index < options.samples; index++) {
          const sampleId = `${scenario.id}-${index + 1}`;
          const sample = {
            scenarioId: scenario.id,
            sampleId,
            outcome: "unavailable",
            metrics: emptyMetrics(scenario.id),
            elapsedMs: null,
            evidence: [],
            failure: null,
          };
          if (unavailable || priorFailure || options.signal?.aborted) {
            sample.outcome = priorFailure || options.signal?.aborted ? "skipped" : "unavailable";
            sample.failure = {
              classification:
                setupError ?? (priorFailure ? "fixture-not-ready" : "prerequisite-missing"),
              message:
                unavailable ??
                (priorFailure
                  ? "Previous attempt failed; no automatic retry or fixture mutation"
                  : "Run cancelled"),
            };
          } else {
            const started = performance.now();
            try {
              if (scenario.id === "app.first-launch") {
                fixture = await createFixture(path.join(output, `fixture-${sampleId}`), {
                  baseUrl: modelService.baseUrl,
                  model: options.model,
                  secretEnvironmentKeys: [options.apiKeyEnv],
                });
                secrets.push(fixture.token);
                driver = await DesktopDriver.create(options, fixture);
                activeDriver = driver;
              }
              const observed =
                scenario.id === "install.clean"
                  ? await runInstall(installFixture, {
                      runId,
                      sampleId,
                      output,
                      installer: options.installer,
                      timeoutMs: options.installTimeoutMs,
                      signal: options.signal,
                    })
                  : scenario.id === "app.restart"
                    ? await driver.restart()
                    : scenario.id === "app.first-launch"
                      ? await driver.firstLaunch()
                      : await driver.chat();
              Object.assign(sample, observed);
              if (!sample.failure && sample.outcome !== "success")
                sample.failure = {
                  classification: sample.outcome,
                  message: `Scenario ended with ${sample.outcome}`,
                };
              if (
                sample.outcome === "success" &&
                Object.keys(scenario.endpoints).some(
                  (metric) =>
                    !Number.isFinite(sample.metrics[metric]) || sample.metrics[metric] < 0,
                )
              ) {
                throw new Error("Scenario reported success without all required metric endpoints");
              }
            } catch (error) {
              const partial = scenario.id === "chat.new-session" ? await driver.snapshot() : null;
              if (partial) sample.metrics = partial.metrics;
              if (scenario.id === "chat.new-session") sample.preparation = driver.chatPreparation;
              sample.outcome = options.signal?.aborted
                ? "cancelled"
                : /timeout|timed out/i.test(String(error))
                  ? "timeout"
                  : "failed";
              sample.failure = {
                classification: sample.outcome,
                message: sanitizeError(error, secrets),
              };
              if (driver && scenario.id !== "chat.new-session")
                sample.startupTiming = await driver.startupTiming();
            } finally {
              // Capture measured time before cleanup, which is not first-launch latency.
              sample.elapsedMs ??= performance.now() - started;
              if (scenario.id === "app.first-launch" && fixture) {
                try {
                  await driver?.close();
                } catch (error) {
                  sample.cleanupFailure = sanitizeError(error, secrets);
                  result.limitations.push(`Owned fixture cleanup: ${sample.cleanupFailure}`);
                }
                const lifecyclePath = `${sampleId}.lifecycle.json`;
                await writeFile(
                  path.join(output, lifecyclePath),
                  sanitizeErrorFreeJson(await readLifecycle(fixture), secrets),
                );
                sample.evidence.push(lifecyclePath);
                driver = null;
                activeDriver = null;
                fixture = null;
              }
            }
            priorFailure = sample.outcome !== "success" || Boolean(sample.cleanupFailure);
          }
          const evidencePath = `${sampleId}.json`;
          sample.evidence.push(evidencePath);
          await writeFile(path.join(output, evidencePath), JSON.stringify(sample, null, 2));
          result.samples.push(sample);
        }
      } finally {
        if (driver) {
          try {
            await driver.close();
          } catch (error) {
            result.limitations.push(`Owned fixture cleanup: ${sanitizeError(error, secrets)}`);
          }
        }
        if (fixture) {
          const lifecyclePath = `${scenario.id}.lifecycle.json`;
          await writeFile(
            path.join(output, lifecyclePath),
            sanitizeErrorFreeJson(await readLifecycle(fixture), secrets),
          );
          for (const sample of result.samples.filter((entry) => entry.scenarioId === scenario.id))
            sample.evidence.push(lifecyclePath);
        }
        if (modelService) {
          await modelService.close();
          const modelPath = `${scenario.id}.model-requests.json`;
          await writeFile(
            path.join(output, modelPath),
            JSON.stringify(modelService.requests, null, 2),
          );
          for (const sample of result.samples.filter((entry) => entry.scenarioId === scenario.id))
            sample.evidence.push(modelPath);
        }
        activeDriver = null;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    result.finishedAt = new Date().toISOString();
    result.summary = summarize(scenarios, result.samples);
    for (const sample of result.samples) {
      await writeFile(
        path.join(output, `${sample.sampleId}.json`),
        JSON.stringify(sample, null, 2),
      );
    }
    if (options.mode === "compare") {
      let baseline;
      try {
        baseline = JSON.parse(await readFile(options.baseline, "utf8"));
      } catch {
        baseline = null;
      }
      result.baseline = compare(result, baseline);
    }
    await writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2));
    await writeFile(path.join(output, "report.md"), renderReport(result));
  }
  return { output, result };
}

function sanitizeErrorFreeJson(value, secrets) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "string" ? sanitizeError(item, secrets) : item),
    2,
  );
}
