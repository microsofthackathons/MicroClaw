import { workerData } from "node:worker_threads";
import { materializeRuntimeArchive, type RuntimeArchiveRequest } from "./runtime-archive";

const { archivePath, runtimeRoot, version } = workerData as RuntimeArchiveRequest;
materializeRuntimeArchive(archivePath, runtimeRoot, version);
