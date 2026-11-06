import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const request = JSON.parse(await readFile(args[args.indexOf("--request") + 1], "utf8"));
await writeFile(
  args[args.indexOf("--result") + 1],
  JSON.stringify({
    schemaVersion: 1,
    runId: request.runId,
    sampleId: request.sampleId,
    outcome: "success",
    restored: true,
    clean: true,
    serviceReady: true,
    finalValidation: true,
    elapsedMs: 123,
    metrics: { totalMs: 123, "stage.installation": 100 },
    evidence: [],
  }),
);
