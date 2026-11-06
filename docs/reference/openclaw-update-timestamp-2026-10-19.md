# OpenClaw update timestamp investigation: 2026-10-19

## Finding

This machine reproducibly changes a document's NTFS ChangeTime when a read-only
content handle is first opened. The same operation adds the kernel extended
attribute `$KERNEL.SEC.ENDPOINTDLP`. Content, LastWriteTime, file identity and
the security descriptor remain unchanged in the observed cases.

This strongly implicates Endpoint DLP metadata updates, rather than a candidate
OpenClaw process editing the old program's content. The experiments do not run
OpenClaw 2026.10.3, a Gateway, Doctor, an installer, or an updater.

The original installer failure does not identify its offending file or writer.
These results establish a local trigger for the same integrity-check failure;
they do not identify the exact historical file or prove the complete old
installation and its recovery state are healthy.

## Actual installed-file observation

On the installed 2026.9.3 package, `docs/web/tui.md` was examined with native
Windows APIs. Times below are October 19, 2026, UTC+08:00.

| Observation | ChangeTime | Endpoint DLP extended attribute |
| --- | --- | --- |
| Before opening | 16:55:36.939826 | Absent |
| After querying EA and security metadata | 16:55:36.939826 | Absent |
| After opening a read-attributes handle | 16:55:36.939826 | Absent |
| After opening a read-content handle | 16:55:37.221384 | Present |

The pre-existing `$KERNEL.PURGE.SEC.FILEHASH` cache already contained the content
SHA-256 observed after the read:

`5291bce4bb781c8822f867a8b442307425638fad9c2e40626cc4c797f4905052`

The file also matches the locally retained published 2026.9.3 package. All five
bundled `HOOK.md` documents match that package as well. Their matching bytes do
not constitute verification of the entire installation.

## Controlled observations

Four new files containing identical, known, non-sensitive bytes were created
inside an ignored project build directory. No ACL changes were made to this
four-file group. A Python ctypes probe queried metadata and extended attributes
before and after opening each file with `GENERIC_READ` and `OPEN_EXISTING`.

| Sample extension | Endpoint DLP attribute added | ChangeTime changed | Content matches expected bytes | Security descriptor unchanged |
| --- | --- | --- | --- | --- |
| `.md` | Yes | Yes | Yes | Yes |
| `.txt` | Yes | Yes | Yes | Yes |
| `.bin` | No | No | Yes | Yes |
| `.js` | No | No | Yes | Yes |

A separate six-case experiment varied old access times, creation/write times,
explicit file permissions and inherited MicroClaw read-only permissions. All
Markdown cases reproduced the first-open ChangeTime change, including the case
with no additional MicroClaw grant. Node's second read was stable. Native Windows
APIs reproduced the change too, so it is not merely a Node stat-field mapping
discrepancy. The observed file access-time updates alone do not explain the
different behavior of the identical-content file-type controls.

The Windows Defender Advanced Threat Protection service (`Sense`) was running.
No privileged filter listing or kernel write-stack capture was obtained; the
specific writer PID and driver are not established by these experiments.

## Connection to the 9.3 updater

The installed 9.3 integrity reader compares path metadata from `lstat` with
metadata from the newly opened read-only handle. Its comparison includes
`ctimeNs`. A mismatch at that point raises
`Package rollback file changed before reading`, before hashing the file.

Therefore a DLP metadata update triggered by that very open can abort the
baseline scan even when file contents have not changed. A successful candidate
canary does not rule out this independent failure during the later old-package
baseline scan.

## Artifacts and safety

Diagnostic helpers and raw observations are retained under ignored `build/`:

- `diagnose-openclaw-rollback.cjs` and `openclaw-rollback-host-diagnostic.log`.
- `diagnose-file-times.cjs` and `file-times-host-diagnostic.jsonl`.
- `diagnose-native-file-times.py` and `native-openclaw-document-ea.jsonl`.
- `diagnose-time-fixtures.ps1` and `time-fixture-diagnostic.log`.
- `ea-fixtures-e317f49b7e424af9b8085673f727be67/report.jsonl`.

Only new scratch samples had their permissions or timestamps explicitly changed.
No production ACL, installation content, configuration, database or security
policy was modified. OS/security-generated metadata changes during reads were
observed, not suppressed. No upgrade, cleanup, Gateway restart, DLP exclusion,
security-service disablement, EA removal or integrity-check bypass was performed.

No installer code or EXE was changed during the read-only investigation above.

## Implementation follow-up

After user approval, the 10.3 installer gained a controlled Windows 9.3 to 10.3
package-manager path: verified official state/workspace backup, exact-version npm
replacement at the existing prefix, then the new runtime's update repair and
its official Doctor/plugin convergence, without an additional standalone Doctor.
Interrupted repairs remain resumable; security checks are not patched
and older user state is not restored automatically. See
`openclaw-official-upgrade-test.md` for the flow, restrictions and manual test.
The real 9.3 backup command was verified against an isolated test state and a
custom workspace. The user's real installation has not been upgraded by the agent.
