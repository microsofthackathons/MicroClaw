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
  "weixinDisclosure.title": "Send full command details to WeChat?",
  "weixinDisclosure.message":
    "Trust the currently bound, authenticated WeChat account with command approval details.",
  "weixinDisclosure.risk":
    "Complete commands, every argument and inline file contents, working directories, declared paths, new folder grants and executable identity will be sent to this account through WeChat and its service provider. Verified folder initialization and technical identifiers stay on Desktop. Sensitive information may be included: filters cannot prove that arbitrary text is public. A compromised account could read these details and approve commands or persistent folder grants. Known sensitive or opaque data and unrepresentable payloads still require Desktop approval. This does not grant durable command approval consent or broaden any command's execution scope. Existing pending phone approvals will become Desktop-only without changing their deadlines; they will not be resent. Revoking consent stops new command disclosure and phone approvals, but cannot retract details already sent.",
  "weixinDisclosure.keepDesktop": "Keep approvals on Desktop",
  "weixinDisclosure.allow": "Trust bound account: share command details",
  "weixinDisclosure.cancel": "Cancel",
  "weixinRemoteApproval.consentTitle": "Remote command approval",
  "weixinRemoteApproval.consentMessage":
    "Choose whether the currently signed-in WeChat account can approve commands for this MXC activation.",
  "weixinRemoteApproval.consentRisk":
    "A compromised WeChat session could approve commands or add displayed RO/RW folder grants on this PC. For folder prompts, 1 saves the displayed grants until removed in Settings and approves the current command once; 3 denies. Other command prompts offer allow once or deny. A delayed reply can affect a newer prompt. Sharing full command details requires separate native consent in Security settings. Disabled keeps approval on this desktop.",
  "weixinRemoteApproval.disable": "Disabled",
  "weixinRemoteApproval.enable": "Enabled",
  "weixinRemoteApproval.cancelActivation": "Cancel MXC activation",
  "mxc.assessingLimitedAmbientAccess": "Assessing Limited-mode ambient filesystem access",
  "mxc.verifyingFullBackend": "Verifying the Full AppContainer backend",
} as Record<string, string>;
