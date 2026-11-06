import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASES } from "./fixtures.mjs";
import { executeAdapter } from "./adapter.mjs";
import { validateEndpoint } from "./model-proxy.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELP = `SHOP-01 isolated MicroClaw Gateway execution adapter

  npm run bench:shop:run -- --profile smoke --cases S01 --samples 1
  npm run bench:shop:run -- --profile real-model --cases all --samples 5
    --model MODEL --endpoint https://PROVIDER/v1 --api-key-env SHOP_API_KEY --max-model-requests 550

Optional: --runtime-entry OPENCLAW.mjs --node NODE.exe --timeout-ms 600000 --max-output-tokens 4096
  --input-usd-per-million RATE --output-usd-per-million RATE --output NEW_DIRECTORY

smoke is SCRIPTED/SYNTHETIC, not a capability result. real-model requires explicit request budget,
sample count and API-key environment variable; no credentials are copied from your personal profile.
Only fixed read-only retailer tools are exposed. A fresh state is created for EVERY run.
Independent semantic/safety audit stays pending; Live, desktop UI and phone E2E are NOT_RUN.`;

function integer(value, fallback, maximum, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return number;
}

export function parseRunOptions(args, environment = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      profile: { type: "string" },
      cases: { type: "string" },
      samples: { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      "api-key-env": { type: "string" },
      "max-model-requests": { type: "string" },
      "runtime-entry": { type: "string" },
      node: { type: "string" },
      "timeout-ms": { type: "string" },
      "max-output-tokens": { type: "string" },
      output: { type: "string" },
      "input-usd-per-million": { type: "string" },
      "output-usd-per-million": { type: "string" },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length) throw new Error("Unexpected positional arguments");
  const profile = values.profile ?? "smoke";
  if (!["smoke", "real-model"].includes(profile))
    throw new Error("profile must be smoke or real-model");
  const real = profile === "real-model";
  if (
    real &&
    ["model", "endpoint", "api-key-env", "samples", "max-model-requests"].some(
      (key) => !values[key],
    )
  )
    throw new Error(
      "real-model requires explicit model, endpoint, api-key-env, samples and max-model-requests",
    );
  if (
    !real &&
    ["model", "endpoint", "api-key-env", "input-usd-per-million", "output-usd-per-million"].some(
      (key) => values[key] !== undefined,
    )
  )
    throw new Error(
      "Model, endpoint, credentials and price rates are only accepted for real-model",
    );
  const apiKey = real ? environment[values["api-key-env"]] : null;
  if (real && !apiKey?.trim()) throw new Error("Named API-key environment variable is empty");
  const caseIds =
    values.cases === "all" ? CASES.map((entry) => entry.id) : (values.cases ?? "S01").split(",");
  if (
    new Set(caseIds).size !== caseIds.length ||
    caseIds.some((id) => !CASES.some((entry) => entry.id === id))
  )
    throw new Error("Unknown or duplicate case IDs");
  const rateKeys = ["input-usd-per-million", "output-usd-per-million"];
  let rates = null;
  if (rateKeys.some((key) => values[key] !== undefined)) {
    if (
      rateKeys.some(
        (key) =>
          values[key] === undefined ||
          !values[key].trim() ||
          !Number.isFinite(Number(values[key])) ||
          Number(values[key]) < 0,
      )
    )
      throw new Error("Both nonnegative USD-per-million token rates are required");
    rates = { input: Number(values[rateKeys[0]]), output: Number(values[rateKeys[1]]) };
  }
  return {
    profile,
    caseIds,
    rates,
    apiKey,
    model: real ? values.model : "shop-scripted-smoke",
    endpoint: real ? validateEndpoint(values.endpoint) : null,
    samples: integer(values.samples, 1, 1000, "samples"),
    maxRequests: integer(values["max-model-requests"], 20, 100000, "max-model-requests"),
    maxTokens: integer(values["max-output-tokens"], 4096, 32768, "max-output-tokens"),
    timeoutMs: integer(values["timeout-ms"], 600000, 600000, "timeout-ms"),
    runtimeEntry: values["runtime-entry"] ? path.resolve(values["runtime-entry"]) : null,
    node: path.resolve(values.node ?? process.execPath),
    output: path.resolve(
      values.output ??
        path.join(
          ROOT,
          "build",
          "benchmarks",
          "shop-01",
          `adapter-${profile}-${new Date().toISOString().replaceAll(":", "-")}`,
        ),
    ),
  };
}

export async function discoverRuntime(environment = process.env) {
  const candidates = [
    environment.APPDATA &&
      path.join(
        environment.APPDATA,
        "MicroClaw",
        "runtime",
        "openclaw",
        "node_modules",
        "openclaw",
        "openclaw.mjs",
      ),
    path.join(ROOT, "desktop", "resources", "openclaw", "node_modules", "openclaw", "openclaw.mjs"),
    environment.USERPROFILE &&
      path.join(
        environment.USERPROFILE,
        ".openclaw-node",
        "node_modules",
        "openclaw",
        "openclaw.mjs",
      ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    "No extracted MicroClaw OpenClaw runtime found; supply --runtime-entry (no auto-install)",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRunOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      options.runtimeEntry ??= await discoverRuntime();
      options.onProgress = (runId) =>
        console.log(`Running ${runId} (${options.profile}); independent audit PENDING`);
      options.onStage = (runId, stage) => console.log(`[${runId}] ${stage}`);
      const capture = await executeAdapter(options);
      console.log(capture.subject.label);
      console.log(
        `Recorded ${capture.runs.length}/${capture.plan.caseIds.length * capture.plan.repetitions}; no automatic semantic/safety pass.`,
      );
      console.log(path.join(options.output, "report.md"));
      if (
        capture.runs.length !== capture.plan.caseIds.length * capture.plan.repetitions ||
        capture.runs.some((run) => run.status !== "completed")
      )
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`SHOP-01 adapter: ${error.message}`);
    process.exitCode = 1;
  }
}
