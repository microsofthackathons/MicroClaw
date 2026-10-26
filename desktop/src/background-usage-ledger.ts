import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseBackgroundUsageLog,
  usageLogFingerprint,
  type BackgroundUsageEntry,
} from "./usage-accounting";

const RETENTION_MS = 90 * 86_400_000;
const MAX_LINE_BYTES = 256 * 1024;

interface LogCheckpoint {
  identity: string;
  offset: number;
  occurrences: Map<string, number>;
  discarded: boolean;
}

export class BackgroundUsageLedger {
  private entries = new Map<string, BackgroundUsageEntry>();
  private checkpoints = new Map<string, LogCheckpoint>();
  private loaded = false;
  private dirty = false;
  private pending: Promise<BackgroundUsageEntry[]> | null = null;

  constructor(private readonly filePath: string) {}

  synchronize(logFile: string, now = Date.now()): Promise<BackgroundUsageEntry[]> {
    if (this.pending) return this.pending;
    this.pending = this.importLogs(logFile, now).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  snapshot(): BackgroundUsageEntry[] {
    return [...this.entries.values()];
  }

  async readSnapshot(): Promise<BackgroundUsageEntry[]> {
    await this.load();
    return this.snapshot();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.entries))
        throw new Error("Invalid usage ledger");
      const loaded = new Map<string, BackgroundUsageEntry>();
      for (const entry of data.entries) {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          !/^[a-f0-9]{64}:\d+$/.test(entry.id) ||
          typeof entry.timestamp !== "string" ||
          !Number.isFinite(Date.parse(entry.timestamp)) ||
          !["memory", "background"].includes(entry.source) ||
          !entry.totals ||
          !["input", "output", "cacheRead", "cacheWrite", "totalTokens", "totalCost"].every(
            (key) =>
              typeof entry.totals[key] === "number" &&
              Number.isFinite(entry.totals[key]) &&
              entry.totals[key] >= 0,
          )
        )
          throw new Error("Invalid usage ledger entry");
        loaded.set(entry.id, entry);
      }
      this.entries = loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async importLogs(logFile: string, now: number): Promise<BackgroundUsageEntry[]> {
    await this.load();
    if (!path.isAbsolute(logFile)) throw new Error("Expected an absolute Gateway log path");
    const directory = path.dirname(logFile);
    const basename = path.basename(logFile);
    const rolling = /^openclaw-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(basename);
    const files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name === basename ||
            (rolling && /^openclaw-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(entry.name))),
      )
      .map((entry) => path.join(directory, entry.name));
    for (const file of files.sort()) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.mtimeMs < now - RETENTION_MS) continue;
      const identity = `${stat.dev}:${stat.ino}`;
      let checkpoint = this.checkpoints.get(file);
      if (!checkpoint || checkpoint.identity !== identity || stat.size < checkpoint.offset) {
        checkpoint = { identity, offset: 0, occurrences: new Map(), discarded: false };
        this.checkpoints.set(file, checkpoint);
      }
      if (stat.size === checkpoint.offset) continue;
      let pending = Buffer.alloc(0);
      const stream = createReadStream(file, { start: checkpoint.offset, end: stat.size - 1 });
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, chunk as Buffer]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline);
          checkpoint.offset += newline + 1;
          pending = pending.subarray(newline + 1);
          if (!checkpoint.discarded && line.length <= MAX_LINE_BYTES) {
            const text = line.toString("utf8").trim();
            const parsed = parseBackgroundUsageLog(text);
            if (parsed && Date.parse(parsed.timestamp) >= now - RETENTION_MS) {
              const fingerprint = usageLogFingerprint(text);
              const ordinal = (checkpoint.occurrences.get(fingerprint) ?? 0) + 1;
              checkpoint.occurrences.set(fingerprint, ordinal);
              const id = `${fingerprint}:${ordinal}`;
              if (!this.entries.has(id)) {
                this.entries.set(id, { id, ...parsed });
                this.dirty = true;
              }
            }
          }
          checkpoint.discarded = false;
        }
        if (pending.length > MAX_LINE_BYTES) {
          checkpoint.offset += pending.length;
          pending = Buffer.alloc(0);
          checkpoint.discarded = true;
        }
      }
    }
    for (const [id, entry] of this.entries) {
      if (Date.parse(entry.timestamp) < now - RETENTION_MS) {
        this.entries.delete(id);
        this.dirty = true;
      }
    }
    if (this.dirty) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: this.snapshot() }), {
        mode: 0o600,
      });
      await fs.rename(temporary, this.filePath);
      this.dirty = false;
    }
    return this.snapshot();
  }
}
