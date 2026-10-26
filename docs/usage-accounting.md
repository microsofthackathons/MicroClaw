# Token usage accounting

The desktop combines two non-overlapping sources:

- OpenClaw `sessions.usage`, with `agentScope: all`, for retained session usage across agents. This includes chat and any heartbeat or scheduled work whose model usage is stored in a session transcript.
- A local ledger of OpenClaw's structured `plugin llm completion` records for `isolated-agent-runtime` and `direct-provider` execution. These inference paths bypass session transcripts. Memory-core dreaming narratives use this path.

The same merged result supplies the sidebar, settings usage, and usage drawer. Background calls contribute to totals, daily buckets, model/provider/agent breakdowns, and request counts, but do not create fake sessions, chat messages, or tool calls.

The drawer labels session usage as "Sessions (chat, heartbeat, etc.)" rather than claiming that all retained session usage is chat. Historical session aggregates do not reliably distinguish a heartbeat from chat in a shared session. A skipped heartbeat does not itself add token usage.

## Persistence and recovery

The ledger lives in the Electron user-data directory at `usage/background-requests.json`. It retains 90 days of normalized timestamps, source categories, model/provider/agent identifiers, numeric usage, and SHA-256 record identifiers. It never stores raw log lines, prompts, responses, or credentials.

The Gateway's `logs.tail` endpoint supplies the active log path. The importer reads that file and its daily rolling-log family incrementally, and can recover earlier background calls while those logs remain available. Record fingerprints and occurrence numbers prevent repeated queries, application restarts, and copied rotation files from counting the same record twice, without collapsing two identical records in a file.

Both sources use the existing UTC usage date buckets. Input, output, cache-read, and cache-write counters are added separately; reasoning tokens are not added on top of provider-reported output usage.

If background logs cannot be read, the app retains cached ledger entries and shows an incomplete-usage warning. It does not invent usage from scheduled-task executions or infer a missing request from matching token totals. Missing logs, suppressed completion logging, failed requests without a completion record, and direct API tests outside these OpenClaw paths cannot be recovered by this importer. This view is recorded application usage, not an authoritative provider billing ledger.
