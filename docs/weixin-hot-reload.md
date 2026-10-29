# WeChat connection lifecycle

## Lightweight, enabled by default

WeChat has no user-facing plugin switch. When starting its own Gateway,
MicroClaw converges the bundled plugin and enables its entry and allowlist
membership before the Gateway starts. It does not modify a running external
Gateway or override Windows Node + MXC isolation policy.

Registration does not load the outbound hook runtimes. Those SDK imports are
deferred until outbound work, while the message monitor remains lazily loaded
when an authenticated account starts. QR rendering is also loaded on demand.
The app window is created before Gateway startup; no new startup network probe
is added. Best-effort WeChat start/stop notifications have a two-second budget.

Previously, `plugins.setEnabled` rebuilt plugin registries, imported discovery
and full runtime modules, and waited for catalog work. The connection UI no
longer invokes that global hot-reload path. The compatibility IPC remains for
older callers, but it is not used to connect or disconnect WeChat.

## Connect and close

The bottom-left **WeChat** shortcut opens an anchored QR popover with one click;
the sidebar no longer shows or polls a Token usage snapshot. Its connection
surface mounts only after the first click and does not poll while hidden.
Hovering over the shortcut never starts a login. Both settings pages retain
the same connection card and QR renderer. Only clicking the shortcut or
**Connect** starts a QR login; startup and read-only status polling never start
or refresh one. The main process owns a single QR session and serialized long
polling. Closing the popover or dialog, or leaving the page, hides it immediately and cancels that
session in the background through the plugin's `weixin.login.cancel` method.
Cancellation aborts the network poll and prevents a late response from saving
credentials. A subsequent explicit connection waits for cancellation to drain
before it creates a fresh QR; an already completed connection is not logged out.

The returned session key is passed to every poll. A polling-window timeout is
not a login timeout: it preserves the session and reports `pending`. QR expiry
stops polling immediately and releases the login fence without fetching another
code. The dialog keeps the expired code under a non-scannable overlay; clicking
that overlay explicitly starts a fresh QR. Expiry is not shown as a card error,
and old QR failures are not restored when opening the settings page.
The plugin commits credentials transactionally before returning success;
the Gateway's native `web.login.wait` handler starts the account in process.
There is no config timestamp reload or managed Gateway restart on this path.

The dialog supports ordinary QR authorization. If WeChat requests a numeric
pairing code, it reports that this flow is unsupported rather than hanging on
the Gateway's stdin. The standalone CLI login retains its interactive flow.

## Status and disconnect

**Connected** requires both a valid single stored account and the matching
runtime account's `connected` flag. Stored credentials, registration, and
`running` alone are not sufficient. Successful start notification or an
authenticated updates response sets connection status; API failures and stops
clear it. Read-only runtime checks are cached for two seconds and fail closed
if the Gateway connection changes.

**Disconnect** uses native `channels.logout`. The Gateway first stops the
account and aborts its updates poll, then the plugin transactionally removes
credentials, sync/context artifacts, the account allowlist, and its index entry.
Cleanup failure restores the previous artifacts and reports an error. Other
channels and the loaded plugin remain untouched. No Gateway restart is used.

MXC mutation locks and account-generation fences remain in force. Ambiguous
transport failures never automatically start another login writer. An explicit
Gateway stop may still be necessary to recover an _unconfirmed_ operation;
normal dialog close, successful connection, and logout do not require one.

## Validate and deploy

From `desktop/`:

```powershell
npx vitest run src/weixin-connection.test.ts src/weixin-plugin-lifecycle.test.ts src/weixin-mutation-coordinator.test.ts src/weixin-login-lifecycle.test.ts
npm run test:weixin-runtime
npm run prepare-weixin-plugin-resource
```

From `desktop/renderer/`:

```powershell
npx vitest run src/components/SidePanel.test.ts src/components/WeixinConnectionShortcut.test.ts src/views/weixin-account-status-views.test.ts src/views/WeixinLoginCancellation.test.ts
```

Restart the development app once after rebuilding the bundled resource so its
main process and the managed Gateway load this implementation. Resource
convergence is intentionally deferred while an old Gateway is still running.
