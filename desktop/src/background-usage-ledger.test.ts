import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  copyFile,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundUsageLedger } from "./background-usage-ledger";

const now = Date.parse("2026-10-26T04:00:00Z");
const roots: string[] = [];
const logLine = JSON.stringify({
  "0": '{"capability":"runtime.llm"}',
  "1": {
    caller: { kind: "plugin", id: "memory-core" },
    provider: "qwen",
    model: "qwen3.8-27b",
    agentId: "main",
    executionMode: "isolated-agent-runtime",
    usage: { inputTokens: 466, outputTokens: 1592, totalTokens: 2058 },
    prompt: "private prompt 中文",
    apiKey: "sk-private",
  },
  "2": "plugin llm completion",
  time: "2026-10-26T03:00:33.386+08:00",
});

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(text = `${logLine}\n`) {
  const root = await mkdtemp(join(tmpdir(), "microclaw-usage-"));
  roots.push(root);
  const logs = join(root, "logs");
  await mkdir(logs);
  const log = join(logs, "openclaw-2026-10-26.log");
  await writeFile(log, text);
  await utimes(log, now / 1000, now / 1000);
  const storage = join(root, "usage", "background-requests.json");
  return { root, logs, log, storage, ledger: new BackgroundUsageLedger(storage) };
}

describe("persistent independent request ledger", () => {
  it("does not double count polling, concurrent requests, restart, or copied log rotation", async () => {
    const { ledger, log, storage, logs } = await fixture();
    const [first, concurrent] = await Promise.all([
      ledger.synchronize(log, now),
      ledger.synchronize(log, now),
    ]);
    expect(first).toHaveLength(1);
    expect(concurrent).toEqual(first);
    expect(await ledger.synchronize(log, now)).toEqual(first);
    await copyFile(log, join(logs, "openclaw-2026-10-26.1.log"));
    const restarted = new BackgroundUsageLedger(storage);
    expect(await restarted.synchronize(log, now)).toEqual(first);
    const saved = await readFile(storage, "utf8");
    expect(saved).not.toMatch(/private|apiKey|prompt/);
    expect(JSON.parse(saved).entries[0].totals.totalTokens).toBe(2058);
  });

  it("keeps distinct identical records and resumes an incomplete UTF-8 line", async () => {
    const { ledger, log } = await fixture(`${logLine}\n${logLine}`);
    expect(await ledger.synchronize(log, now)).toHaveLength(1);
    await appendFile(log, "\n");
    expect(await ledger.synchronize(log, now)).toHaveLength(2);
    await appendFile(log, `${logLine}\n`);
    expect(await ledger.synchronize(log, now)).toHaveLength(3);
  });

  it("backfills earlier rolling days but ignores unrelated logs", async () => {
    const { ledger, log, logs } = await fixture();
    const earlier = join(logs, "openclaw-2026-10-25.log");
    await writeFile(earlier, `${logLine.replace("2026-10-26T", "2026-10-25T")}\n`);
    await utimes(earlier, now / 1000, now / 1000);
    await writeFile(join(logs, "other-app.log"), `${logLine}\n${logLine}\n`);
    expect(await ledger.synchronize(log, now)).toHaveLength(2);
  });

  it("retains normalized history after source logs disappear", async () => {
    const { ledger, log, storage } = await fixture();
    await ledger.synchronize(log, now);
    await rm(log);
    expect(await new BackgroundUsageLedger(storage).readSnapshot()).toHaveLength(1);
  });

  it("retries a failed atomic write even when no new log bytes arrive", async () => {
    const { ledger, log, storage } = await fixture();
    await mkdir(`${storage}.tmp`, { recursive: true });
    await expect(ledger.synchronize(log, now)).rejects.toThrow();
    await rm(`${storage}.tmp`, { recursive: true });
    expect(await ledger.synchronize(log, now)).toHaveLength(1);
    expect(await new BackgroundUsageLedger(storage).readSnapshot()).toHaveLength(1);
  });

  it("does not overwrite a damaged ledger", async () => {
    const { ledger, log, storage } = await fixture();
    await mkdir(join(storage, ".."), { recursive: true });
    await writeFile(storage, "broken ledger");
    await expect(ledger.synchronize(log, now)).rejects.toThrow();
    expect(await readFile(storage, "utf8")).toBe("broken ledger");
  });

  it("ignores oversized log lines and keeps following accounting records", async () => {
    const { ledger, log } = await fixture(`${"x".repeat(300_000)}\n${logLine}\n`);
    expect(await ledger.synchronize(log, now)).toHaveLength(1);
  });

  it("does not parse the tail of an oversized partial line on the next refresh", async () => {
    const { ledger, log } = await fixture("x".repeat(300_000));
    expect(await ledger.synchronize(log, now)).toHaveLength(0);
    await appendFile(log, `${logLine}\n${logLine}\n`);
    expect(await ledger.synchronize(log, now)).toHaveLength(1);
  });

  it("prunes expired entries rather than retaining unbounded history", async () => {
    const { ledger, log, storage } = await fixture();
    await ledger.synchronize(log, now);
    expect(await ledger.synchronize(log, now + 91 * 86_400_000)).toHaveLength(0);
    expect(JSON.parse(await readFile(storage, "utf8")).entries).toHaveLength(0);
  });
});
