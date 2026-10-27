import type { LocalModelStep } from "../../../src/local-model-types";

export interface ManagedDownloadProgress {
  stage: "chat" | "embedding" | "runtime";
  percent: number;
  downloadedGB: string;
  totalGB: string;
  speedMBps: number;
}

const DOWNLOAD_PROGRESS =
  /^Downloading (.{1,160}?)(?:…|\.{3})\s*(\d{1,3})% \((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) GB, (\d+(?:\.\d+)?) MB\/s\)$/u;

export function parseManagedDownloadProgress(
  message: string | undefined,
  modelName: string | undefined,
): ManagedDownloadProgress | null {
  if (!message || message.length > 512) return null;
  const match = DOWNLOAD_PROGRESS.exec(message);
  if (!match) return null;
  const [, label, percentText, downloadedGB, totalGB, speedText] = match;
  const stage =
    label === modelName
      ? "chat"
      : label === "EmbeddingGemma" || label === "configured embedding model"
        ? "embedding"
        : label === "llama.cpp runtime"
          ? "runtime"
          : null;
  const percent = Number(percentText);
  const speedMBps = Number(speedText);
  const downloaded = Number(downloadedGB);
  const total = Number(totalGB);
  if (
    !stage ||
    ![percent, speedMBps, downloaded, total].every(Number.isFinite) ||
    percent > 100 ||
    total <= 0 ||
    downloaded > total
  ) {
    return null;
  }
  return { stage, percent, downloadedGB, totalGB, speedMBps };
}

export interface ManagedDownloadSummary {
  modelName: string;
  downloadGB: number;
  backend: "cpu" | "gpu";
}

const TOOL_CHECK = "OpenClaw will check a real tool call before making this your default model.";
const SIZE = "\\d+(?:\\.\\d{1,2})?";
const DOWNLOAD = new RegExp(
  `^Download (.{1,120}) \\((${SIZE}) GB\\), the local embedding model \\(about (${SIZE}) GB\\), and the verified (CPU|CUDA|METAL) runtime, then use this model\\?$`,
);
const MEMORY = new RegExp(`^${SIZE} GiB RAM; ${SIZE} GiB free disk\\.$`);
const RUNTIME_DISK = new RegExp(`^${SIZE} GiB free on the runtime volume\\.$`);
const BUDGET = new RegExp(
  `^${SIZE} GiB [A-Za-z -]{1,60} budget with a 64K context\\. Runtime verification checks the actual model before activation\\.$`,
);

/** Display only: unknown or extended consent text must stay visible, never drive the wizard. */
export function summarizeManagedDownload(
  step: LocalModelStep | undefined,
  managedPreparation: boolean,
): ManagedDownloadSummary | null {
  if (
    !managedPreparation ||
    step?.type !== "confirm" ||
    step.sensitive ||
    step.title?.trim() ||
    step.options?.length ||
    step.executor === "gateway" ||
    !step.message
  ) {
    return null;
  }
  const paragraphs = step.message.trim().split(/\r?\n\r?\n/);
  if (paragraphs.length !== 2) return null;
  const match = DOWNLOAD.exec(paragraphs[1]);
  if (!match) return null;
  const [, fullName, modelSize, embeddingSize, runtime] = match;
  const lines = paragraphs[0].split(/\r?\n/);
  const host =
    /^Runs on Gateway host [^\s()]{1,255} \((?:win32|darwin|linux)\/(?:x64|arm64)\), using (the CPU|NVIDIA CUDA|Apple Metal)\.$/.exec(
      lines[0],
    );
  if (!host || !MEMORY.test(lines[1] ?? "") || lines.at(-1) !== TOOL_CHECK) return null;
  const expectedHostBackend =
    runtime === "CPU" ? "the CPU" : runtime === "CUDA" ? "NVIDIA CUDA" : "Apple Metal";
  if (host[1] !== expectedHostBackend) return null;
  const remaining = lines.slice(2, -1);
  if (RUNTIME_DISK.test(remaining[0] ?? "")) remaining.shift();
  const prefix = `${fullName} fits the `;
  if (
    remaining.length !== 1 ||
    !remaining[0].startsWith(prefix) ||
    !BUDGET.test(remaining[0].slice(prefix.length))
  ) {
    return null;
  }
  const sizes = [Number(modelSize), Number(embeddingSize)];
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0 || size > 10_000)) return null;
  return {
    modelName: fullName.replace(/\s+\((?:UD-)?Q\d[A-Z0-9_-]*\)$/i, ""),
    downloadGB: Math.round((sizes[0] + sizes[1]) * 10) / 10,
    backend: runtime === "CPU" ? "cpu" : "gpu",
  };
}
