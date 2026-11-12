# Chat image transport and history: 2026-11-04

## Decision and scope

For [#168](https://github.com/microsofthackathons/MicroClaw/issues/168), keep the existing **raw Base64 attachment envelope over authenticated Gateway JSON RPC**. File selection and clipboard import already use this path; image drag-and-drop should reuse it. Do not send renderer-controlled filesystem paths, introduce remote image hosting, or add a second history cache to implement another input gesture.

MicroClaw already supports images through the merged file-attachment and clipboard work, [#160](https://github.com/microsofthackathons/MicroClaw/pull/160) and [#179](https://github.com/microsofthackathons/MicroClaw/pull/179). This investigation documents that implementation and identifies follow-up work; it does not change application behavior.

Evidence is pinned to MicroClaw `a2a49b719ba9b180d351009a611565078337b3af`, the installer target in [`deployer/openclaw_version.py`](../../deployer/openclaw_version.py), and the installed OpenClaw **2026.10.5** package. The upstream annotated tag `v2026.10.5` resolves to commit `1b58cb9a1b4f4353e1add63c8506db4d890962e8`. The linked upstream sources below use that commit, rather than moving documentation. Internal bundle names in the probe are specific to this package build.

## Transport and security boundaries

| Boundary | Actual representation and ownership |
| --- | --- |
| File picker → Main | Main opens the native picker, reads selected files and encodes bytes. Renderer receives `ChatAttachment { type, mimeType, fileName, size, content }`; `content` is raw Base64, without a Data URL prefix. |
| Clipboard → Main → Renderer | Renderer serializes image `File` objects to `ArrayBuffer` for IPC. Main accepts supported image MIME types, sanitizes names, deduplicates identical bytes within that import batch, stages temporary files, then uses the same attachment preparation path. The temporary batch directory is removed in `finally`. |
| Renderer → Main | `chat:send-message` carries the current text and attachment envelopes. Main revalidates the object shape, Base64 encoding, decoded size and aggregate limits, along with existing chat/model readiness gates. |
| Main → Gateway | `GatewayClient.sendChat` sends `chat.send { sessionKey, message, deliver:false, idempotencyKey, attachments }`. It strips the local `size` field and sends `type`, `mimeType`, `fileName`, `content`. Only the current turn is uploaded; the server maintains conversation history. |
| Gateway → transcript/model | Gateway inspects MIME/bytes and prepares image blocks or managed media. It saves inbound images and records durable `media://inbound/<id>` facts and image ordering metadata for the owning user turn. Retained facts can be hydrated into transient `{ type:"image", data:<Base64>, mimeType }` model context. The provider adapter owns the final provider-specific request format. |

Local evidence: [`chat-attachments.ts`](../../desktop/src/chat-attachments.ts), [`preload.ts`](../../desktop/src/preload.ts), [`main.ts`](../../desktop/src/main.ts) handlers, [`gateway-client.ts`](../../desktop/src/gateway-client.ts), [`chat-clipboard.ts`](../../desktop/renderer/src/utils/chat-clipboard.ts), and [`chat.ts`](../../desktop/renderer/src/stores/chat.ts). Upstream: [Gateway attachment preparation](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/gateway/chat-attachments.ts), [durable turn assembly](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/gateway/server-methods/chat-send-user-turn.ts), and [prompt-image hydration](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/embedded-agent-runner/run/images.ts).

Main's validation is a transport-size/encoding check, not a content safety scanner. Picker MIME inference uses the extension; the upstream parser subsequently sniffs the content and the image sanitizer checks decodability. Strict privacy currently redacts message **text** in the renderer; that does not redact faces, text or other private information embedded in image pixels. An attachment is an explicit user upload, not a grant for arbitrary later host-path access.

### Format alternatives

| Format | Compatibility and tradeoff | Decision |
| --- | --- | --- |
| Raw Base64 envelope | Existing `chat.send` contract; works without sharing a local filesystem. Base64 requires `4 * ceil(bytes / 3)` characters, plus JSON/IPC copies. | Keep for current desktop uploads. |
| Data URL | The pinned Gateway parser accepts a `data:<mime>;base64,` prefix, but MicroClaw validates raw Base64 before it reaches Gateway. Adds metadata text without reducing bytes. | Use for a UI preview if needed; do not change the wire contract. |
| Local path / `file:` URL | Upstream can detect explicit local image references and hydrate them subject to workspace/sandbox/local-root checks. A renderer path is not a portable upload, and another machine's Gateway cannot read it. | Do not substitute paths for user-uploaded bytes. |
| Managed `media://inbound/` reference | Gateway-owned durable identity, resolved with local-media authority. Avoids embedding original image bytes in every persisted user entry. It can still be hydrated into provider input. | Let Gateway own persistence and reuse; do not mint references in Renderer. |
| Remote HTTPS URL | Some media/channel APIs accept URLs; that does not make `chat.send.attachments[].content` a URL field. The pinned prompt image path does not hydrate arbitrary HTTP image facts as local attachments. Hosting introduces disclosure, fetch policy and lifetime concerns. | No remote hosting for this feature. |
| Binary WebSocket payload | Binary IPC already exists for clipboard input. Current Gateway attachment RPC expects a Base64 string, not a multipart/binary upload. | An upstream protocol change would be needed; not required for drag-and-drop. |

Upstream local-reference rules are in [images.ts](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/embedded-agent-runner/run/images.ts) and [images.media-refs.ts](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/embedded-agent-runner/run/images.media-refs.ts). Channel `--media <path-or-url>` support is a different entrypoint from desktop `chat.send`.

### Limits are not aligned yet

| Layer at this baseline | Limit / behavior |
| --- | --- |
| MicroClaw Main | 20 MiB decoded per file, 50 MiB decoded per message; checked again at send. No image resize during import. |
| OpenClaw attachment parser | Default 20 MiB decoded per attachment, configurable through `agents.defaults.mediaMaxMb`; an image has a separate **6 MiB** cap. Images larger than **2,000,000 bytes** normally offload to managed media; smaller inline images are also persisted for transcript ownership. Text-only models force image offload rather than acquiring native vision support. |
| Gateway WebSocket | 25 MiB maximum incoming payload. The advertised decoded attachment budget reserves 256 KiB for the envelope, then accounts for Base64 expansion: **19,464,192 bytes** under defaults; advertised `maxImageBytes` is **6,291,456**. A 50 MiB accepted desktop aggregate can greatly exceed the frame limit. |
| Model-facing sanitizer | Default maximum side **1200 px** and byte target **5 MiB**; default generic sanitizer input ceiling **10 MiB**. Callers may pass tighter/different byte targets, including the 6 MiB prompt hydration budget. Oversized dimensions trigger resize/JPEG encoding; invalid/unprocessable images can become omission notices. These are separate stages, not one universal accepted-size limit. |

Sources: [MicroClaw constants](../../desktop/src/constants.ts), [Gateway attachment policy](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/gateway/chat-attachment-policy.ts), [frame budget](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/shared/chat-attachment-frame-budget.ts), [server constants](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/gateway/server-constants.ts), and [image sanitizer](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/tool-images.ts).

Thus a successful local import or thumbnail does **not** prove Gateway/model acceptance. Sending only a reference would not fix provider vision support, and compression after Gateway admission cannot rescue an image rejected by the earlier parser/frame limit.

## Historical images and token use

The renderer's `chat.history` request (`limit:200`) is for UI history retrieval. It does not set the model's replay window, and the renderer does not resend those 200 messages on every send.

In the pinned embedded runner, surviving user-turn media facts are hydrated before provider calls; retained image blocks therefore can appear again on subsequent turns or tool-loop requests. Rehydration may read bytes and encode Base64 again. The sanitizer has an in-process SHA-256-keyed LRU for verified image outcomes (4096 entries, 16 MiB budget), including unchanged-image verification and resized replacements. That can avoid repeated decoding/resizing work, but does not itself remove a retained image from the model context or guarantee a provider cache hit. Gateway disk offload and provider prompt caching solve different problems. [Hydration source](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/embedded-agent-runner/run/images.ts), [sanitizer cache](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/tool-images.ts).

**2026.10.5 already has image-specific replay cleanup.** `pruneProcessedHistoryImages` preserves at least the 3 most recent completed turns, counting text-only turns too. Its boundary advances at a new user turn, first removing one eligible turn and then in batches of 8. Between cuts, 3–10 completed turns remain eligible to retain images, plus the active user turn. It replaces older user/tool-result image blocks with a text marker and removes their owned media facts/layout so hydration cannot silently bring them back. The canonical transcript is not rewritten. This is separate from cache-TTL tool-result pruning. [Pinned cleanup implementation](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/embedded-agent-runner/run/history-image-prune.ts), [pinned documentation](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/docs/concepts/session-pruning.md#legacy-image-cleanup).

For one image in every completed turn, the executable probe below observed:

| Completed turns before the active user turn | Prior image-bearing turns retained in replay | Active image retained |
| --- | --- | --- |
| 0 / 1 / 3 | 0 / 1 / 3 | Yes |
| 4 / 5 / 11 | 3 / 4 / 10 | Yes |
| 12 / 13 / 20 | 3 / 4 / 3 | Yes |

This is a turn window, not a three-image cap: a retained turn can contain several images. Cleanup also does not bound total image tokens or replace normal context limits. The runner additionally applies configured history-window limits and compaction; compaction retains summaries rather than all old detailed turns. Retaining original media on disk allows history display and intentional later inspection without making every old image part of every prompt. [History-window application](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/src/agents/harness/builtin-openclaw.ts), [pruning versus compaction](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/docs/concepts/session-pruning.md#pruning-vs-compaction).

Images in a provider request can consume vision input tokens/context. **Neither the Base64 character count nor repeated inclusion establishes an exact bill.** Vision accounting, native conversation state, cache eligibility and cache read/write pricing are provider/model-specific. A disk reference or local resize-cache hit does not establish free reuse. Provider usage and cache counters are needed to distinguish fresh input from cached input; configured cost rates can be estimates. This investigation made no paid model calls and does not report measured tokens, cache savings or account charges. See the [versioned token-use guide](https://github.com/openclaw/openclaw/blob/1b58cb9a1b4f4353e1add63c8506db4d890962e8/docs/reference/token-use.md).

## Recommended follow-up and acceptance measurements

1. **Align desktop admission with Gateway capability limits first.** Consume the authenticated connection's advertised attachment policy, enforce aggregate encoded-frame size before send, and show image-specific rejection before upload. Cover 6 MiB image boundaries, cumulative multi-image frames, reconnects to a different policy and a file that grows during import. Preserve Main-side validation; never solve a mismatch by weakening Gateway checks.
2. **Measure optional pre-upload downscaling.** A configurable lower-resolution copy can reduce IPC/WebSocket copies and avoid the parser ceiling; keep the original private/local and preview the copy that will be sent. Validate screenshots containing small text and diagrams, orientation, transparency, animation and unsupported formats. Do not silently flatten/lose detail simply to reduce bytes. The local fixture's solid PNG grew from approximately 6.2 KiB to 19.8 KiB when converted to 1200×600 JPEG: fewer pixels do not guarantee fewer wire bytes.
3. **Reuse the existing upstream history cleanup before designing a new one.** For heavy image sessions, use a throwaway session and synthetic nonprivate images to capture only per-call image count, dimensions, decoded byte totals and hashes at the provider boundary. Exercise 1, 4, 11 and 12 completed turns, multiple images per turn, a tool loop, restart and compaction. Check raw transcript preservation, old-fact nonrehydration and deterministic replay. Run separately per supported provider adapter; this document's direct-function probe is not a full Gateway-to-provider capture.
4. **Only then evaluate cost-oriented changes.** Compare baseline versus an explicitly chosen smaller `agents.defaults.imageMaxDimensionPx`, and compare fresh sessions against retained-history sessions using identical prompts. Collect provider-reported input/output/cache-read/cache-write usage and any billed-usage fields, plus elapsed time and task accuracy. Separate warm/cold cache runs and report unavailable counters as unknown. Do not infer dollars from a screenshot or image byte size. If meaningful image cost remains, propose a bounded image-retention/description policy upstream with explicit reinspection and fidelity criteria; do not insert lossy summaries into MicroClaw history without a user-visible policy.

No upstream transport change is required for current image input or drag-and-drop. Binary upload negotiation or a configurable image-retention policy would require separate upstream design/validation. The size-policy mismatch is concrete follow-up work, not implemented by this documentation change.

## Reproducible offline probe

Executed on Windows with Node **26.13.0**, the existing OpenClaw **2026.10.5** package and its installed dependencies. No Gateway was started, no credentials or user transcript were read, and no provider/network request was made by the probe. It calls actual installed parser, sanitizer, hydration and prune exports; it does not replace them with a model of their implementation.

Use an empty scratch directory as the working directory. The probe creates `.tmp-issue168` underneath it and isolates `OPENCLAW_HOME`, state, config and temporary paths before importing runtime code. Hashed internal module names intentionally fail on another build; re-audit exports instead of guessing aliases. The image processor must be available to reproduce the resize check.

Run the [committed probe](fixtures/chat-image-transport-2026-11-04.mjs) with an absolute package path, for example on PowerShell:

```powershell
node C:\path\to\MicroClaw\docs\reference\fixtures\chat-image-transport-2026-11-04.mjs C:\path\to\node_modules\openclaw
```

The script rejects missing arguments, any package version other than `2026.10.5`, and changes to four audited bundle SHA-256 fingerprints before loading runtime modules. It prints those hashes with the results. Re-audit the source and fixture together when changing OpenClaw versions.

The probe passed all nine history-boundary cases, canonical-history preservation, idempotence, structured-media pruning/nonrehydration, raw Base64 and Data URL parsing, unchanged small-image bytes, invalid/oversized-image omission, and actual 1600×800 PNG → 1200×600 JPEG processing. It printed default advertised limits of `maxBytes:19464192`, `maxImageBytes:6291456`. This does not test native UI gestures, a running Gateway's durable file ownership, provider serialization, real model recognition, billing, compaction/restart integration or other model harnesses. No application runtime code changed. Full application build/test suites were not rerun for this investigation; the publishing agent must report the combined batch gates separately.
