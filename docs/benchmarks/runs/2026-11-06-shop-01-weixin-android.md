# SHOP-01 WeChat Android environment probe — 2026-11-06

## Scope and result

Prepared the existing Android emulator for a future WeChat-originated SHOP-01 run. This is an environment probe, not a completed phone-channel benchmark or an agent-quality result.

| Check | Observed result |
| --- | --- |
| Android Emulator | 37.1.11.0, build 15917651 |
| Hardware acceleration | WHPX installed and usable, according to `emulator -accel-check` |
| Existing virtual device | `OceanaDemo_WeChat_API37` |
| ADB device | `emulator-5556` |
| Android boot | `sys.boot_completed=1` |
| Android version | Android 17, API 37 |
| Installed WeChat package | `com.tencent.mm`, version 8.0.76, versionCode 3141 |
| WeChat login | NOT_RUN; no login or authentication UI was automated |
| Message sent from WeChat | NOT_RUN |
| MicroClaw WeChat ingress and routing | NOT_RUN |
| Model identity and execution | NOT_RUN in this probe; the requested Copilot model remains to be verified |
| Response received and rendered in WeChat | NOT_RUN |

No SDK, system image, or application was downloaded or installed. The pre-existing AVD was launched with `-read-only -no-snapshot`, without wiping data or saving a snapshot. Emulator window discovery succeeded; the subsequent Computer Use window-view approval timed out. No UI input or message sending followed that timeout.

The emulator was left running for the user to complete login manually. Read-only mode is deliberate: this session's changes must not be assumed to persist after shutdown. Do not copy or export login credentials into benchmark artifacts.

## Local evidence

Generated artifacts are under `build/benchmarks/shop-01/weixin-android-probe-2026-11-06-v1/`:

- `launch.json`: launch time, process ID, AVD, serial, and startup arguments.
- `emulator.stdout.log` and `emulator.stderr.log`: startup diagnostics.
- `environment-check.json`: selectively recorded boot and package metadata, without account or chat data.

These are local environment artifacts, not a scored `capture.json`. The existing Replay results and their phone-channel NOT_RUN status are unchanged. No success rate, model cost, or phone latency is inferred from this probe.

## Next acceptance check

After the user completes WeChat login and grants window access, start with one SHOP-01 conversation rather than the full repeated suite:

1. Verify the intended MicroClaw WeChat account and actual Copilot model ID without exposing credentials or replacing an existing account.
2. Send the initial shopping prompt from the emulator's real WeChat client to the intended agent conversation.
3. Verify that the actual WeChat plugin receives the message and routes it to the correct Gateway session. This plugin uses upstream `getUpdates` and downstream `sendMessage`; a direct `chat.send` call is not a substitute for this check.
4. Receive the clarification in WeChat, send the follow-up from the same conversation, and verify session continuity.
5. Receive the final result in WeChat and inspect long-message splitting, prices, links, and readability on the phone-sized display.
6. Record send, ingress, model, outbound, and client-visible receipt evidence separately. Missing evidence remains unverified, not an assumed pass.

Do not treat this future emulator test as a physical-phone test. Keep channel reliability, UI presentation, and SHOP-01 shopping-answer quality separate. A real-channel Live shopping run also does not inherit the Replay fixture oracle or its lowest-price ground truth.

## Login follow-up — 2026-11-06

After the user reported completing login, a freshly selected and activated emulator window showed the WeChat home screen, rather than a login screen. This verifies client readiness only; no account identifier or chat content was exported.

MicroClaw's **Settings → Channels** page still displayed the WeChat **Connect** button. Its Gateway connection indicator was connected, but that is not evidence that the WeChat channel is connected. The application was left on the Channels page for the user to complete the QR authorization manually. No Connect, login confirmation, or message-send action was automated.

Read-only inspection of the local configuration showed `agents.defaults.model.primary` set to `github-copilot/gpt-5.6-sol`. This is the configured default, not a verified per-request model identity, and does not establish that the previously requested GPT-6.1 model is available. The configuration was not changed.

The initial environment-check record is retained unchanged. A separate `readiness-check.json` records this follow-up. Message round-trip, channel routing, model execution, SHOP-01 quality, and phone latency remain NOT_RUN.

Window automation recovered after reselecting and activating the target windows. Initial captures and accessibility geometry did not reliably reflect the visible target; final readiness observations use the refreshed visible screenshots. No benchmark message was sent using those stale observations.
