import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  createSearchAutosave,
  patchSearchConfig,
  type SearchSaveRequest,
} from "./search-settings-autosave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const brave: SearchSaveRequest = { provider: "brave", key: "BSA-one", requiresKey: true };
const tavily: SearchSaveRequest = { provider: "tavily", key: "tvly-two", requiresKey: true };

function harness() {
  const reads: ReturnType<typeof deferred<unknown>>[] = [];
  const writes: ReturnType<typeof deferred<void>>[] = [];
  const read = vi.fn(() => {
    const task = deferred<unknown>();
    reads.push(task);
    return task.promise;
  });
  const write = vi.fn<(config: unknown) => Promise<void>>(() => {
    const task = deferred<void>();
    writes.push(task);
    return task.promise;
  });
  const saving = vi.fn(),
    saved = vi.fn(),
    failed = vi.fn();
  const queue = createSearchAutosave({
    async persist(request, canWrite) {
      const config = await read();
      if (!canWrite()) return false;
      const next = patchSearchConfig(config, request);
      await write(next);
      return true;
    },
    saving,
    saved,
    failed,
  });
  return { queue, read, write, reads, writes, saving, saved, failed };
}

describe("search autosave", () => {
  it("captures immutable intent and commits the written snapshot without marking a newer form saved", async () => {
    const h = harness();
    const request = { ...brave };
    h.queue.save(request);
    request.key = "BSA-edited";
    h.queue.invalidate(); // An invalid Tavily selection must not change this request.
    h.reads[0].resolve({});
    await flushPromises();
    expect(h.write).toHaveBeenCalledWith({
      tools: { web: { search: { provider: "brave", apiKey: "BSA-one" } } },
    });
    h.writes[0].resolve();
    await flushPromises();
    expect(h.saved).toHaveBeenCalledWith(brave, false);
  });

  it("deduplicates Enter/blur, serializes writes and replaces unstarted stale edits", async () => {
    const h = harness();
    h.queue.save(brave);
    h.queue.save({ ...brave });
    h.queue.invalidate();
    h.queue.save(tavily);
    h.queue.invalidate();
    h.queue.save({ ...tavily, key: "tvly-latest" });
    expect(h.read).toHaveBeenCalledTimes(1);
    h.reads[0].resolve({ marker: 1 });
    await flushPromises();
    expect(h.read).toHaveBeenCalledTimes(1);
    h.writes[0].resolve();
    await flushPromises();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.reads[1].resolve({ marker: 2 });
    await flushPromises();
    expect(h.write.mock.calls[1][0]).toEqual({
      marker: 2,
      tools: { web: { search: { provider: "tavily", apiKey: "tvly-latest" } } },
    });
    h.writes[1].resolve();
    await flushPromises();
    expect(h.saved.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("drops queued requests invalidated by an unsaved edit", async () => {
    const h = harness();
    h.queue.save(brave);
    h.queue.invalidate();
    h.queue.save(tavily);
    h.queue.invalidate();
    h.reads[0].resolve({});
    await flushPromises();
    h.writes[0].resolve();
    await flushPromises();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.saved).toHaveBeenCalledWith(brave, false);
  });

  it.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "array", value: [] },
    { label: "tools array", value: { tools: [] } },
    { label: "web null", value: { tools: { web: null } } },
  ])("fails closed for unavailable/malformed config: $label", async ({ value: config }) => {
    const h = harness();
    h.queue.save(brave);
    h.reads[0].resolve(config);
    await flushPromises();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated config and cleans only the legacy provider map", () => {
    const config = {
      models: { primary: "one" },
      tools: {
        other: true,
        web: {
          fetch: { enabled: true },
          searchProviders: { old: 1 },
          search: { provider: "brave" },
        },
      },
    };
    const before = structuredClone(config);
    expect(
      patchSearchConfig(config, { provider: "parallel-free", key: "", requiresKey: false }),
    ).toEqual({
      models: { primary: "one" },
      tools: {
        other: true,
        web: { fetch: { enabled: true }, search: { provider: "parallel-free" } },
      },
    });
    expect(config).toEqual(before);
  });

  it("reports current read/write failures without retry and ignores an older failure", async () => {
    const h = harness();
    h.queue.save(brave);
    h.reads[0].reject(new Error("read failed"));
    await flushPromises();
    expect(h.failed).toHaveBeenCalledOnce();
    expect(h.write).not.toHaveBeenCalled();
    h.queue.save(brave);
    h.reads[1].resolve({});
    await flushPromises();
    h.queue.invalidate();
    h.queue.save(tavily);
    h.writes[0].reject(new Error("old write failed"));
    await flushPromises();
    expect(h.failed).toHaveBeenCalledOnce();
    h.reads[2].resolve({});
    await flushPromises();
    h.writes[1].reject(new Error("current write failed"));
    await flushPromises();
    expect(h.failed).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it("disposes during read without starting a write or queued read", async () => {
    const h = harness();
    h.queue.save(brave);
    h.queue.invalidate();
    h.queue.save(tavily);
    h.queue.dispose();
    h.reads[0].resolve({});
    await flushPromises();
    h.queue.save(brave);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.failed).not.toHaveBeenCalled();
  });

  it("does not update UI or start the queued write after disposal during a write", async () => {
    const h = harness();
    h.queue.save(brave);
    h.reads[0].resolve({});
    await flushPromises();
    h.queue.invalidate();
    h.queue.save(tavily);
    h.queue.dispose();
    h.writes[0].resolve();
    await flushPromises();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.saved).not.toHaveBeenCalled();
  });
});
