import { describe, expect, it } from "vitest";
import { resolveSupportedLocale, t } from ".";

describe("resolveSupportedLocale", () => {
  it.each(["zh", "zh-CN", "zh-TW", "zh-HK", "ZH-cn"])("maps %s to Simplified Chinese", (locale) => {
    expect(resolveSupportedLocale(locale)).toBe("zh-CN");
  });

  it.each(["en-US", "en-GB", "fr-FR", "ja-JP", ""])(
    "maps unsupported locale %s to English",
    (locale) => {
      expect(resolveSupportedLocale(locale)).toBe("en-US");
    },
  );

  it("localizes tracked containment validation details in English and Chinese", () => {
    expect(t("en-US", "mxc.assessingLimitedAmbientAccess")).toBe(
      "Assessing Limited-mode ambient filesystem access",
    );
    expect(t("zh-CN", "mxc.assessingLimitedAmbientAccess")).toBe(
      "正在评估 Limited 模式的环境文件系统访问权限",
    );
    expect(t("zh-CN", "mxc.verifyingFullBackend")).toBe("正在验证 Full AppContainer 后端");
  });
});
