import * as fs from "node:fs";
import * as path from "node:path";

export const PERFORMANCE_ARGUMENT = "--microclaw-performance";

interface FixtureApp {
  setPath(name: "home" | "appData" | "userData" | "sessionData" | "temp", value: string): void;
}

export function configurePerformanceFixture(
  app: FixtureApp,
  environment: NodeJS.ProcessEnv,
): boolean {
  const marker = environment.MICROCLAW_PERF_FIXTURE;
  const token = environment.MICROCLAW_PERF_TOKEN;
  if (!marker && !token) return false;
  if (!marker || !token || !path.isAbsolute(marker)) {
    throw new Error("Performance mode requires an absolute fixture marker and its token");
  }
  const root = fs.realpathSync(path.dirname(marker));
  if (fs.lstatSync(marker).isSymbolicLink()) throw new Error("Invalid performance fixture marker");
  const manifest = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (
    manifest.kind !== "microclaw.performance.fixture.v1" ||
    manifest.disposable !== true ||
    manifest.token !== token
  ) {
    throw new Error("Invalid performance fixture identity");
  }
  const directories = Object.fromEntries(
    ["home", "appData", "userData", "sessionData", "temp", "localAppData", "state"].map((name) => {
      const directory = fs.realpathSync(path.join(root, name));
      const relative = path.relative(root, directory);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Performance fixture directories must stay inside the fixture");
      }
      return [name, directory];
    }),
  );
  const config = JSON.parse(fs.readFileSync(path.join(directories.state, "openclaw.json"), "utf8"));
  if (
    !Number.isInteger(manifest.gatewayPort) ||
    manifest.gatewayPort < 1024 ||
    manifest.gatewayPort > 65535 ||
    config.gateway?.port !== manifest.gatewayPort ||
    config.gateway?.bind !== "loopback" ||
    !Array.isArray(config.tools?.deny) ||
    !config.tools.deny.includes("*")
  ) {
    throw new Error(
      "Performance fixture requires its own loopback Gateway port and deny-all model tools",
    );
  }
  for (const name of ["home", "appData", "userData", "sessionData", "temp"] as const) {
    app.setPath(name, directories[name]);
  }
  Object.assign(environment, {
    HOME: directories.home,
    USERPROFILE: directories.home,
    APPDATA: directories.appData,
    LOCALAPPDATA: directories.localAppData,
    TEMP: directories.temp,
    TMP: directories.temp,
    TMPDIR: directories.temp,
    OPENCLAW_STATE_DIR: directories.state,
    OPENCLAW_CONFIG_PATH: path.join(directories.state, "openclaw.json"),
  });
  return true;
}
