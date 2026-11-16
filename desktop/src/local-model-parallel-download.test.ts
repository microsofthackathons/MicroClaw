import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The native Gateway preload is an external ESM module.
import * as compatibility from "./openclaw-local-model-compat.mjs";

const {
  fetchModelScopeWithRanges,
  patchLocalModelPlugin,
  modelScopeModelUrl,
  modelScopeDownloadPolicy,
} = compatibility;
const url = modelScopeModelUrl(compatibility.MICROCLAW_LOCAL_MODEL_SOURCES.models[0]);
type Request = {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  policy?: unknown;
  requireHttps?: boolean;
};
function fixture(mode = "valid", latency = 2, length = 61) {
  const bytes = Buffer.from(Array.from({ length }, (_, index) => index % 251));
  const controller = new AbortController();
  const progress = vi.fn();
  let active = 0;
  let maximumActive = 0;
  const releases = vi.fn();
  const fetcher = vi.fn(async (request: Request) => {
    const header = new Headers(request.init?.headers).get("range");
    active++;
    maximumActive = Math.max(active, maximumActive);
    const release = vi.fn(async () => {
      if (release.mock.calls.length === 1) {
        active--;
        releases();
      }
    });
    if (!header) {
      let offset = 0;
      const body = new ReadableStream(
        {
          async pull(stream) {
            await delay(latency);
            if (request.signal?.aborted) throw request.signal.reason;
            const end = offset === 0 ? Math.min(4, bytes.length) : bytes.length;
            stream.enqueue(bytes.subarray(offset, end));
            offset = end;
            if (offset === bytes.length) stream.close();
          },
        },
        { highWaterMark: 0 },
      );
      return { response: new Response(body, { headers: { etag: '"fixture-v1"' } }), release };
    }
    if (mode === "unsupported") return { response: new Response(bytes), release };
    if (mode === "rate-limit") return { response: new Response(null, { status: 429 }), release };
    if (mode === "rejected") return { response: new Response(null, { status: 416 }), release };
    const match = header.match(/^bytes=(\d+)-(\d+)$/)!;
    const start = Number(match[1]),
      end = Number(match[2]);
    const probe = start === end;
    const data =
      mode === "short" && !probe ? bytes.subarray(start, end) : bytes.subarray(start, end + 1);
    const body = new ReadableStream({
      async pull(stream) {
        await delay(latency);
        if (request.signal?.aborted) throw request.signal.reason;
        stream.enqueue(mode === "oversized" && !probe ? Buffer.concat([data, Buffer.of(0)]) : data);
        stream.close();
      },
    });
    return {
      response: new Response(body, {
        status: mode === "ignored-part" && !probe ? 200 : 206,
        headers: {
          "content-range": `bytes ${mode === "wrong-range" && !probe ? start + 1 : start}-${end}/${bytes.length}`,
          etag: '"fixture-v1"',
          ...(mode === "encoded" && !probe ? { "content-encoding": "gzip" } : {}),
        },
      }),
      release,
    };
  });
  const request = {
    url,
    signal: controller.signal,
    timeoutMs: 5000,
    policy: { hostnameAllowlist: ["modelscope.cn", "*.modelscope.cn"] },
    requireHttps: true,
  };
  const params = {
    expectedSize: bytes.length,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    onProgress: progress,
  };
  const open = () =>
    fetchModelScopeWithRanges(fetcher, request, params, {
      minimumBytes: 1,
      chunkBytes: 8,
      concurrency: 3,
      warmupBytes: 1,
      warmupMs: 0,
      fastBytesPerSecond: Number.MAX_SAFE_INTEGER,
    });
  return {
    bytes,
    controller,
    fetcher,
    releases,
    progress,
    request,
    params,
    open,
    active: () => active,
    peak: () => maximumActive,
  };
}

describe("bounded model range prefetch", () => {
  it("reassembles exact bytes while keeping request concurrency and policies bounded", async () => {
    const env = fixture();
    const result = await env.open();
    try {
      expect(Buffer.from(await result.response.arrayBuffer())).toEqual(env.bytes);
    } finally {
      await result.release();
    }
    expect(env.peak()).toBe(3);
    expect(env.active()).toBe(0);
    expect(env.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadedSize: env.bytes.length, totalSize: env.bytes.length }),
    );
    expect(result.response.headers.get("content-length")).toBe(String(env.bytes.length));
    expect(result.response.headers.has("content-range")).toBe(false);
    expect(
      env.fetcher.mock.calls.every(
        ([request]) => request.requireHttps && request.policy === env.request.policy,
      ),
    ).toBe(true);
    expect(
      env.fetcher.mock.calls
        .slice(1)
        .every(
          ([request]) => new Headers(request.init?.headers).get("if-range") === '"fixture-v1"',
        ),
    ).toBe(true);
  });

  it("continues the existing response when the server ignores the range probe", async () => {
    const env = fixture("unsupported");
    env.request.timeoutMs = 300_000;
    const result = await env.open();
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(env.bytes);
    await result.release();
    expect(env.fetcher).toHaveBeenCalledTimes(2);
    expect(env.fetcher.mock.calls[0][0]).toMatchObject({ timeoutMs: 300_000 });
    expect(env.active()).toBe(0);
  });

  it("continues the original stream without restarting when the probe returns 416", async () => {
    const env = fixture("rejected");
    const result = await env.open();
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(env.bytes);
    await result.release();
    expect(env.fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(env.fetcher.mock.calls[1][0].init?.headers).get("range")).toBe("bytes=4-4");
    expect(env.active()).toBe(0);
  });

  it("does not retry or fan out a rate-limited range probe", async () => {
    const env = fixture("rate-limit");
    const result = await env.open();
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(env.bytes);
    await result.release();
    expect(env.fetcher).toHaveBeenCalledTimes(2);
    expect(env.active()).toBe(0);
  });

  it.each(["wrong-range", "short", "oversized", "ignored-part", "encoded"])(
    "rejects %s parts and releases every response",
    async (mode) => {
      const env = fixture(mode);
      const result = await env.open();
      await expect(result.response.arrayBuffer()).rejects.toThrow();
      await result.release();
      expect(env.active()).toBe(0);
      expect(
        env.fetcher.mock.calls
          .slice(1)
          .every(([request]) => new Headers(request.init?.headers).has("range")),
      ).toBe(true);
    },
  );

  it("aborts every worker on cancellation and emits no late progress", async () => {
    const env = fixture("valid", 30);
    const result = await env.open();
    const body = result.response.arrayBuffer();
    void body.catch(() => {});
    await vi.waitFor(() => expect(env.fetcher.mock.calls.length).toBeGreaterThan(2));
    env.controller.abort();
    const updates = env.progress.mock.calls.length;
    await expect(body).rejects.toThrow();
    await result.release();
    expect(env.active()).toBe(0);
    expect(env.progress).toHaveBeenCalledTimes(updates);
  });

  it("bounds prefetch even when the file writer stops consuming", async () => {
    const env = fixture("valid", 2, 1024);
    const result = await env.open();
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.read();
    await delay(50);
    expect(env.fetcher.mock.calls.length).toBeLessThanOrEqual(2 + 1 + 3 * 2);
    expect(env.peak()).toBeLessThanOrEqual(3);
    await reader.cancel();
    await result.release();
    expect(env.active()).toBe(0);
  });

  it("keeps a fast source on a single request", async () => {
    const env = fixture();
    const result = await fetchModelScopeWithRanges(env.fetcher, env.request, env.params, {
      minimumBytes: 1,
      chunkBytes: 8,
      warmupBytes: 1,
      warmupMs: 0,
      fastBytesPerSecond: 1,
    });
    expect(Buffer.from(await result.response.arrayBuffer())).toEqual(env.bytes);
    await result.release();
    expect(env.fetcher).toHaveBeenCalledOnce();
    expect(env.active()).toBe(0);
  });

  it("leaves small files, unpinned data and other download sources on the existing path", async () => {
    const env = fixture();
    for (const [request, params] of [
      [env.request, env.params],
      [env.request, { ...env.params, expectedSha256: undefined }],
      [
        { ...env.request, url: "https://github.com/runtime.zip" },
        { ...env.params, expectedSize: 64 * 1024 * 1024 },
      ],
    ]) {
      const fetcher = vi.fn(async () => ({
        response: new Response("single stream"),
        release: async () => {},
      }));
      const result = await fetchModelScopeWithRanges(fetcher, request, params);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(request);
      expect(await result.response.text()).toBe("single stream");
      await result.release();
    }
  });
});

describe("parallel ranges through the pinned verified downloader", () => {
  const directory = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
  it.skipIf(!directory).each(["valid", "wrong-hash", "cancelled"])(
    "retains native integrity and partial cleanup: %s",
    async (mode) => {
      const original = readFileSync(path.join(directory!, "dist/index.js"), "utf8");
      const patched = patchLocalModelPlugin(original);
      const start = patched.indexOf("async function downloadVerifiedFile(");
      const end = patched.indexOf("async function runServerCommand(", start);
      const code = patched
        .slice(start, end)
        .replace('await import("openclaw/plugin-sdk/ssrf-runtime")', "ssrfRuntime")
        .replace("async function fetchModelScopeWithRanges(", "async function unusedRangeFetcher(");
      const bytes = Buffer.alloc(33 * 1024 * 1024, 17);
      bytes.write("GGUF");
      const controller = new AbortController();
      const fetcher = vi.fn(async (request: Request) => {
        const header = new Headers(request.init?.headers).get("range");
        if (!header) {
          let offset = 0;
          return {
            response: new Response(
              new ReadableStream(
                {
                  pull(stream) {
                    const end = offset === 0 ? 1024 : bytes.length;
                    stream.enqueue(bytes.subarray(offset, end));
                    offset = end;
                    if (offset === bytes.length) stream.close();
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
            release: async () => {},
          };
        }
        const range = header.match(/^bytes=(\d+)-(\d+)$/)!;
        const start = Number(range[1]),
          end = Number(range[2]);
        return {
          response: new Response(bytes.subarray(start, end + 1), {
            status: 206,
            headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
          }),
          release: async () => {},
        };
      });
      const remembered = vi.fn();
      const download = new Function(
        "fs",
        "path",
        "randomUUID",
        "createHash",
        "rememberVerifiedFile",
        "readResponseSha256",
        "DOWNLOAD_TIMEOUT_MS",
        "ssrfRuntime",
        "modelScopeDownloadPolicy",
        "rangeFetcher",
        `${code}\nasync function fetchModelScopeWithRanges(fetcher, request, params) {
          return rangeFetcher(fetcher, request, params, { minimumBytes: 1, warmupBytes: 1, warmupMs: 0, fastBytesPerSecond: Number.MAX_SAFE_INTEGER });
        }\nreturn downloadVerifiedFile;`,
      )(
        fs,
        path,
        randomUUID,
        createHash,
        remembered,
        vi.fn(),
        5000,
        { fetchWithSsrFGuard: fetcher, ssrfPolicyFromHttpBaseUrlAllowedOrigin: () => ({}) },
        modelScopeDownloadPolicy,
        fetchModelScopeWithRanges,
      );
      const parent = realpathSync(tmpdir());
      const root = await fs.mkdtemp(path.join(parent, "microclaw-parallel-model-"));
      const destination = path.join(root, "model.gguf");
      try {
        await fs.writeFile(destination, "previous verified model");
        const operation = download({
          url,
          destination,
          expectedSize: bytes.length,
          expectedSha256:
            mode === "wrong-hash"
              ? "0".repeat(64)
              : createHash("sha256").update(bytes).digest("hex"),
          signal: controller.signal,
          onProgress: () => {
            if (mode === "cancelled") controller.abort();
          },
        });
        if (mode === "valid") {
          await operation;
          expect((await fs.readFile(destination)).equals(bytes)).toBe(true);
          expect(remembered).toHaveBeenCalledOnce();
        } else {
          await expect(operation).rejects.toThrow(
            mode === "wrong-hash" ? /SHA-256 mismatch/ : /abort/i,
          );
          expect(await fs.readFile(destination, "utf8")).toBe("previous verified model");
          expect(remembered).not.toHaveBeenCalled();
        }
        expect(await fs.readdir(root)).toEqual(["model.gguf"]);
        expect(readFileSync(path.join(directory!, "dist/index.js"), "utf8")).toBe(original);
      } finally {
        expect(path.dirname(path.resolve(root))).toBe(parent);
        expect(path.basename(root).startsWith("microclaw-parallel-model-")).toBe(true);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
