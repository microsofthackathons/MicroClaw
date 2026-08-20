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
      "Allow always",
    ]);
    expect(wrapper.find(".perm-body").text()).toBe(
      "AI is trying to launch soffice. This app is not in the sandbox whitelist and needs to run outside the sandbox.",
    );
  });

  it("shows only decisions advertised by a Gateway approval", () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "gateway-request",
          type: "app-approval",
          app: "OpenClaw Gateway node command",
          command: "Set-Content test.txt ok",
          allowedDecisions: ["deny", "allow-once"],
        },
      },
    });

    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow once",
    ]);
  });

  it("shows an MXC-contained command with separate RO and RW access", () => {
    const command = `${"x".repeat(350)} <img src=x onerror=alert(1)>`;
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "mxc-request",
          type: "mxc-approval",
          command,
          dirPath: "isolated-scratch:v1",
          declaredAccess: [
            { access: "ro", path: String.raw`C:\Users\test\Documents` },
            { access: "rw", path: String.raw`C:\Users\test\Desktop<script>` },
          ],
          allowedDecisions: ["deny", "allow-once", "allow-always"],
        },
      },
    });

    expect(wrapper.find(".perm-title").text()).toBe("MXC sandbox command approval");
    expect(wrapper.find(".perm-subtitle").text()).toBe(
      "Contained by MXC: review the command and declared folder use before allowing.",
    );
    expect(wrapper.findAll(".perm-body")[0].text()).toBe(
      "AI wants to run this command inside the MXC sandbox.",
    );
    expect(wrapper.find(".perm-command-label").text()).toBe("Declared folder use");
    expect(wrapper.find(".perm-command-code").text()).toBe(command);
    expect(wrapper.find(".perm-command-code img").exists()).toBe(false);
    expect(wrapper.findAll(".perm-mxc-access").map((entry) => entry.text())).toEqual([
      String.raw`Read only — C:\Users\test\Documents`,
      String.raw`Read and write — C:\Users\test\Desktop<script>`,
    ]);
    expect(wrapper.find(".perm-mxc-access script").exists()).toBe(false);
    expect(wrapper.find(".perm-mxc-value").text()).toBe("isolated-scratch:v1");
    expect(wrapper.findAll(".perm-body")[1].text()).toBe(
      "Approval authorizes this command itself inside MXC. Declared folders are existing MXC grants; approval does not grant or change folder access. “Allow always” remembers this exact command, canonical working directory, and declaration identity.",
    );
    expect(wrapper.text()).not.toContain("Requested folder access");
  });

  it("omits the folder section when an MXC command declares no access", () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "mxc-request",
          type: "mxc-approval",
          command: "hostname.exe",
          dirPath: "isolated-scratch:v1",
          declaredAccess: [],
          allowedDecisions: ["deny", "allow-once"],
        },
      },
    });

    expect(wrapper.find(".perm-mxc-access").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Declared folder use");
    expect(wrapper.findAll(".perm-body")[1].text()).toBe(
      "Approval authorizes this command itself inside MXC with the canonical working directory shown.",
    );
    expect(wrapper.text()).not.toContain("Allow always");
    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow once",
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
