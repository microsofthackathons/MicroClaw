import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT = 1024 * 1024;

function isInside(candidate, root) {
  const child = path.resolve(candidate).toLowerCase();
  const parent = path.resolve(root).toLowerCase();
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function canonicalTarget(input, policy, write = false) {
  const requested = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(policy.workspace, input);
  let probe = requested;
  if (write) {
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const canonicalProbe = await fs.promises.realpath(probe);
  const canonical =
    write && probe !== requested
      ? path.resolve(canonicalProbe, path.relative(probe, requested))
      : canonicalProbe;
  const rwRoots = [policy.workspace, ...(policy.readwritePaths || [])];
  const roRoots = [...rwRoots, ...(policy.readonlyPaths || [])];
  const roots = write ? rwRoots : roRoots;
  const canonicalRoots = await Promise.all(roots.map((root) => fs.promises.realpath(root)));
  if (!canonicalRoots.some((root) => isInside(canonical, root))) {
    throw new Error(`Path is outside the effective ${write ? "read-write" : "read"} policy.`);
  }
  return canonical;
}

function execCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        cwd,
        env: process.env,
        windowsHide: true,
        timeout: Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 30000),
        maxBuffer: MAX_EXEC_OUTPUT,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout).slice(0, MAX_EXEC_OUTPUT),
          stderr: String(stderr || error?.message || "").slice(0, MAX_EXEC_OUTPUT),
        });
      },
    );
  });
}

async function handle(request, policy) {
  switch (request.operation) {
    case "ping":
      return { ok: true };
    case "read": {
      const target = await canonicalTarget(String(request.path || ""), policy);
      const stat = await fs.promises.stat(target);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES)
        throw new Error("File is not readable or exceeds 1 MiB.");
      return { ok: true, content: await fs.promises.readFile(target, "utf8") };
    }
    case "write": {
      const content = String(request.content ?? "");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("Write exceeds 1 MiB.");
      const target = await canonicalTarget(String(request.path || ""), policy, true);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, {
        encoding: "utf8",
        flag: request.overwrite ? "w" : "wx",
      });
      return { ok: true, bytes: Buffer.byteLength(content) };
    }
    case "edit": {
      const target = await canonicalTarget(String(request.path || ""), policy, true);
      const original = await fs.promises.readFile(target, "utf8");
      const oldText = String(request.oldText ?? "");
      if (!oldText || !original.includes(oldText)) throw new Error("oldText was not found.");
      if (original.indexOf(oldText) !== original.lastIndexOf(oldText)) {
        throw new Error("oldText must identify exactly one occurrence.");
      }
      const updated = original.replace(oldText, String(request.newText ?? ""));
      if (Buffer.byteLength(updated) > MAX_WRITE_BYTES)
        throw new Error("Edited file exceeds 1 MiB.");
      await fs.promises.writeFile(target, updated, "utf8");
      return { ok: true };
    }
    case "exec": {
      const command = String(request.command || "");
      if (!command || command.length > 8192) throw new Error("Command must be 1-8192 characters.");
      const cwd = await canonicalTarget(String(request.cwd || policy.workspace), policy);
      return execCommand(command, cwd, request.timeoutMs);
    }
    default:
      throw new Error("Unsupported MXC worker operation.");
  }
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const message = JSON.parse(input);
  process.stdout.write(JSON.stringify(await handle(message.request || {}, message.policy || {})));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
}
