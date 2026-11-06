import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import PermissionDialog from "./PermissionDialog.vue";

describe("PermissionDialog", () => {
  it("disables all decisions and suppresses timeout submissions while a decision is applying", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PermissionDialog, {
      props: {
        responding: true,
        request: {
          requestId: "applying",
          type: "mxc-approval",
          command: "hostname.exe",
          expiresAtUnixMs: Date.now() + 1000,
        },
      },
    });
    try {
      expect(wrapper.get(".perm-card").attributes("aria-busy")).toBe("true");
      expect(wrapper.text()).toContain("Applying your decision");
      for (const button of wrapper.findAll("button")) {
        expect(button.attributes("disabled")).toBeDefined();
        await button.trigger("click");
      }
      await vi.advanceTimersByTimeAsync(2000);
      expect(wrapper.emitted("respond")).toBeUndefined();
      await wrapper.setProps({ responding: false });
      await vi.advanceTimersByTimeAsync(1000);
      expect(wrapper.emitted("respond")).toEqual([["deny", "timeout"]]);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps the folders to add or upgrade and the combined Allow decision", async () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "folder-request",
          type: "mxc-approval",
          command: "hostname.exe",
          folderChanges: [
            { path: "C:\\Work", access: "rw" },
            { path: "C:\\Docs<script>", access: "ro" },
          ],
          allowedDecisions: ["deny", "allow-once", "allow-always"],
        },
      },
    });
    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow",
    ]);
    expect(wrapper.get('[data-testid="mxc-folder-grants"]').text()).toContain("C:\\Work");
    expect(wrapper.get('[data-testid="mxc-folder-grants"] .perm-command-label').text()).toBe(
      "Folders to add or upgrade",
    );
    expect(wrapper.findAll(".perm-mxc-access span").map((entry) => entry.text())).toEqual([
      "Read and write —",
      "Read only —",
    ]);
    expect(wrapper.findAll(".perm-mxc-access code").map((entry) => entry.text())).toEqual([
      "C:\\Work",
      "C:\\Docs<script>",
    ]);
    expect(wrapper.find(".perm-mxc-access script").exists()).toBe(false);
    expect(wrapper.find(".perm-body").exists()).toBe(false);
    await wrapper.findAll(".perm-actions button")[1].trigger("click");
    expect(wrapper.emitted("respond")?.[0]).toEqual(["allow-once"]);
    wrapper.unmount();
  });
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
    expect(wrapper.find(".perm-body").exists()).toBe(false);
    expect(wrapper.get(".perm-title").text()).toBe("Your agent wants to run the following command");
    wrapper.unmount();
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
    wrapper.unmount();
  });

  it("keeps exact command text while hiding non-grant metadata", () => {
    const command = `${"x".repeat(350)} <img src=x onerror=alert(1)>`;
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "mxc-request",
          type: "mxc-approval" as const,
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

    expect(wrapper.find(".perm-title").text()).toBe(
      "Your agent wants to run the following command",
    );
    expect(wrapper.find(".perm-subtitle").exists()).toBe(false);
    expect(wrapper.find(".perm-icon").exists()).toBe(false);
    expect(wrapper.find(".perm-body").exists()).toBe(false);
    expect(wrapper.find(".perm-risk-label").exists()).toBe(false);
    expect(wrapper.find(".perm-command-label").text()).toBe("Command");
    expect(wrapper.find(".perm-command-code").text()).toBe(command);
    expect(wrapper.find(".perm-command-code img").exists()).toBe(false);
    expect(wrapper.find(".perm-mxc-access").exists()).toBe(false);
    expect(wrapper.find(".perm-mxc-value").exists()).toBe(false);
    expect(wrapper.find(".perm-countdown-row").text()).toBe("Auto-deny in 60s");
    expect(wrapper.get(".perm-countdown-bar span").attributes("style")).toContain("width: 100%");
    expect(wrapper.text()).not.toContain("Requested folder access");
    wrapper.unmount();
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
    expect(wrapper.find(".perm-body").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Allow always");
    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow once",
    ]);
    wrapper.unmount();
  });

  it("omits Limited metadata without changing eligible remember decisions", async () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "mxc-limited-request",
          type: "mxc-approval",
          command: "Get-ChildItem",
          dirPath: "isolated-scratch:v1",
          containmentStrength: "limited-dacl",
          declaredAccess: [{ access: "ro", path: String.raw`C:\Work` }],
          ambientAccess: [
            { category: "desktop", status: "read-write" },
            { category: "ssh", status: "denied" },
          ],
          allowedDecisions: ["deny", "allow-once", "allow-always"],
        },
      },
    });

    expect(wrapper.find(".perm-title").text()).toBe(
      "Your agent wants to run the following command",
    );
    expect(wrapper.find(".perm-subtitle").exists()).toBe(false);
    expect(wrapper.find(".perm-body").exists()).toBe(false);
    expect(wrapper.find(".perm-command-label").text()).toBe("Command");
    expect(wrapper.text()).not.toContain("Ambient filesystem access");
    expect(wrapper.find(".perm-mxc-ambient").exists()).toBe(false);
    expect(wrapper.findAll(".perm-actions button").map((button) => button.text())).toEqual([
      "Deny",
      "Allow once",
      "Remember for this agent",
    ]);
    await wrapper.findAll(".perm-actions button")[2].trigger("click");
    expect(wrapper.emitted("respond")).toEqual([["allow-always"]]);
    wrapper.unmount();
  });

  it("keeps high-risk actions visible without optional semantic color tokens", () => {
    const globalStyles = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");

    expect(globalStyles).toContain("--danger: var(--smtc-status-danger-foreground, #dc2626);");
    expect(globalStyles).toContain("--danger: var(--smtc-status-danger-foreground, #ef4444);");
  });

  it("hides provider explanation without changing executed command bytes", async () => {
    const command =
      "[void]'microclaw.powershell-filesystem-scope.v1';exact initializer;Remove-Item -Path 'C:\\workspace\\folder'";
    const request = {
      requestId: "initialized-request",
      type: "mxc-approval" as const,
      command,
      dirPath: String.raw`C:\workspace\cwd`,
      containmentStrength: "limited-dacl" as const,
      providerInitialization: { contract: "microclaw.powershell-filesystem-scope.v1" as const },
      declaredAccess: [{ access: "rw" as const, path: String.raw`C:\workspace` }],
      allowedDecisions: ["deny" as const, "allow-once" as const],
    };
    const wrapper = mount(PermissionDialog, { props: { request } });
    expect(wrapper.find('[data-testid="mxc-powershell-scope"]').exists()).toBe(false);
    expect(wrapper.get(".perm-command-code").text()).toBe(command);
    expect(wrapper.findAll(".perm-actions button")).toHaveLength(2);
    await wrapper.setProps({ request: { ...request, containmentStrength: "full" } });
    expect(wrapper.find('[data-testid="mxc-powershell-scope"]').exists()).toBe(false);
    expect(wrapper.get(".perm-command-code").text()).toBe(command);
    wrapper.unmount();
  });

  it("renders attended prompts above the startup loading gate", () => {
    const component = readFileSync(
      resolve(process.cwd(), "src/components/PermissionDialog.vue"),
      "utf8",
    );

    expect(component).toContain("z-index: 10001;");
  });

  it("keeps phone updates hidden without restarting the authoritative countdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = {
      requestId: "deadline-request",
      type: "mxc-approval" as const,
      command:
        "powershell.exe -NoProfile -Command \"New-Item -ItemType Directory -Path 'C:\\Approved\\folder' -Force\"",
      dirPath: "isolated-scratch:v1",
      declaredAccess: [{ access: "rw" as const, path: String.raw`C:\Approved` }],
      expiresAtUnixMs: 46_000,
      remoteDelivery: { state: "sending" as const, reason: null, replyMode: null, revision: 1 },
    };
    const wrapper = mount(PermissionDialog, { props: { request } });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await wrapper.setProps({
        request: {
          ...request,
          remoteDelivery: { state: "sent", reason: null, replyMode: "code-required", revision: 2 },
        },
      });
      expect(wrapper.find('[data-testid="mxc-phone-delivery"]').exists()).toBe(false);
      await wrapper.setProps({
        request: {
          ...request,
          remoteDelivery: {
            state: "sent",
            reason: null,
            replyMode: "simple-current-prompt",
            revision: 3,
          },
        },
      });
      expect(wrapper.find('[data-testid="mxc-phone-delivery"]').exists()).toBe(false);
      expect(wrapper.get(".perm-countdown-row").text()).toBe("Auto-deny in 35s");
      expect(wrapper.get(".perm-command-code").text()).toBe(request.command);
      expect(wrapper.find(".perm-mxc-value").exists()).toBe(false);
      expect(wrapper.find(".perm-mxc-access").exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(34_000);
      expect(wrapper.emitted("respond")).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wrapper.emitted("respond")).toEqual([["deny", "timeout"]]);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it.each([
    ["en-US", "Your agent wants to run the following command"],
    ["zh-CN", "你的智能体希望运行以下命令"],
  ] as const)(
    "uses the simplified command title and content in %s for every containment mode",
    async (locale, title) => {
      setLocale(locale);
      const request = {
        requestId: "localized-command",
        type: "mxc-approval" as const,
        command: "hostname.exe",
        dirPath: "C:\\Private",
        callerStack: "private diagnostic stack",
        remoteDelivery: {
          state: "local-only" as const,
          reason: "source-origin-unavailable" as const,
          replyMode: null,
          revision: 1,
        },
        allowedDecisions: ["deny" as const, "allow-once" as const],
      };
      const wrapper = mount(PermissionDialog, { props: { request } });
      try {
        for (const containmentStrength of ["full", "limited-dacl", "off"] as const) {
          await wrapper.setProps({ request: { ...request, containmentStrength } });
          expect(wrapper.get(".perm-title").text()).toBe(title);
          expect(wrapper.get(".perm-command-code").text()).toBe(request.command);
          expect(wrapper.find(".perm-body").exists()).toBe(false);
          expect(wrapper.find(".perm-risk-label").exists()).toBe(false);
          expect(wrapper.text()).not.toContain("C:\\Private");
          expect(wrapper.text()).not.toContain("source-origin-unavailable");
          expect(wrapper.findAll(".perm-actions button")).toHaveLength(2);
        }
        await wrapper.findAll(".perm-actions button")[0].trigger("click");
        expect(wrapper.emitted("respond")).toEqual([["deny"]]);
      } finally {
        wrapper.unmount();
        setLocale("en-US");
      }
    },
  );

  it("preserves the separate file-access dialog and grant decision", async () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        request: {
          requestId: "file-request",
          type: "file",
          dirPath: "C:\\Documents",
          accessNeeded: "ro",
        },
      },
    });
    expect(wrapper.get(".perm-body").text()).toContain("C:\\Documents");
    expect(wrapper.get(".perm-title").text()).not.toContain("following command");
    await wrapper.findAll(".perm-actions button")[1].trigger("click");
    expect(wrapper.emitted("respond")).toEqual([["grant-ro"]]);
    wrapper.unmount();
  });

  it.each(["shell", "shell-async"] as const)(
    "simplifies %s without altering escaped command text or grant decisions",
    async (type) => {
      const command = 'echo "<script> & text"';
      const wrapper = mount(PermissionDialog, {
        props: {
          request: {
            requestId: type,
            type,
            command,
            dirPath: "C:\\Work",
            accessNeeded: "rw",
          },
        },
      });
      expect(wrapper.get(".perm-title").text()).toBe(
        "Your agent wants to run the following command",
      );
      expect(wrapper.get(".perm-command-code").text()).toBe(command);
      expect(wrapper.find(".perm-command-code script").exists()).toBe(false);
      expect(wrapper.find(".perm-body").exists()).toBe(false);
      expect(wrapper.find(".perm-subtitle").exists()).toBe(false);
      expect(wrapper.find(".perm-risk-label").exists()).toBe(false);
      await wrapper.findAll(".perm-actions button")[1].trigger("click");
      expect(wrapper.emitted("respond")).toEqual([["grant-rw"]]);
      wrapper.unmount();
    },
  );
});
