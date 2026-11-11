import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const request = JSON.parse(await readFile(args[args.indexOf("--request") + 1], "utf8"));
const evidence = `${request.sampleId}.install-timing.log`;
await writeFile(
  path.join(path.dirname(args[args.indexOf("--result") + 1]), evidence),
  "MICROCLAW_INSTALL_TIMING " +
    JSON.stringify({
      schemaVersion: 2,
      runId: request.runId,
      sampleId: request.sampleId,
      stageId: "installation",
      phase: "installation-total",
      kind: "summary",
      status: "success",
      stepCount: 0,
      elapsedMs: 123,
      durationMs: 123,
      activeMs: 123,
      humanWaitMs: 0,
    }),
);
await writeFile(
  args[args.indexOf("--result") + 1],
  JSON.stringify({
    schemaVersion: 2,
    runId: request.runId,
    sampleId: request.sampleId,
    outcome: "success",
    restored: true,
    clean: true,
    installationComplete: true,
    finalValidation: true,
    elapsedMs: 123,
    metrics: { totalMs: 123, "stage.installation": 100 },
    evidence: [evidence],
  }),
);
