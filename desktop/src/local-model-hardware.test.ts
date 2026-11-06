import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLocalModelGpus, readLocalModelHardware } from "./local-model-hardware";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:os", () => ({
  platform: vi.fn(() => "win32"),
  arch: vi.fn(() => "x64"),
  totalmem: vi.fn(() => 32 * 1024 ** 3),
  freemem: vi.fn(() => 20 * 1024 ** 3),
  cpus: vi.fn(() => [{ model: " Test processor " }]),
}));

describe("local model hardware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(os.platform).mockReturnValue("win32");
    vi.mocked(os.arch).mockReturnValue("x64");
    vi.mocked(os.freemem).mockReturnValue(20 * 1024 ** 3);
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads local memory and CPU without launching a shell or installing anything", async () => {
    expect(await readLocalModelHardware()).toEqual({
      cpu: "Test processor",
      totalMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 20 * 1024 ** 3,
      accelerator: "cpu",
      gpus: [],
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("queries a known NVIDIA utility with fixed read-only arguments and a deadline", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      callback(null, "NVIDIA Example, 16384, 12288\n");
      return {} as ChildProcess;
    });
    expect(await readLocalModelHardware()).toMatchObject({
      accelerator: "cuda",
      gpus: [
        {
          name: "NVIDIA Example",
          totalMemoryBytes: 16 * 1024 ** 3,
          availableMemoryBytes: 12 * 1024 ** 3,
        },
      ],
    });
    expect(execFile).toHaveBeenCalledWith(
      expect.stringContaining("nvidia-smi.exe"),
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      expect.objectContaining({ windowsHide: true, timeout: 2000, maxBuffer: 16_384 }),
      expect.any(Function),
    );
  });

  it("falls back to a CPU estimate when the GPU query fails or times out", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string) => void;
      callback(new Error("timeout"), "");
      return {} as ChildProcess;
    });
    expect(await readLocalModelHardware()).toMatchObject({ accelerator: "cpu", gpus: [] });
  });

  it("keeps shared-memory Apple silicon separate from dedicated NVIDIA VRAM", async () => {
    vi.mocked(os.platform).mockReturnValue("darwin");
    vi.mocked(os.arch).mockReturnValue("arm64");
    expect(await readLocalModelHardware()).toMatchObject({ accelerator: "metal", gpus: [] });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("bounds available memory by installed memory", async () => {
    vi.mocked(os.freemem).mockReturnValue(64 * 1024 ** 3);
    expect((await readLocalModelHardware()).availableMemoryBytes).toBe(32 * 1024 ** 3);
  });

  it("rejects malformed and unavailable GPU measurements", () => {
    expect(
      parseLocalModelGpus(
        "Example, [N/A], 1\nExample, 8, 10\nExample, 8, -1\nExample, 0, 0\nExample, 8,\n",
      ),
    ).toEqual([]);
    expect(parseLocalModelGpus("GPU, with comma, 8192, 4096")).toEqual([
      {
        name: "GPU, with comma",
        totalMemoryBytes: 8 * 1024 ** 3,
        availableMemoryBytes: 4 * 1024 ** 3,
      },
    ]);
  });
});
