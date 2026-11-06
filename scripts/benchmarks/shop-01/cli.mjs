import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCapture, createSelfCheck, taskPackets } from "./fixtures.mjs";
import { evaluateCapture } from "./evaluate.mjs";
import { renderReport } from "./report.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELP = `SHOP-01 offline rule evaluator (no network, application launch, or model calls)

  npm run bench:shop -- prepare [--samples 5] [--output DIRECTORY]
  npm run bench:shop -- demo    [--samples 5] [--output DIRECTORY]
  npm run bench:shop -- score --input CAPTURE.json [--output DIRECTORY]

prepare: freeze the run plan and export replay task packets; real runs remain NOT_RUN.
demo: synthetic scorer self-check only; NEVER a MicroClaw capability result.
score: evaluate independently captured/normalized answers and auditor evidence.
Existing output files are never overwritten. Live and Phone E2E are not implemented.`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      samples: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help || positionals.length === 0) return { help: true };
  const mode = positionals[0];
  if (positionals.length !== 1 || !["prepare", "demo", "score"].includes(mode))
    throw new Error("Command must be prepare, demo, or score");
  if (mode === "score" && (!values.input || values.samples !== undefined))
    throw new Error("score requires --input and uses its frozen plan, not --samples");
  if (mode !== "score" && values.input !== undefined)
    throw new Error("--input is only valid for score");
  const samples = Number(values.samples ?? 5);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1000)
    throw new Error("--samples must be an integer from 1 to 1000");
  return {
    mode,
    samples,
    input: values.input ? path.resolve(values.input) : null,
    output: path.resolve(
      values.output ??
        path.join(
          ROOT,
          "build",
          "benchmarks",
          "shop-01",
          `${mode}-${new Date().toISOString().replaceAll(":", "-")}`,
        ),
    ),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeBundle(directory, files) {
  for (const name of Object.keys(files)) {
    const target = path.join(directory, name);
    try {
      await lstat(target);
      throw new Error(`Refusing to overwrite ${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(directory, name), content, { flag: "wx" });
}

export async function execute(options) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const captureText =
    options.mode === "score"
      ? await readFile(options.input, "utf8")
      : json(
          options.mode === "demo"
            ? createSelfCheck(options.samples)
            : createCapture(options.samples),
        );
  const result = evaluateCapture(JSON.parse(captureText));
  result.generatedAt = new Date().toISOString();
  result.provenance = {
    captureSha256: sha256(captureText),
    fixtureSha256: sha256(await readFile(new URL("./fixtures.mjs", import.meta.url))),
    scorerSha256: sha256(await readFile(new URL("./evaluate.mjs", import.meta.url))),
  };
  const files = { "results.json": json(result), "report.md": renderReport(result) };
  if (options.mode !== "score") files["capture.json"] = captureText;
  if (options.mode === "prepare") files["task-packets.json"] = json(taskPackets());
  await writeBundle(options.output, files);
  return { output: options.output, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const { output, result } = await execute(options);
      console.log(
        result.subject.kind !== "agent-capture"
          ? `SYNTHETIC ${result.subject.kind} ONLY — NOT A MICROCLAW CAPABILITY RESULT`
          : `Replay records: ${result.summary.recorded}; NOT_RUN: ${result.summary.notRun}`,
      );
      console.log(path.join(output, "report.md"));
    }
  } catch (error) {
    console.error(`SHOP-01: ${error.message}`);
    process.exitCode = 1;
  }
}
