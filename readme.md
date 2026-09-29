# powershell-telemetry

Record interactive PowerShell commands without turning their terminals into pipelines. The Windows ConPTY host preserves real console handles, ANSI styling, hyperlinks, native stderr, keyboard input, full-screen applications and window resizing. A separate Bun process exports telemetry to VictoriaTraces without placing network requests on the command execution path.

Requires Windows with ConPTY, PowerShell 7.4 or newer, PSReadLine and Bun. The terminal integration is tested on Windows; archive verification and export are portable Bun code.

## Install or upgrade

```powershell
bun run install-profile --endpoint http://10.0.0.22:3303/insert/opentelemetry/v1/traces
```

**Open a new terminal window after installation.** Existing shells retain their previously loaded hooks and C# types; dot-sourcing an updated profile is not a supported migration.

The installer places a managed bootstrap block at the beginning of `$PROFILE.CurrentUserCurrentHost`. It preserves the rest of the profile, including prompt functions, oh-my-posh configuration, sound handlers and completions. An old telemetry footer is migrated instead of duplicated. The original `.before-powershell-telemetry` backup is never overwritten. `--profile <path>` selects a different profile file; `--archive-root <directory>` selects the session archive location. The installer records the Bun executable used during installation; reinstall after moving or removing that executable.

The bootstrap opens the interactive shell inside the recorder. Profiles run in that shell, then the telemetry hook chains the configured prompt and PSReadLine callbacks. No command aliases, application allowlists, global color variables or per-command comments are needed:

```powershell
gcp mage && bun scripts/runFixture wtop space_bunny
```

Automatic startup applies to ordinary interactive ConsoleHost sessions. Redirected sessions and `pwsh -Command`, `-EncodedCommand` or `-File` launches are not automatically relaunched. These exclusions avoid changing unattended invocations or discarding their startup commands. Profiles with top-level `using` or `param` headers, or Authenticode signatures, should use the explicit launcher rather than an injected bootstrap:

```powershell
bun run start --endpoint http://10.0.0.22:3303/insert/opentelemetry/v1/traces
bun run start --endpoint http://localhost:4318/v1/traces --no-profile
```

`POWERSHELL_TELEMETRY_ENDPOINT` can supply the launcher's endpoint. The explicit launcher should be run from a normal terminal, not from a shell still using the old stream-capture wrapper.

The current-user-current-host profile is deferred to the child shell. Any earlier all-host or all-user profiles have already run in the original PowerShell startup and will also run in the child. Use the explicit `-NoProfile` launcher with a deliberately configured profile when those earlier files have non-repeatable side effects. Nested shells inherit the recording session instead of starting another recorder; their terminal output belongs to the enclosing command.

## Why this does not break ANSI or native programs

There is no `*>&1 | Out-PowerShellTelemetry` pipeline, output-stream replacement or source-code wrapper. Native programs receive console handles and decide their own terminal capabilities normally. They can use raw input, alternate screen buffers, progress updates and hyperlinks. Native stderr is displayed as native terminal output, not converted into a PowerShell `ErrorRecord` and painted red. Real PowerShell errors still use PowerShell's normal presentation.

Explicit user pipelines remain explicit pipelines. A program whose stdout is deliberately piped or redirected still sees a non-terminal stdout. Binary file redirection is not decoded, reformatted or copied into telemetry. Assignments, functions, working-directory changes, top-level `using` and `param`, `$?`, `$LASTEXITCODE`, `return`, `exit` and command history retain their shell semantics.

The host relays input and output on independent threads and propagates window dimensions. Ctrl+C is forwarded to the child console. The child clears an inherited ignore-Ctrl+C process flag before loading user profiles, so launching through another process runner does not disable cancellation. User profile configuration happens afterward.

## Recording model

The shell hook returns the exact submitted command to PowerShell. Before execution it emits a session-tagged lifecycle frame; at the next prompt it emits the observed result and retained PowerShell error details. These frames travel through the same terminal transport as displayed output, preserving boundary order. The host consumes only its own frames and forwards other terminal sequences without interpreting them as telemetry commands.

| Record | Contents |
| --- | --- |
| `session.ready` | Hook initialization and shell identity |
| `start` | Exact command source, working directory, shell version, process ID and start time |
| `output` | Complete terminal bytes in numbered base64 chunks, with byte offsets and timestamps |
| `complete` | Result, duration, PowerShell errors, native command lookups, output counts, SHA-256 and a bounded preview |
| `resize` | Terminal columns and rows |
| `capture.error` | A shell lifecycle-hook failure that did not block command execution |
| `barrier` | A synchronization high-water mark |
| `session.end` | Shell exit code and recording health |

**Terminal output is not separate native stdout and stderr.** ConPTY presents a combined terminal view and can normalize console operations into VT screen updates. Telemetry therefore labels it `terminal-vt`, not `stdout` or `stderr`. The archive retains the exact bytes the recorder forwards, including styling and screen redraws; it does not claim to reconstruct the application's original write calls. PowerShell errors are also retained as structured metadata, including exception text, category, error ID, invocation position and script stack trace. Native lookups are lookup observations, not an OS process audit.

The recorder does not log stdin or keystrokes. Line editing and prompts outside an active command are not archived. Output that an application displays is recorded, including echoed input and screen redraws that reproduce earlier screen contents. Assigned output, discarded output and file redirection are not terminal output and are not intercepted. Background output visible during a command is attributed to that command; this is a command-session transcript, not per-process stream provenance.

A successful command has result code `0`. A failed command uses its most recent nonzero native exit code when a native lookup was observed, otherwise `1`; the raw native exit code is retained as well. An explicit shell exit uses the actual shell process exit code. A command interrupted by shell termination without a known command result is marked `interrupted`; no successful result is invented. Force-killing the recorder can leave an open command and an incomplete final journal line, both detectable by inspection.

## Full output and durable storage

Archives default to:

```text
%LOCALAPPDATA%/powershell-telemetry/sessions/<session-id>/
```

Each session directory has a protected Windows ACL granting access to the current user and SYSTEM. Archives contain full command text and terminal output, which can include secrets. They are not redacted and are not automatically deleted.

| File | Purpose |
| --- | --- |
| `manifest.json` | Session identity, endpoint, process IDs and initial terminal dimensions |
| `events.jsonl` | Canonical append-only record journal |
| `delivery.sqlite` | Durable delivery outbox, export cursor and command correlation state |
| `capture.json` | Recorder health and hook readiness |
| `status.json` | Export progress, queue state and delivery health |
| `agent.log` | Exporter diagnostics |
| `requests/` | Bounded synchronization requests and responses |

Output chunks are at most 4096 raw bytes. The searchable preview retains up to 16 384 UTF-8 bytes from the beginning and end, preserving Unicode characters. **That limit applies only to the preview.** All captured terminal bytes remain in the journal and are exported separately. Completion records include the total byte count, chunk count and SHA-256, so missing, reordered or modified output is detectable.

Lifecycle frames have a 16 MB guard and the journal reader has a 32 MB per-record guard. Exceeding a guard is an explicit capture or read failure, never silent truncation. Terminal output is chunked, so these limits do not cap total command output.

The recorder flushes each output record to the filesystem and uses a durable flush at command boundaries. An abrupt power failure can still lose recently buffered output between durable flushes. Disk errors are surfaced and recorded as capture failures where storage remains possible; they are not silently reported as successful capture.

The exporter atomically commits each journal cursor advance with admission of all corresponding spans into `victoria-bun-client`'s SQLite outbox. A rejected admission rolls back that advance. Queue pressure therefore leaves data in the journal for retry rather than dropping a command's middle. The outbox is bounded to 256 MB and 100 000 items; the canonical archive is not automatically truncated. Monitor disk usage and manage archive retention deliberately.

Collector outages, exporter crashes and shell shutdown do not delete the journal or pending SQLite records. An exporter failure produces a terminal warning while the recorder continues to archive output. Recovery of an older session is explicit through `replay`; opening a new terminal does not silently delete or rewrite older queues. The SQLite lease prevents concurrent senders from taking ownership of the same outbox. An abandoned lease normally expires after 60 seconds; do not delete a live sender's lease.

## Export and query shape

The service remains `powershell`. `powershell.command.started` is exported immediately, independently of completion. `powershell.command` contains the completed summary and shares the start span's trace ID and parent relationship. Its interval covers the command; `duration_ms` is measured monotonically by the recorder.

Useful summary attributes include `command.id`, `command`, `pwd`, `host`, `user`, `outcome`, `result.known`, `result_code`, `native.exit_code`, `terminal.preview`, `terminal.preview.truncated`, `terminal.bytes`, `terminal.chunks`, `terminal.sha256` and `capture.failed`. The command query preview is bounded; the exact source remains in the canonical record payload.

Every journal record is also exported losslessly as `powershell.record.chunk` or `powershell.command.output` spans. Each payload chunk contains:

```text
powershell.telemetry.version = 2
session.id
record.id = <session-id>:<sequence>
record.sequence
record.type
record.sha256
record.bytes
record.chunk.index
record.chunk.count
record.chunk.encoding = base64
record.chunk.data
```

Reassemble `record.chunk.data` in index order within `record.id`, verify the count, decoded byte length and SHA-256, then decode the canonical JSON. For `output` records, decode their `data` field and verify command byte offsets and the completion manifest. Chunk payloads are bounded even when a source command or error is large.

VictoriaTraces exposes attributes with the `span_attr:` prefix. For example:

```text
"resource_attr:service.name":="powershell" "span_attr:phase":="completed"
```

```text
"resource_attr:service.name":="powershell" "span_attr:session.id":="SESSION_ID"
```

This is a versioned format change. Consumers of the old separate `stdout` and `stderr` summary fields should use `terminal.preview` for presentation or the verified record chunks for complete output. The old `# telemetry:terminal` escape hatch and metadata-only syntax mode are no longer needed.

## Status, synchronization and recovery

```powershell
Get-PowerShellTelemetryStatus
Sync-PowerShellTelemetry -Timeout 10000

$global:PowerShellTelemetry.Enabled = $false
$global:PowerShellTelemetry.Enabled = $true
```

Status reads local snapshots, so an unresponsive collector does not hang the prompt. It exposes hook readiness, capture failures, archive position, exporter PID, stale status, durable queue counters and permanent delivery issues. Synchronization sends an ordered terminal barrier and waits only up to its deadline. It covers data up to that barrier, not the completion of the command that calls `Sync-PowerShellTelemetry`.

`deliveryComplete` means the client has no pending records. `recordingComplete` additionally requires a terminal session-end record without reported capture failure. A stopped export is not reported as fully `complete` merely because an incomplete producer journal has been drained. Permanent rejection remains an explicit issue even when the queue is empty.

```powershell
# Resume an existing durable queue and any unadmitted journal records.
bun run replay --session C:/path/to/session

# Re-export the canonical journal after fixing a backend retention or rejection problem.
bun run replay --session C:/path/to/session --fresh

# Verify sequence coverage, output counts and checksums; print safe JSON summaries.
bun run inspect --session C:/path/to/session

# Reconstruct one command's terminal transport without executing its terminal controls.
bun run inspect --session C:/path/to/session --command COMMAND_ID --output command.vt
```

Fresh replay uses a separate outbox and status file. It preserves canonical record IDs and hashes, but retries and replay can create duplicate spans. Deduplicate record chunks by session, record ID and chunk index; do not assume exactly-once delivery.

`inspect --raw` explicitly writes verified terminal bytes to stdout. Those bytes can contain cursor controls, hyperlinks and other application-provided terminal commands. The default inspector emits escaped JSON instead.

HTTP acknowledgment is not proof of backend retention. A complete local delivery report must not substitute for checking retained record IDs, chunk counts and hashes when forensic completeness matters. SQLite protects admitted pending records; the canonical journal remains the replay source even after acknowledgment or rejection.

## Development

```powershell
bun test
bun x tsc --noEmit
bun x eslint .
```

Tests use temporary archives, isolated PowerShell profiles and local HTTP collectors. They do not send fixture output to the NAS. The Windows lane exercises real ConPTY sessions, native TTY detection, ANSI and OSC-8, PowerShell and native errors, raw-input full-screen applications, Ctrl+C, resizing, binary redirection, shell state, syntax-sensitive commands, early delivery, complete Unicode output and shell exit codes. Portable tests cover installation, canonical record reconstruction, partial tails, transactional admission rollback, restart recovery and permanent rejection.

The implementation is split into the native pseudoconsole adapter, terminal recorder, host, shell lifecycle hook, journal reader and durable exporter. Network delivery never runs inside PowerShell's output pipeline.

References: [Microsoft's ConPTY hosting guide](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session), [console control-handler inheritance](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler), [PSConsoleHostReadLine](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psconsolehostreadline?view=powershell-7.6) and [VictoriaTraces OTLP ingestion](https://docs.victoriametrics.com/victoriatraces/data-ingestion/opentelemetry/).
