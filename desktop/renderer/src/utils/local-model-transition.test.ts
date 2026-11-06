import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { releaseLocalModelSetup } from "./local-model-transition";
import type {
  LocalModelAPI,
  LocalModelOperation,
  LocalModelResult,
} from "../../../src/local-model-types";

const ok = <T>(value: T): LocalModelResult<T> => ({ ok: true, value });
const active: LocalModelOperation = {
  id: "local-one",
  kind: "prepare",
  phase: "step",
  agentId: "main",
  busy: true,
  cancellationPending: false,
};
const cancelled: LocalModelOperation = { ...active, phase: "cancelled", busy: false };

function fixture() {
  const api: Pick<LocalModelAPI, "getOperation" | "cancel" | "resume"> = {
    getOperation: vi.fn().mockResolvedValue(ok(active)),
    cancel: vi.fn().mockResolvedValue(ok(cancelled)),
    resume: vi.fn().mockResolvedValue(ok(cancelled)),
  };
  const confirm = vi.fn().mockResolvedValue(true);
  return { api, confirm };
}

describe("cloud setup handoff", () => {
  beforeEach(() => setLocale("en-US"));

  it("does not require local support or interrupt a finished operation", async () => {
    const { api, confirm } = fixture();
    expect(await releaseLocalModelSetup(undefined, confirm)).toBe("ready");
    vi.mocked(api.getOperation).mockResolvedValue(
      ok({ ...active, phase: "interrupted", busy: false }),
    );
    expect(await releaseLocalModelSetup(api, confirm)).toBe("ready");
    expect(confirm).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("requires consent before cancelling the exact active setup", async () => {
    const { api, confirm } = fixture();
    expect(await releaseLocalModelSetup(api, confirm)).toBe("ready");
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith("local-one");
    expect(api.getOperation).toHaveBeenCalledTimes(2);
  });

  it("does not cancel when the user stays with local setup", async () => {
    const { api, confirm } = fixture();
    confirm.mockResolvedValue(false);
    expect(await releaseLocalModelSetup(api, confirm)).toBe("declined");
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("never cancels a newer setup that appeared while confirming", async () => {
    const { api, confirm } = fixture();
    vi.mocked(api.getOperation)
      .mockResolvedValueOnce(ok(active))
      .mockResolvedValueOnce(ok({ ...active, id: "newer" }));
    await expect(releaseLocalModelSetup(api, confirm)).rejects.toThrow("changed");
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("preserves protected work instead of pretending it was cancelled", async () => {
    const { api, confirm } = fixture();
    vi.mocked(api.cancel).mockResolvedValue(ok({ ...active, cancellationPending: true }));
    expect(await releaseLocalModelSetup(api, confirm)).toBe("pending");
    expect(api.resume).not.toHaveBeenCalled();
  });

  it("can reconcile a stale interrupted operation without replaying an answer", async () => {
    const { api, confirm } = fixture();
    vi.mocked(api.cancel).mockResolvedValue(
      ok({ ...active, phase: "interrupted", cancellationPending: true }),
    );
    vi.mocked(api.getOperation)
      .mockResolvedValueOnce(ok(active))
      .mockResolvedValueOnce(ok(active))
      .mockResolvedValueOnce(ok({ ...active, phase: "error", busy: false }));
    expect(await releaseLocalModelSetup(api, confirm)).toBe("ready");
    expect(api.resume).toHaveBeenCalledOnce();
  });

  it("does not change anything after the requesting form has closed", async () => {
    const { api, confirm } = fixture();
    let current = true;
    confirm.mockImplementation(async () => {
      current = false;
      return true;
    });
    expect(await releaseLocalModelSetup(api, confirm, () => current)).toBe("declined");
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("surfaces unavailable state rather than assuming writes are safe", async () => {
    const { api, confirm } = fixture();
    vi.mocked(api.getOperation).mockResolvedValue({ ok: false, error: "Connection unavailable" });
    await expect(releaseLocalModelSetup(api, confirm)).rejects.toThrow("Connection unavailable");
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
