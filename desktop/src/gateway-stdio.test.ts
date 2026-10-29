import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getGatewayProcessStdio } from "./gateway-lifecycle";

type ProbeMessage = {
  type: string;
  code?: number | null;
  stdout?: string;
  stderr?: string;
};

const gatewayProbe = `
  const { spawn } = require("node:child_process");
  const target = JSON.parse(process.argv[1]);
  let commandDone = false;
  let lifelineClosed = false;
  const finish = () => {
    if (commandDone && lifelineClosed) {
      process.send({ type: "lifeline-closed" }, () => process.disconnect());
    }
  };
  process.stdin.once("end", () => {
    lifelineClosed = true;
    finish();
  });
  process.stdin.resume();
  setTimeout(() => {
    const command = spawn(target.executable, target.args, {
      cwd: target.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    command.stdout.on("data", chunk => stdout += chunk);
    command.stderr.on("data", chunk => stderr += chunk);
    command.on("error", error => stderr += error.message);
    command.on("close", code => {
      commandDone = true;
      process.stdout.write("gateway stdout\\n");
      process.stderr.write("gateway stderr\\n");
      process.send({ type: "command-complete", code, stdout, stderr });
      finish();
    });
  }, 150);
`;

async function runGatewayProbe(executable: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ["-e", gatewayProbe, JSON.stringify({ executable, args, cwd: tmpdir() })],
    { stdio: getGatewayProcessStdio(), windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let lifelineOpenWhenCommandCompleted = false;
  let failure: Error | undefined;
  const messages: ProbeMessage[] = [];
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  child.on("error", (error) => (failure = error));
  child.stdin?.on("error", (error) => (failure = error));
  child.on("message", (message) => {
    const record = message as ProbeMessage;
    messages.push(record);
    if (record.type === "command-complete") {
      lifelineOpenWhenCommandCompleted = Boolean(
        child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded,
      );
      child.stdin?.end();
    }
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.stdin?.end();
  }, 5_000);
  const forceTimeout = setTimeout(() => child.kill(), 8_000);
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    if (failure) throw failure;
    return { code, stdout, stderr, messages, timedOut, lifelineOpenWhenCommandCompleted };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceTimeout);
  }
}

describe("Gateway stdin lifeline", () => {
  it("allows inherited Node stdin initialization before EOF, then exits on lifeline closure", async () => {
    const result = await runGatewayProbe(process.execPath, [
      "-e",
      'process.stdin; process.stdout.write("nested command completed");',
    ]);

    expect(result.timedOut).toBe(false);
    expect(result.lifelineOpenWhenCommandCompleted).toBe(true);
    expect(result.code).toBe(0);
    expect(result.messages).toEqual([
      {
        type: "command-complete",
        code: 0,
        stdout: "nested command completed",
        stderr: "",
      },
      { type: "lifeline-closed" },
    ]);
    expect(result.stdout).toBe("gateway stdout\n");
    expect(result.stderr).toBe("gateway stderr\n");
  }, 15_000);

  const hasGit =
    process.platform === "win32" &&
    spawnSync("git", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    }).status === 0;

  it.runIf(hasGit)(
    "allows Git to return while the Windows lifeline remains open",
    async () => {
      const result = await runGatewayProbe("git", [
        "--git-dir",
        path.join(tmpdir(), `microclaw-missing-git-${randomUUID()}`),
        "rev-parse",
        "--show-toplevel",
      ]);

      expect(result.timedOut).toBe(false);
      expect(result.lifelineOpenWhenCommandCompleted).toBe(true);
      expect(result.code).toBe(0);
      expect(result.messages[0]).toMatchObject({ type: "command-complete", code: 128 });
      expect(result.messages[0].stderr).toContain("not a git repository");
      expect(result.messages[1]).toEqual({ type: "lifeline-closed" });
    },
    15_000,
  );
});
