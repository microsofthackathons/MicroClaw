# On-demand local-model runtime

MicroClaw does not bundle llama.cpp, CUDA runtime DLLs, model weights or embedding
weights with its desktop installer. Development and installed applications use the
same official provider-managed download path. `npm run dev`, `pack`, `dist` and the
MSIX preparation path do not download or require a llama.cpp resource directory.

## Ownership and preparation

Clicking **Download** authorizes preparation of the selected model and its missing
runtime prerequisites. The backend installs/enables the pinned official provider,
applies the in-memory compatibility adapter, hot-loads the provider and checks its
readiness before starting preparation. There is no separate runtime-install button
or repeated download confirmation.

The official provider selects the runtime for the detected hardware, downloads
missing runtime dependencies, verifies their original checksums, validates the
server, and owns model/embedding downloads, configuration and inference lifecycle.
Previously installed usable runtimes are reused from the provider's state directory.
A clean installation needs network access when local models are first prepared;
MicroClaw does not prefetch both CPU and CUDA variants at build time.

Installed provider files are unchanged. The source-hash-pinned in-memory adapter
continues to provide exact model selection, pinned ModelScope model sources and
bounded Windows runtime-directory publication retries. External llama.cpp servers
do not acquire a managed local runtime.

## Official GitHub CDN recovery

On 2026-11-05 the canonical CPU release asset returned HTTP 200 with a 507-byte XML
`BlockList`, rather than the expected ZIP. The same official asset at an equivalent
percent-encoded CDN path matched the original complete checksum. This identifies a
bad cached response, not a reason to change the runtime checksum.

For checksummed ZIPs requested from the official `ggml-org/llama.cpp` GitHub release
path only, the adapter permits one retry after a size or SHA-256 mismatch. It uses
the final response URL from the failed guarded request, percent-encoding one
unreserved character in its asset GUID. The HTTPS host, decoded asset path and
signed query remain unchanged. Only the exact `release-assets.githubusercontent.com`
host and expected asset-path format qualify; credentials, non-default ports,
unrelated paths and already encoded paths do not.

The retry calls the original provider downloader again with the same destination,
checksum, optional size, cancellation signal and progress callback. The original
SSRF guard, HTTPS requirement, partial-file cleanup, verification and publication
remain in force on both attempts. There is no global fetch interceptor, mirror,
checksum substitution, unverified execution or retry loop. Cancellation and errors
unrelated to artifact verification are not retried. A second invalid response fails
normally and preserves the previous destination.

## Validation

From `desktop/`:

```powershell
npm run test:prepared-resources
node node_modules/vitest/vitest.mjs run src/openclaw-local-model-download.test.ts src/local-model-service.test.ts src/openclaw-local-model-compat.test.ts src/local-model-sources.test.ts
```

Set `MICROCLAW_TEST_LOCAL_PLUGIN_DIR` to the installed pinned official provider
directory to additionally test its actual adapted downloader with tiny in-memory
responses. These checks cover verified recovery, repeated invalid content,
cancellation, response release and partial-file cleanup without downloading a real
runtime or model or modifying the installed provider.

## Windows Node resource publication

This separate native desktop resource remains bundled. Its preparation builds into
a unique sibling staging directory before publishing any files. An identical
complete tree is reused without touching the running development host. Changed
trees are directory-swapped with rollback; if an in-use directory cannot be moved,
the previous tree remains intact. A successfully replaced previous tree is retained
as `windows-node.previous-*` for cleanup after the development app exits, never
recursively deleted while processes may still depend on it. Failed staging trees
are cleaned separately.
