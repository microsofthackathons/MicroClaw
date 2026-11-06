import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalModelHardware } from "./local-model-types";

export function parseLocalModelGpus(output: string): LocalModelHardware["gpus"] {
  return output
    .trim()
    .split(/\r?\n/u)
    .slice(0, 32)
    .flatMap((line) => {
      const fields = line.split(",").map((field) => field.trim());
      if (fields.length < 3) return [];
      const total = fields.at(-2)!;
      const available = fields.at(-1)!;
      const name = fields.slice(0, -2).join(", ");
      const totalMemoryBytes = Number(total) * 1024 ** 2;
      const availableMemoryBytes = Number(available) * 1024 ** 2;
      if (
        !name ||
        !total ||
        !available ||
        !Number.isFinite(totalMemoryBytes) ||
        !Number.isFinite(availableMemoryBytes) ||
        totalMemoryBytes <= 0 ||
        availableMemoryBytes < 0 ||
        availableMemoryBytes > totalMemoryBytes
      )
        return [];
      return [{ name, totalMemoryBytes, availableMemoryBytes }];
    });
}

async function readGpus(): Promise<LocalModelHardware["gpus"]> {
  const candidates =
    os.platform() === "win32"
      ? [
          path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"),
          path.join(
            process.env.ProgramFiles || "C:\\Program Files",
            "NVIDIA Corporation",
            "NVSMI",
            "nvidia-smi.exe",
          ),
        ]
      : ["/usr/bin/nvidia-smi", "/bin/nvidia-smi"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) return [];
  return new Promise((resolve) => {
    execFile(
      executable,
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 2000, maxBuffer: 16_384, encoding: "utf8" },
      (error, stdout) => resolve(error ? [] : parseLocalModelGpus(stdout)),
    );
  });
}

export async function readLocalModelHardware(): Promise<LocalModelHardware> {
  const totalMemoryBytes = os.totalmem();
  const availableMemoryBytes = Math.min(totalMemoryBytes, Math.max(0, os.freemem()));
  const metal = os.platform() === "darwin" && os.arch() === "arm64";
  const gpus = metal ? [] : await readGpus();
  return {
    cpu: os.cpus()[0]?.model.trim() || "",
    totalMemoryBytes,
    availableMemoryBytes,
    accelerator: metal ? "metal" : gpus.length ? "cuda" : "cpu",
    gpus,
  };
}
