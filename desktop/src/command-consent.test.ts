import { describe, expect, it, vi } from "vitest";
import {
  applyCommandConsentChange,
  parseCommandConsentMode,
  parseCommandConsentPreview,
} from "./command-consent";

describe("command consent", () => {
  it("accepts only valid modes and internally consistent previews", () => {
    expect(parseCommandConsentMode("ask-when-needed")).toBe("ask-when-needed");
    expect(parseCommandConsentMode("allow-always")).toBe("allow-always");
    expect(() => parseCommandConsentMode("unknown")).toThrow();
    expect(parseCommandConsentPreview({ required: true, allowAlwaysAvailable: true })).toEqual({
      required: true,
      allowAlwaysAvailable: true,
    });
    expect(parseCommandConsentPreview({ required: false, allowAlwaysAvailable: true })).toBeNull();
    expect(parseCommandConsentPreview({ required: "true", allowAlwaysAvailable: true })).toBeNull();
  });

  it("locks, publishes and verifies the new mode before releasing execution", async () => {
    const calls: string[] = [];
    await applyCommandConsentChange("ask-when-needed", "allow-always", {
      lock: async () => {
        calls.push("lock");
      },
      save: (mode) => {
        calls.push(`save:${mode}`);
      },
      publish: async (mode) => {
        calls.push(`publish:${mode}`);
      },
      verify: async (mode) => {
        calls.push(`verify:${mode}`);
      },
      release: async () => {
        calls.push("release");
      },
      failClosed: async () => {
        calls.push("fail-closed");
      },
    });
    expect(calls).toEqual([
      "lock",
      "save:allow-always",
      "publish:allow-always",
      "verify:allow-always",
      "release",
    ]);
  });

  it.each(["lock", "save", "publish", "verify", "release"] as const)(
    "locks and restores the previous live policy after %s fails",
    async (failure) => {
      const original = new Error(`${failure} failed`);
      const lock = vi.fn().mockResolvedValue(undefined);
      const save = vi.fn();
      const publish = vi.fn().mockResolvedValue(undefined);
      const verify = vi.fn().mockResolvedValue(undefined);
      const release = vi.fn().mockResolvedValue(undefined);
      const failClosed = vi.fn().mockResolvedValue(undefined);
      if (failure === "lock") lock.mockRejectedValueOnce(original);
      if (failure === "save")
        save.mockImplementationOnce(() => {
          throw original;
        });
      if (failure === "publish") publish.mockRejectedValueOnce(original);
      if (failure === "verify") verify.mockRejectedValueOnce(original);
      if (failure === "release") release.mockRejectedValueOnce(original);

      await expect(
        applyCommandConsentChange("ask-when-needed", "allow-always", {
          lock,
          save,
          publish,
          verify,
          release,
          failClosed,
        }),
      ).rejects.toBe(original);
      expect(lock).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith("ask-when-needed");
      expect(publish).toHaveBeenLastCalledWith("ask-when-needed");
      expect(verify).toHaveBeenLastCalledWith("ask-when-needed");
      expect(release).toHaveBeenCalledTimes(failure === "release" ? 2 : 1);
      expect(failClosed).not.toHaveBeenCalled();
    },
  );

  it.each(["lock", "save", "publish", "verify", "release"] as const)(
    "fails closed if rollback %s fails",
    async (failure) => {
      const original = new Error("new policy failed");
      const rollbackError = new Error(`rollback ${failure} failed`);
      const lock = vi.fn().mockResolvedValue(undefined);
      const save = vi.fn();
      const publish = vi.fn().mockRejectedValueOnce(original).mockResolvedValue(undefined);
      const verify = vi.fn().mockResolvedValue(undefined);
      const release = vi.fn().mockResolvedValue(undefined);
      const failClosed = vi.fn().mockResolvedValue(undefined);
      if (failure === "lock")
        lock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(rollbackError);
      if (failure === "save")
        save
          .mockImplementationOnce(() => undefined)
          .mockImplementationOnce(() => {
            throw rollbackError;
          });
      if (failure === "publish") publish.mockRejectedValueOnce(rollbackError);
      if (failure === "verify") verify.mockRejectedValueOnce(rollbackError);
      if (failure === "release") release.mockRejectedValueOnce(rollbackError);

      await expect(
        applyCommandConsentChange("ask-when-needed", "allow-always", {
          lock,
          save,
          publish,
          verify,
          release,
          failClosed,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("could not be applied or restored"),
        cause: rollbackError,
        errors: [original, rollbackError],
      });
      expect(failClosed).toHaveBeenCalledWith(rollbackError);
    },
  );

  it("preserves both recovery and fail-closed errors", async () => {
    const original = new Error("publish failed");
    const rollback = new Error("restore failed");
    const lockError = new Error("fail-closed failed");
    await expect(
      applyCommandConsentChange("ask-when-needed", "allow-always", {
        lock: async () => undefined,
        save: () => undefined,
        publish: vi.fn().mockRejectedValueOnce(original).mockRejectedValueOnce(rollback),
        verify: async () => undefined,
        release: async () => undefined,
        failClosed: async () => {
          throw lockError;
        },
      }),
    ).rejects.toMatchObject({ cause: rollback, errors: [original, rollback, lockError] });
  });
});
