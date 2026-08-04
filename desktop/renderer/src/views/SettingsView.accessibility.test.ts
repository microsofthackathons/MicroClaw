import { describe, expect, it } from "vitest";
import settingsViewSource from "./SettingsView.vue?raw";

describe("Settings language selector accessibility", () => {
  it("uses a labelled native select for platform accessibility APIs", () => {
    expect(settingsViewSource).toContain(
      '<label class="row-label" for="settings-language-select">',
    );
    expect(settingsViewSource).toContain('<select\n              id="settings-language-select"');
    expect(settingsViewSource).toContain(':aria-label="t(\'settings.language\')"');
    expect(settingsViewSource).not.toMatch(
      /<el-select[^>]*v-model="settings\.language"[^>]*>/s,
    );
  });
});
