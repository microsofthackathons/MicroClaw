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
    "A compromised WeChat session could approve commands or add displayed RO/RW folder grants on this PC. For folder prompts, 1 saves the displayed grants until removed in Settings and approves the current command once; 3 denies. Other command prompts offer allow once or deny. A delayed reply can affect a newer prompt. Eligible command details are shared automatically with the bound account through WeChat. Disabled keeps approval on this desktop.",
  "weixinRemoteApproval.disable": "Disabled",
  "weixinRemoteApproval.enable": "Enabled",
  "weixinRemoteApproval.cancelActivation": "Cancel MXC activation",
  "mxc.assessingLimitedAmbientAccess": "Assessing Limited-mode ambient filesystem access",
  "mxc.verifyingFullBackend": "Verifying the Full AppContainer backend",
} as Record<string, string>;
