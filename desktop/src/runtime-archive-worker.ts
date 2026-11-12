import { parentPort, workerData } from "node:worker_threads";
import { materializeRuntimeArchiveParallel, type RuntimeArchiveRequest } from "./runtime-archive";
import { RuntimePreparationTiming } from "./runtime-preparation-timing";

const { archivePath, runtimeRoot, version, timing } = workerData as RuntimeArchiveRequest;
if (timing) parentPort?.postMessage({ type: "runtime-preparation-ready" });
void materializeRuntimeArchiveParallel(
  archivePath,
  runtimeRoot,
  version,
  undefined,
  timing
    ? new RuntimePreparationTiming("worker", (message) => {
        parentPort?.postMessage({ type: "runtime-preparation-timing", message });
      })
    : undefined,
).catch((error) => {
  // Preserve the Worker's error event for failures from asynchronous extraction.
  queueMicrotask(() => {
    throw error;
  });
});
