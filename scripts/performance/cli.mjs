import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { builtInScenarioIds, SCENARIOS } from "./results.mjs";
import { runPerformance } from "./runner.mjs";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function parseOptions(args, environment = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      scenario: { type: "string" },
      samples: { type: "string" },
      profile: { type: "string", default: "fixed-response" },
      app: { type: "string" },
      installer: { type: "string" },
      baseline: { type: "string" },
      output: { type: "string" },
      "install-fixture": { type: "string" },
      "timeout-ms": { type: "string" },
      "setup-timeout-ms": { type: "string" },
      "first-launch-timeout-ms": { type: "string" },
      "install-timeout-ms": { type: "string" },
      model: { type: "string" },
      endpoint: { type: "string" },
      "api-key-env": { type: "string" },
      "max-model-requests": { type: "string" },
    },
  });
  if (values.help) return { help: true };
  const mode = positionals[0] ?? "report";
  if (positionals.length > 1 || !["report", "compare"].includes(mode))
    throw new Error("Command must be report or compare");
  if (mode === "report" && values.baseline) throw new Error("--baseline requires compare mode");
  const scenarios = [
    ...new Set(
      (values.scenario ?? "all")
        .split(",")
        .flatMap((id) => (id === "all" ? builtInScenarioIds() : [id])),
    ),
  ];
  if (scenarios.some((id) => !SCENARIOS[id]))
    throw new Error(`Unknown scenario; use all or ${Object.keys(SCENARIOS).join(",")}`);
  if (!["fixed-response", "real-model"].includes(values.profile))
    throw new Error("Unknown execution profile");
  const positive = (text, fallback, name) => {
    const value = Number(text ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const samples = positive(values.samples, 3, "samples");
  const desktop = scenarios.some((id) => id !== "install.clean");
  const real = values.profile === "real-model" && desktop;
  if (
    real &&
    (!values.model || !values.endpoint || !values.samples || !values["max-model-requests"])
  ) {
    throw new Error(
      "real-model requires explicit --model, --endpoint, --samples and --max-model-requests (including normal application warmup/title calls)",
    );
  }
  let apiKey;
  if (real) {
    const endpoint = new URL(values.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
        ))
    ) {
      throw new Error(
        "Model endpoint must be HTTPS or loopback HTTP without embedded credentials/query/fragment",
      );
    }
    if (!values["api-key-env"] || !environment[values["api-key-env"]])
      throw new Error(
        "--api-key-env must name a populated environment variable; do not put keys in command arguments",
      );
    apiKey = environment[values["api-key-env"]];
  }
  const resolve = (value) => (value ? path.resolve(ROOT, value) : null);
  return {
    root: ROOT,
    mode,
    scenarios,
    samples,
    profile: values.profile,
    app: resolve(values.app),
    installer: resolve(values.installer),
    baseline: resolve(values.baseline),
    installFixture: resolve(values["install-fixture"]),
    output: resolve(values.output) ?? path.join(ROOT, "build", "performance"),
    model: values.model ?? "perf-fixed",
    endpoint: real ? values.endpoint : null,
    apiKey,
    apiKeyEnv: values["api-key-env"] ?? null,
    maxRequests: positive(
      values["max-model-requests"],
      Math.max(100, samples * scenarios.length * 10),
      "max-model-requests",
    ),
    timeoutMs: positive(values["timeout-ms"], 120000, "timeout-ms"),
    setupTimeoutMs: positive(values["setup-timeout-ms"], 600000, "setup-timeout-ms"),
    firstLaunchTimeoutMs: positive(
      values["first-launch-timeout-ms"],
      600000,
      "first-launch-timeout-ms",
    ),
    installTimeoutMs: positive(values["install-timeout-ms"], 1800000, "install-timeout-ms"),
  };
}

const HELP = `MicroClaw scenario performance runner

  npm run perf -- report --app "<packaged MicroClawDesktop.exe>" --scenario all --samples 3
  npm run perf -- compare --app "<packaged MicroClawDesktop.exe>" --baseline "<results.json>"

Scenarios: all (default), ${Object.keys(SCENARIOS).join(", ")}.
Built-in suite: ${builtInScenarioIds().join(", ")}; newly registered built-in cases are included automatically.
External-fixture scenarios require explicit selection; install.clean requires a disposable VM adapter.
Profiles: fixed-response (default); real-model requires --model, --endpoint (OpenAI chat-completions base URL),
  --api-key-env, explicit --samples and --max-model-requests, including normal startup/title requests.
Clean install requires --installer and --install-fixture pointing at an explicitly disposable VM adapter.
Options: --output <directory>, --timeout-ms <milliseconds> (default 120000),
  --setup-timeout-ms <milliseconds> (unmeasured initial launch; default 600000), --install-timeout-ms <milliseconds>.
  --first-launch-timeout-ms <milliseconds> (measured fresh-profile startup; default 600000).
Paths resolve relative to the repository, not the current shell directory. Nothing is built, fetched or installed automatically.
Missing prerequisites produce an unavailable report. Exit codes: 0 fully measured, 1 incomplete/failure, 2 invalid command, 130 interrupted.
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const { output, result } = await runPerformance({ ...options, signal: controller.signal });
      console.log(
        `Coverage: ${result.summary.coverage}\nReport: ${path.join(output, "report.md")}\nResults: ${path.join(output, "results.json")}`,
      );
      process.exitCode = controller.signal.aborted
        ? 130
        : result.summary.coverage === "measured"
          ? 0
          : 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
