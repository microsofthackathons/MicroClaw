import { parentPort, workerData } from "node:worker_threads";
import { materializeRuntimeArchive, type RuntimeArchiveRequest } from "./runtime-archive";
import { RuntimePreparationTiming } from "./runtime-preparation-timing";

const { archivePath, runtimeRoot, version, timing } = workerData as RuntimeArchiveRequest;
if (timing) parentPort?.postMessage({ type: "runtime-preparation-ready" });
materializeRuntimeArchive(
  archivePath,
  runtimeRoot,
  version,
  undefined,
  timing ? new RuntimePreparationTiming("worker") : undefined,
);
