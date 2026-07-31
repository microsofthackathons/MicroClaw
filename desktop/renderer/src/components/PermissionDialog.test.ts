import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PermissionDialog from "./PermissionDialog.vue";

describe("PermissionDialog", () => {
  it("shows both approval actions for an external application", () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "app-request",
          type: "app-approval",
          app: "soffice",
          command: "soffice.exe --headless",
        },
      },
    });

    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow once",
      "Always allow",
    ]);
  });

  it("keeps high-risk actions visible without optional semantic color tokens", () => {
    const globalStyles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

    expect(globalStyles).toContain(
      "--danger: var(--smtc-status-danger-foreground, #dc2626);",
    );
    expect(globalStyles).toContain(
      "--danger: var(--smtc-status-danger-foreground, #ef4444);",
    );
  });
});
