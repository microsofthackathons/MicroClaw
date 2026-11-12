import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
const start = source.indexOf('ipcMain.handle(\n    "windows-node-mxc:set-enabled"');
const end = source.indexOf('ipcMain.handle(\n    "windows-node-mxc:approval-respond"', start);
if (start < 0 || end < 0) throw new Error("Cannot locate the sandbox toggle IPC handler");
const handlerJs = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const handlers = new Map<
    string,
    (event: unknown, params: { enabled?: unknown }) => Promise<unknown>
  >();
  const changeMode = vi.fn(async (params: { enabled: boolean }) => params.enabled);
  const context = {
    ipcMain: {
      handle: (
        channel: string,
        callback: (event: unknown, params: { enabled?: unknown }) => Promise<unknown>,
      ) => handlers.set(channel, callback),
    },
    assertTrustedRendererIpc: vi.fn(),
    assertNativeWeixinRemoteApprovalAuthority: vi.fn(),
    commandConsentUpdating: false,
    changeWindowsNodeMxcMode: changeMode,
  };
  runInNewContext(handlerJs, context);
  const handler = handlers.get("windows-node-mxc:set-enabled");
  if (!handler) throw new Error("Sandbox toggle IPC handler was not registered");
  return { context, handler, changeMode };
}

describe("sandbox toggle IPC handler", () => {
  it.each([true, false])("forwards the explicit MXC choice %s", async (enabled) => {
    const fixture = harness();
    await expect(fixture.handler({}, { enabled })).resolves.toBe(enabled);
    expect(fixture.context.assertTrustedRendererIpc).toHaveBeenCalledOnce();
    expect(
      fixture.context.assertNativeWeixinRemoteApprovalAuthority,
    ).toHaveBeenCalledExactlyOnceWith({
      enabled,
    });
    expect(fixture.changeMode).toHaveBeenCalledExactlyOnceWith({ enabled });
  });

  it("rejects a missing or non-boolean choice", async () => {
    const fixture = harness();
    await expect(fixture.handler({}, {})).rejects.toThrow(
      "A boolean sandboxing choice is required",
    );
    await expect(fixture.handler({}, { enabled: "on" })).rejects.toThrow(
      "A boolean sandboxing choice is required",
    );
    expect(fixture.changeMode).not.toHaveBeenCalled();
  });

  it("does not allow a toggle while command consent settings are being applied", async () => {
    const fixture = harness();
    fixture.context.commandConsentUpdating = true;
    await expect(fixture.handler({}, { enabled: false })).rejects.toThrow(
      "Command consent settings are being applied",
    );
    expect(fixture.changeMode).not.toHaveBeenCalled();
  });

  it.each(["renderer", "WeChat authority"] as const)(
    "stops when %s validation rejects the request",
    async (source) => {
      const fixture = harness();
      const validation =
        source === "renderer"
          ? fixture.context.assertTrustedRendererIpc
          : fixture.context.assertNativeWeixinRemoteApprovalAuthority;
      vi.mocked(validation).mockImplementationOnce(() => {
        throw new Error(`${source} rejected`);
      });
      await expect(fixture.handler({}, { enabled: true })).rejects.toThrow(`${source} rejected`);
      expect(fixture.changeMode).not.toHaveBeenCalled();
    },
  );
});
