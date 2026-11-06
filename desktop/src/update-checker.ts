export interface UpdateManifest {
  version: string;
  downloadUrl: string;
  releasedAt?: string;
  sha256?: string;
  openclawVersion?: string;
  releaseNotes?: string[];
}

export type UpdateCheckResult =
  | {
      status: "managed-by-store";
      currentVersion: string;
    }
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      downloadUrl: string;
      releasedAt?: string;
      sha256?: string;
      openclawVersion?: string;
      releaseNotes: string[];
    }
  | {
      status: "up-to-date";
      currentVersion: string;
      latestVersion: string;
    }
  | {
      status: "error";
      currentVersion: string;
      message: string;
    };

export interface CheckForUpdatesOptions {
  currentVersion: string;
  manifestUrl: string;
  storeManaged?: boolean;
  fetchJson?: (url: string) => Promise<unknown>;
}

const SUPPORTED_VERSION_PATTERN = /^v?\d+(?:\.\d+){0,3}$/;

function parseVersion(version: string): number[] {
  const normalized = version.trim().replace(/^v/i, "").split("-")[0];
  return normalized.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function assertManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Update manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Update manifest is missing version");
  }
  if (!SUPPORTED_VERSION_PATTERN.test(manifest.version.trim())) {
    throw new Error("Update manifest version must be numeric, for example 1.0.1");
  }
  if (typeof manifest.downloadUrl !== "string" || !manifest.downloadUrl.trim()) {
    throw new Error("Update manifest is missing downloadUrl");
  }
  if (!/^https:\/\//i.test(manifest.downloadUrl)) {
    throw new Error("Update manifest downloadUrl must use https");
  }
  const releaseNotes = Array.isArray(manifest.releaseNotes)
    ? manifest.releaseNotes.filter((note): note is string => typeof note === "string")
    : undefined;
  return {
    version: manifest.version.trim(),
    downloadUrl: manifest.downloadUrl,
    releasedAt: typeof manifest.releasedAt === "string" ? manifest.releasedAt : undefined,
    sha256: typeof manifest.sha256 === "string" ? manifest.sha256 : undefined,
    openclawVersion:
      typeof manifest.openclawVersion === "string" ? manifest.openclawVersion : undefined,
    releaseNotes,
  };
}

async function fetchManifestJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Update manifest request failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function checkForUpdates({
  currentVersion,
  manifestUrl,
  storeManaged = false,
  fetchJson = fetchManifestJson,
}: CheckForUpdatesOptions): Promise<UpdateCheckResult> {
  if (storeManaged) {
    return { status: "managed-by-store", currentVersion };
  }
  try {
    const manifest = assertManifest(await fetchJson(manifestUrl));
    if (compareVersions(manifest.version, currentVersion) <= 0) {
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion: manifest.version,
      };
    }
    return {
      status: "update-available",
      currentVersion,
      latestVersion: manifest.version,
      downloadUrl: manifest.downloadUrl,
      releasedAt: manifest.releasedAt,
      sha256: manifest.sha256,
      openclawVersion: manifest.openclawVersion,
      releaseNotes: manifest.releaseNotes ?? [],
    };
  } catch (error) {
    return {
      status: "error",
      currentVersion,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
