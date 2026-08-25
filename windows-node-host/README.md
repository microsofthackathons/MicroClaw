# MicroClaw Windows Node Host

This project is the app-owned, headless Windows execution host for the experimental
Windows Node + MXC mode. It has no Companion UI, tray, MCP endpoint, media, browser,
screen, input, or device capabilities.

The security-sensitive CWD and durable-approval implementation is maintained here.
Transport and MXC execution are integrated by the desktop lifecycle only after the
host's exact `microclaw.windows-cwd.v1` attestation and packaged runtime hashes pass.

Building requires the .NET 10 SDK and the pinned
`third_party/openclaw-windows-node/source` submodule.

Use the repository resource-preparation script to publish the helper. Direct
`dotnet` test/build commands must pass
`-p:ImportDirectoryBuildProps=false -p:ImportDirectoryBuildTargets=false` so the
headless import does not acquire the upstream Companion application's build targets.
