import { describe, expect, it } from "vitest";
import { resolveSupportedLocale } from ".";

describe("resolveSupportedLocale", () => {
  it.each(["zh", "zh-CN", "zh-TW", "zh-HK", "ZH-cn"])(
    "maps %s to Simplified Chinese",
    (locale) => {
      expect(resolveSupportedLocale(locale)).toBe("zh-CN");
    },
  );

  it.each(["en-US", "en-GB", "fr-FR", "ja-JP", ""])(
    "maps unsupported locale %s to English",
    (locale) => {
      expect(resolveSupportedLocale(locale)).toBe("en-US");
    },
  );
});