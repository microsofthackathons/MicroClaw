import path from "path";
import { fileURLToPath } from "url";

export function isTrustedRendererUrl(
  value: string,
  options: {
    development: boolean;
    developmentUrl: string;
    packagedIndexPath: string;
  },
): boolean {
  try {
    const url = new URL(value);
    if (options.development) {
      const expected = new URL(options.developmentUrl);
      return url.protocol === expected.protocol && url.origin === expected.origin;
    }
    if (url.protocol !== "file:") return false;
    return (
      path.resolve(fileURLToPath(url)).toLowerCase() ===
      path.resolve(options.packagedIndexPath).toLowerCase()
    );
  } catch {
    return false;
  }
}
