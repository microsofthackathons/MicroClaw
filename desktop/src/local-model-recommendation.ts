import { LOCAL_MODEL_PRESETS, type LocalModelCatalogEntry } from "./local-model-catalog";
import type { LocalModelHardware } from "./local-model-types";

export type LocalModelFit = "fits" | "memory" | "gpu-memory" | "acceleration" | "unknown";

export interface LocalModelRecommendation {
  modelRef?: string;
  reason: "cpu" | "resources" | "limited" | "unknown";
  fit: Record<string, LocalModelFit>;
}

const GIB = 1024 ** 3;

export function recommendLocalModel(
  catalog: LocalModelCatalogEntry[],
  hardware: LocalModelHardware | null,
): LocalModelRecommendation {
  const fit: Record<string, LocalModelFit> = {};
  if (
    !hardware ||
    !Number.isFinite(hardware.totalMemoryBytes) ||
    !Number.isFinite(hardware.availableMemoryBytes) ||
    hardware.totalMemoryBytes <= 0 ||
    hardware.availableMemoryBytes < 0 ||
    hardware.availableMemoryBytes > hardware.totalMemoryBytes
  ) {
    return { reason: "unknown", fit };
  }
  const systemBudget = Math.min(
    hardware.availableMemoryBytes,
    Math.max(0, hardware.totalMemoryBytes - Math.max(2 * GIB, hardware.totalMemoryBytes * 0.25)),
  );
  const gpuBudget = Math.max(
    0,
    ...hardware.gpus.map((gpu) =>
      Number.isFinite(gpu.totalMemoryBytes) &&
      Number.isFinite(gpu.availableMemoryBytes) &&
      gpu.totalMemoryBytes > 0 &&
      gpu.availableMemoryBytes >= 0 &&
      gpu.availableMemoryBytes <= gpu.totalMemoryBytes
        ? Math.min(
            gpu.availableMemoryBytes,
            gpu.totalMemoryBytes - Math.max(GIB, gpu.totalMemoryBytes * 0.1),
          )
        : 0,
    ),
  );
  for (const entry of catalog) {
    const preset = LOCAL_MODEL_PRESETS.find((model) => model.modelRef === entry.modelRef);
    fit[entry.modelRef] = !preset
      ? "unknown"
      : hardware.totalMemoryBytes < preset.minimumSystemGiB * GIB ||
          systemBudget < preset.memoryGiB * GIB
        ? "memory"
        : preset.requiresAcceleration && hardware.accelerator === "cpu"
          ? "acceleration"
          : hardware.accelerator === "cuda" && gpuBudget < preset.memoryGiB * GIB
            ? "gpu-memory"
            : "fits";
  }
  const eligible = LOCAL_MODEL_PRESETS.filter((preset) => fit[preset.modelRef] === "fits").sort(
    (first, second) =>
      hardware.accelerator === "cpu"
        ? first.memoryGiB - second.memoryGiB
        : second.memoryGiB - first.memoryGiB,
  );
  return {
    ...(eligible[0] ? { modelRef: eligible[0].modelRef } : {}),
    reason: eligible.length ? (hardware.accelerator === "cpu" ? "cpu" : "resources") : "limited",
    fit,
  };
}
