// Give the temporary validation Gateway the same Windows overlapped stdin
// lifeline as the desktop. Python's synchronous anonymous pipe must not become
// the stdin inherited by Git/Node subprocesses inside the Gateway.
import { spawn } from "node:child_process";
import { isAbsolute, dirname } from "node:path";

const [entry, port] = process.argv.slice(2);
if (
  !entry ||
  !isAbsolute(entry) ||
  !/^\d+$/.test(port ?? "") ||
  Number(port) < 1024 ||
  Number(port) > 65535
) {
  throw new Error("Invalid bundled migration Gateway arguments");
}
const gateway = spawn(
  process.execPath,
  [entry, "gateway", "run", "--port", port, "--bind", "loopback", "--allow-unconfigured"],
  {
    cwd: dirname(entry),
    env: process.env,
    windowsHide: true,
    stdio: [process.platform === "win32" ? "overlapped" : "pipe", "inherit", "inherit", "ipc"],
  },
);
gateway.stdin.on("error", () => {});
process.stdin.once("end", () => gateway.stdin.end());
process.stdin.resume();
gateway.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
gateway.once("exit", (code, signal) => process.exit(signal || code === null ? 1 : code));
