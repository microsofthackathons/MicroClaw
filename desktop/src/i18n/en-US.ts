export default {
  "perm.remoteNotify": "Please grant permission in Windows so I can proceed",
  "perm.retryNudge":
    'Permission granted for "{dir}" ({access}). Please retry the previous operation.',
  "perm.accessRW": "read-write",
  "perm.accessRO": "read-only",
  "tray.status.stopped": "Gateway Stopped",
  "tray.status.starting": "Gateway Starting...",
  "tray.status.running": "Gateway Running",
  "tray.status.restarting": "Gateway Restarting...",
  "tray.status.failed": "Gateway Failed",
  "tray.status.stopping": "Gateway Stopping...",
  "tray.status.timeout": "Gateway Timeout",
  "tray.open": "Open MicroClaw",
  "tray.restartGateway": "Restart Gateway",
  "tray.quit": "Quit",
  "weixinRemoteApproval.consentTitle": "Remote command approval",
  "weixinRemoteApproval.consentMessage":
    "Choose whether the currently signed-in WeChat account can approve commands for this MXC activation.",
  "weixinRemoteApproval.consentRisk":
    "A compromised WeChat session could approve commands or save exact-scope approvals on this PC. Replies 1/2/3 act on the current delivered prompt: a delayed reply can affect a newer prompt. 2 requires existing exact-conversation durable consent and command eligibility. Disabled keeps approval on this desktop.",
  "weixinRemoteApproval.disable": "Disabled",
  "weixinRemoteApproval.enable": "Enabled",
  "weixinRemoteApproval.cancelActivation": "Cancel MXC activation",
  "weixinRemoteApproval.activationDefault":
    "Experimental WeChat command approvals will use the signed-in account. Each command still needs approval; this does not grant durable approval authority or permission to expose full command details.",
  "mxc.toggleTitle": "Change sandboxing?",
  "mxc.toggleRestart": "MicroClaw's backend will restart. This window will stay open.",
  "mxc.toggleCancel": "Cancel",
  "mxc.toggle.full":
    "This PC supports Full containment. Approved folders form an exclusive filesystem boundary.",
  "mxc.toggle.limited-dacl":
    "This PC supports Limited containment (DACL), not Full containment. By enabling it, you acknowledge that folder grants add access, not an exclusive filesystem allowlist. Read-only grants cannot reduce access already permitted by Windows ACLs. Sensitive ambient access must pass validation before activation.",
  "mxc.toggle.off":
    "Sandboxing will be turned off. Tools will run with your Windows account's permissions and without MXC isolation.",
  "mxc.toggleCapabilities":
    "Sandboxing disables Gateway file tools, browser automation, MCP, screen/camera/location/speech, and Gateway memory. Scheduled jobs and hooks/webhooks pause without catch-up or replay. Approved sandbox commands, web search/fetch, allowlisted WeChat, and reviewed Canvas remain available.",
  "mxc.toggleConfirm.full": "Enable sandboxing",
  "mxc.toggleConfirm.limited-dacl": "Accept Limited protection and enable",
  "mxc.toggleConfirm.off": "Turn sandboxing off",
  "mxc.assessingLimitedAmbientAccess": "Assessing Limited-mode ambient filesystem access",
  "mxc.verifyingFullBackend": "Verifying the Full AppContainer backend",
} as Record<string, string>;
