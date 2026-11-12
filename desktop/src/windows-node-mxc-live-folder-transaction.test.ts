import { describe, expect, it } from "vitest";
import {
  applyLiveFolderPolicy,
  type LiveFolderPolicyHooks,
} from "./windows-node-mxc-live-folder-transaction";
import { getWindowsNodeMxcMissingFolders } from "./windows-node-mxc";

describe("live folder transaction", () => {
  const draft = { ro: ["C:\\Work"], rw: [] };
  function hooks(failure?: string) {
    const calls: string[] = [];
    const record = (stage: string) => {
      calls.push(stage);
      if (stage === failure) throw new Error(stage);
    };
    const value: LiveFolderPolicyHooks<string> = {
      validate: async (candidate) => {
        record("validate");
        return candidate;
      },
      lock: async () => record("lock"),
      persist: async () => record("persist"),
      publish: async () => record("publish"),
      verify: async () => {
        record("verify");
        return "active";
      },
      release: async () => record("release"),
      failClosed: async () => record("failClosed"),
    };
    return { calls, value };
  }
  it("publishes and acknowledges before releasing execution, with no restart hook", async () => {
    const h = hooks();
    await expect(applyLiveFolderPolicy(draft, h.value)).resolves.toBe("active");
    expect(h.calls).toEqual(["validate", "lock", "persist", "publish", "verify", "release"]);
  });
  it("leaves the running policy untouched for invalid drafts", async () => {
    const h = hooks("validate");
    await expect(applyLiveFolderPolicy(draft, h.value)).rejects.toThrow("validate");
    expect(h.calls).toEqual(["validate"]);
  });
  it("waits for confirmed phone acknowledgement before locking or changing policy", async () => {
    const h = hooks();
    let acknowledge!: () => void;
    h.value.confirm = () =>
      new Promise((resolve) => {
        h.calls.push("confirm");
        acknowledge = resolve;
      });
    const pending = applyLiveFolderPolicy(draft, h.value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toEqual(["validate", "confirm"]);
    acknowledge();
    await pending;
    expect(h.calls).toEqual([
      "validate",
      "confirm",
      "lock",
      "persist",
      "publish",
      "verify",
      "release",
    ]);
  });
  it("does not lock or persist grants when phone delivery is unconfirmed", async () => {
    const h = hooks();
    h.value.confirm = async () => {
      h.calls.push("confirm");
      throw new Error("phone delivery unconfirmed");
    };
    await expect(applyLiveFolderPolicy(draft, h.value)).rejects.toThrow(
      "phone delivery unconfirmed",
    );
    expect(h.calls).toEqual(["validate", "confirm"]);
  });
  it.each(["lock", "persist", "publish", "verify", "release"])(
    "locks execution after a %s failure",
    async (stage) => {
      const h = hooks(stage);
      await expect(applyLiveFolderPolicy(draft, h.value)).rejects.toThrow(stage);
      expect(h.calls.at(-1)).toBe("failClosed");
      if (stage !== "release") expect(h.calls).not.toContain("release");
    },
  );
  it("reports both the update and locking errors", async () => {
    const h = hooks("publish");
    h.value.failClosed = async () => {
      throw new Error("locking failed");
    };
    await expect(applyLiveFolderPolicy(draft, h.value)).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("missing folder grants", () => {
  it("does not request new grants for covered CWD or declarations", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "C:\\work\\child",
          declaredAccess: [{ path: "C:\\Work\\child", access: "ro" }],
        },
        [{ path: "C:\\Work", access: "rw" }],
      ),
    ).toEqual([]);
  });
  it("requests only the missing RO-to-RW upgrade", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "C:\\Work",
          declaredAccess: [{ path: "C:\\Work", access: "rw" }],
        },
        [{ path: "C:\\Work", access: "ro" }],
      ),
    ).toEqual([{ path: "C:\\Work", access: "rw" }]);
  });
  it("requests an RW upgrade for a read-only child even under an RW parent", () => {
    const folders = [
      { path: "C:\\Work", access: "rw" as const },
      { path: "C:\\Work\\child", access: "ro" as const },
    ];
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "C:\\Work\\child",
          declaredAccess: [{ path: "C:\\Work\\child", access: "rw" }],
        },
        folders,
      ),
    ).toEqual([{ path: "C:\\Work\\child", access: "rw" }]);
  });
  it("folds a missing child CWD into its explicitly requested parent grant", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "C:\\Work\\child",
          declaredAccess: [{ path: "C:\\Work", access: "rw" }],
        },
        [],
      ),
    ).toEqual([{ path: "C:\\Work", access: "rw" }]);
  });
  it("requests a nested upgrade when an existing read-only grant overrides a new parent", () => {
    const approval = {
      canonicalCwd: "isolated-scratch:v1",
      declaredAccess: [
        { path: "C:\\Work\\child\\project", access: "rw" as const },
        { path: "C:\\Work", access: "rw" as const },
      ],
    };
    const existing = [{ path: "C:\\Work\\child", access: "ro" as const }];
    expect(getWindowsNodeMxcMissingFolders(approval, existing)).toEqual([
      { path: "C:\\Work", access: "rw" },
      { path: "C:\\Work\\child\\project", access: "rw" },
    ]);
    expect(
      getWindowsNodeMxcMissingFolders(approval, [...existing, { path: "C:\\Work", access: "rw" }]),
    ).toEqual([{ path: "C:\\Work\\child\\project", access: "rw" }]);
    expect(
      getWindowsNodeMxcMissingFolders(approval, [
        ...existing,
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Work\\child\\project", access: "rw" },
      ]),
    ).toEqual([]);
  });
  it("folds a descendant request into an upgrade of its existing parent grant", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "isolated-scratch:v1",
          declaredAccess: [
            { path: "C:\\Work\\child", access: "rw" },
            { path: "C:\\Work", access: "rw" },
          ],
        },
        [{ path: "C:\\Work", access: "ro" }],
      ),
    ).toEqual([{ path: "C:\\Work", access: "rw" }]);
  });
  it("recognizes a drive-root grant for its descendants", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "C:\\Work",
          declaredAccess: [{ path: "C:\\Work\\child", access: "rw" }],
        },
        [{ path: "C:\\", access: "rw" }],
      ),
    ).toEqual([]);
  });
  it("requests a child upgrade under a new drive-root grant", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "isolated-scratch:v1",
          declaredAccess: [
            { path: "C:\\Work", access: "rw" },
            { path: "C:\\", access: "rw" },
          ],
        },
        [{ path: "C:\\Work", access: "ro" }],
      ),
    ).toEqual([
      { path: "C:\\", access: "rw" },
      { path: "C:\\Work", access: "rw" },
    ]);
  });
  it("does not grant a sibling or treat isolated scratch as a user folder", () => {
    expect(
      getWindowsNodeMxcMissingFolders(
        {
          canonicalCwd: "isolated-scratch:v1",
          declaredAccess: [{ path: "C:\\WorkOther", access: "ro" }],
        },
        [{ path: "C:\\Work", access: "rw" }],
      ),
    ).toEqual([{ path: "C:\\WorkOther", access: "ro" }]);
  });
});
