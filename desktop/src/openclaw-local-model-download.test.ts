import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error External ESM preload runs in the supported Gateway runtime.
import * as compatibility from "./openclaw-local-model-compat.mjs";

const { cacheIsolatedGitHubAssetUrl, downloadWithOfficialGitHubRetry, patchLocalModelPlugin } =
  compatibility;
const releaseUrl =
  "https://github.com/ggml-org/llama.cpp/releases/download/b10809/llama-b10809-bin-win-cpu-x64.zip";
const responseUrl =
  "https://release-assets.githubusercontent.com/github-production-release-asset/612354784/8af0753e-12f3-4442-8a8b-81c63c3385ec?signature=unchanged";
const params = { url: releaseUrl, expectedSha256: "a".repeat(64), destination: "fixture.zip" };

describe("official runtime download retry", () => {
  it("isolates only the cache key while preserving the official asset and signature", () => {
    const isolated = new URL(cacheIsolatedGitHubAssetUrl(responseUrl));
    const original = new URL(responseUrl);
    expect(isolated.origin).toBe(original.origin);
    expect(decodeURIComponent(isolated.pathname)).toBe(original.pathname);
    expect(isolated.search).toBe(original.search);
    expect(isolated.pathname).toContain("/%38af0753e-");
    expect(cacheIsolatedGitHubAssetUrl(isolated.href)).toBeUndefined();
  });

  it.each([
    "https://example.com/github-production-release-asset/612354784/8af0753e-12f3-4442-8a8b-81c63c3385ec",
    responseUrl.replace("https:", "http:"),
    responseUrl.replace(".com/", ".com:8443/"),
    responseUrl.replace("https://", "https://user:password@"),
    responseUrl.replace("8af0753e-", "%38af0753e-"),
    responseUrl.replace("612354784/", "other/"),
    responseUrl.replace("8af0753e-", "invalid-"),
    "not a URL",
  ])("does not rewrite an untrusted or already encoded URL: %s", (url) => {
    expect(cacheIsolatedGitHubAssetUrl(url)).toBeUndefined();
  });

  it("does not retry a successful verified download", async () => {
    const download = vi.fn().mockResolvedValue("verified");
    expect(await downloadWithOfficialGitHubRetry(params, download)).toBe("verified");
    expect(download).toHaveBeenCalledOnce();
  });

  it.each(["SHA-256", "size"])(
    "retries a %s mismatch once with the same verification inputs",
    async (kind) => {
      const controller = new AbortController();
      const onProgress = vi.fn();
      const request = { ...params, signal: controller.signal, onProgress, expectedSize: 123 };
      const download = vi
        .fn()
        .mockImplementationOnce(async (input) => {
          input.onMicroclawResponse(responseUrl);
          throw new Error(`download ${kind} mismatch: expected pinned, got invalid`);
        })
        .mockResolvedValueOnce("verified");
      expect(await downloadWithOfficialGitHubRetry(request, download)).toBe("verified");
      expect(download).toHaveBeenCalledTimes(2);
      expect(download.mock.calls[1][0]).toEqual({
        ...request,
        url: cacheIsolatedGitHubAssetUrl(responseUrl),
      });
    },
  );

  it("does not keep retrying invalid content", async () => {
    const failure = new Error("download SHA-256 mismatch: expected pinned, got invalid");
    const download = vi.fn(async (input) => {
      input.onMicroclawResponse?.(responseUrl);
      throw failure;
    });
    await expect(downloadWithOfficialGitHubRetry(params, download)).rejects.toBe(failure);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it.each(["download failed: HTTP 403", "ENOSPC", "EPERM", "network unavailable"])(
    "does not retry a non-verification error: %s",
    async (message) => {
      const failure = new Error(message);
      const download = vi.fn(async (input) => {
        input.onMicroclawResponse(responseUrl);
        throw failure;
      });
      await expect(downloadWithOfficialGitHubRetry(params, download)).rejects.toBe(failure);
      expect(download).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "https://modelscope.cn/model.gguf",
    "https://huggingface.co/model.gguf",
    releaseUrl.replace("ggml-org", "another-owner"),
    releaseUrl.replace("https:", "http:"),
    releaseUrl.replace("https://", "https://user:password@"),
    `${releaseUrl}?other=asset`,
    `${releaseUrl}#fragment`,
    "not a URL",
  ])("does not retry other downloads: %s", async (url) => {
    const failure = new Error("download SHA-256 mismatch: invalid");
    const download = vi.fn(async (input) => {
      input.onMicroclawResponse?.(responseUrl);
      throw failure;
    });
    await expect(downloadWithOfficialGitHubRetry({ ...params, url }, download)).rejects.toBe(
      failure,
    );
    expect(download).toHaveBeenCalledExactlyOnceWith({ ...params, url });
  });

  it("does not retry a download without a pinned digest", async () => {
    const download = vi.fn().mockRejectedValue(new Error("download SHA-256 mismatch: invalid"));
    await expect(
      downloadWithOfficialGitHubRetry({ ...params, expectedSha256: undefined }, download),
    ).rejects.toThrow("mismatch");
    expect(download).toHaveBeenCalledOnce();
  });

  it("does not retry after cancellation", async () => {
    const controller = new AbortController();
    const failure = new Error("download SHA-256 mismatch: invalid");
    const download = vi.fn(async (input) => {
      input.onMicroclawResponse(responseUrl);
      controller.abort();
      throw failure;
    });
    await expect(
      downloadWithOfficialGitHubRetry({ ...params, signal: controller.signal }, download),
    ).rejects.toBe(failure);
    expect(download).toHaveBeenCalledOnce();
  });
});

describe("pinned provider runtime download", () => {
  const directory = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
  it.skipIf(!directory).each(["verified", "invalid", "cancelled"])(
    "keeps official verification and partial cleanup after a bad CDN response: %s",
    async (outcome) => {
      const source = readFileSync(path.join(directory!, "dist", "index.js"), "utf8");
      const patched = patchLocalModelPlugin(source);
      const start = patched.indexOf("async function downloadVerifiedFile(");
      const end = patched.indexOf("async function runServerCommand(", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const functionSource = patched
        .slice(start, end)
        .replace('await import("openclaw/plugin-sdk/ssrf-runtime")', "ssrfRuntime");
      const root = await fs.mkdtemp(path.join(tmpdir(), "microclaw-runtime-download-"));
      const destination = path.join(root, "runtime.zip");
      const bytes = Buffer.from("verified tiny archive fixture");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const controller = new AbortController();
      const release = vi.fn(async () => {});
      const fetchWithSsrFGuard = vi.fn(async () => {
        const first = fetchWithSsrFGuard.mock.calls.length === 1;
        const response = new Response(first || outcome === "invalid" ? "<BlockList/>" : bytes);
        Object.defineProperty(response, "url", {
          value: first ? responseUrl : cacheIsolatedGitHubAssetUrl(responseUrl),
        });
        return {
          response,
          release: async () => {
            await release();
            if (outcome === "cancelled") controller.abort();
          },
        };
      });
      const rememberVerifiedFile = vi.fn();
      const policy = vi.fn((url) => ({ origin: new URL(url).origin }));
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
        `${functionSource}; return downloadVerifiedFile;`,
      )(
        fs,
        path,
        randomUUID,
        createHash,
        rememberVerifiedFile,
        vi.fn(),
        1000,
        { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin: policy },
        compatibility.modelScopeDownloadPolicy,
      );
      try {
        await fs.writeFile(destination, "previous verified archive");
        const preparing = download({
          url: releaseUrl,
          destination,
          expectedSha256: digest,
          signal: controller.signal,
        });
        if (outcome === "verified") {
          await preparing;
          expect(await fs.readFile(destination)).toEqual(bytes);
          expect(rememberVerifiedFile).toHaveBeenCalledOnce();
          expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(2);
          expect(policy).toHaveBeenLastCalledWith(cacheIsolatedGitHubAssetUrl(responseUrl));
          expect(fetchWithSsrFGuard.mock.calls[1]).toEqual([
            expect.objectContaining({
              signal: controller.signal,
              requireHttps: true,
              policy: { origin: "https://release-assets.githubusercontent.com" },
            }),
          ]);
        } else {
          await expect(preparing).rejects.toThrow("SHA-256 mismatch");
          expect(await fs.readFile(destination, "utf8")).toBe("previous verified archive");
          expect(rememberVerifiedFile).not.toHaveBeenCalled();
          expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 2);
        }
        expect(await fs.readdir(root)).toEqual(["runtime.zip"]);
        expect(release).toHaveBeenCalledTimes(fetchWithSsrFGuard.mock.calls.length);
        expect(readFileSync(path.join(directory!, "dist", "index.js"), "utf8")).toBe(source);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
