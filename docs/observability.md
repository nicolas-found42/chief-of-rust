# Observability and incident reconstruction

What retained evidence exists in this repository, what it can and cannot
establish, and how an agent investigates a failure that cannot be reproduced.
The governing question: *if a failure happened yesterday, what evidence can a
future agent retrieve to reconstruct the sequence, distinguish causes, and
verify a fix?*

Three kinds of claims are kept separate throughout:

- **Instrumented** — present in code at a named source location.
- **Observed** — exercised at runtime by a test or by the reproduction below.
- **Retrievable** — reachable now, through a documented command, from records
  that survive process exit.

Anything not exercised is marked *unverified* rather than assumed.

## Evidence sources

| Source | Captures | Where it lives | How to retrieve | Retention / loss |
| --- | --- | --- | --- | --- |
| Application log (stdout) | A small fixed set of `tracing` sites: boot banner, shutdown, request completion with `status`+`elapsed_ms`+correlation `id`, request failure with the full `error` chain, worker admission/run/prune failures, tick panics | Container stdout (`docker compose logs`); human format by default, JSON when `RUST_LOG_FORMAT=json` | `docker compose logs app` (untested here: no live container during verification) | Unbounded on the host unless Docker logging is configured; lost when the container is recreated. Never the primary evidence: use the store |
| `job` | One row per Run: kind, status, attempt, lease, timestamps, redacted error, result, retry link, merge counter | SQLite `workspace/chief.db` in the `chief-of-rust_workspace` volume | `/runs`, `/runs/{id}`, `/runs/{id}/diagnostics`, `chief-of-rust inspect runs`, `inspect run <id>` | Never pruned by `prune_diagnostics` |
| `job_attempt` | One row per attempt: started/finished, outcome, provider, model | same | same | Never pruned |
| `run_event` | Per-attempt timeline: `admitted` (with correlation), `claimed`, `lease_renewed`, `collector`, `generation`, `judgment`, `diagnostics_truncated`, and the closing `done`/`failed` row | same | `inspect run <id>` → `timeline`; `/runs/{id}/diagnostics` → `timeline` | Rows are written through every 2 s while the attempt runs (a panicking or killed attempt keeps what it had produced up to the last tick), and the unpersisted tail is flushed beside the finished record. Capped at 500 rows per Run (`RUN_EVENT_CAP`); overflow is recorded once as a `diagnostics_truncated` row that bypasses the cap — with the storage-side dropped count plus any in-memory recorder drops, or a plain truncation notice when streamed rows hit the cap first. Closing attempt rows also bypass the cap. Rows of deleted Runs are pruned |
| `llm_call` (settings diagnostics) | Last 50 provider prompt/reply pairs from the settings page test | same | `/settings`, `stats()` | Latest 50 rows (`prune_diagnostics`) |
| `run_usage` (per attempt) | Per-call generation measurements: provider, model, outcome, input/output tokens, cost, elapsed, bounded `cause`; plus `timeline_dropped_events` | `record` rows keyed `<run_id>:<attempt>` (`work.rs` write-through + finalization); merged into the finished `result` JSON | `inspect run <id>` → `usage_per_attempt`; raw rows via `record` kind `run_usage` | Same lifetime as the Run; a snapshot is persisted every 2 s while the attempt runs, so an interrupted attempt keeps the usage it had produced |
| `ops_event` | Process-level evidence: `worker started`, `schedule admission_failed`, `worker run_once_failed`, `prune prune_failed`, `worker tick_panicked`, `lifecycle shutdown` | SQLite `ops_event` | `inspect ops [--since TS]`, `inspect health` → `latest_ops_events`, `/healthz` heartbeat | Latest 200 rows; detail bounded to 300 chars (`prune_diagnostics`) |
| `tick` | Worker heartbeat: one row per 2 s from a dedicated task, written even while a Run holds the loop | SQLite `tick` | `inspect health` → `worker_tick_age_ms`; `/healthz` → `worker_tick_age_ms=` | Latest 500 rows; age is the clock, not the count |
| Council `revision` | Advisory review per report Run, with input hashes and usage | SQLite `revision` | Run page, `/runs/{id}/diagnostics` | Never pruned (user-visible records) |
| Workflow checkpoints (meeting debrief phases, terminal request phase) | Durable phase state for resumable Runs | `record` table | `/runs/{id}` progress, `inspect run <id>` timeline | Never pruned |
| PDF worker | Spawned under the hidden worker mode; exit status and bounded stderr tail now retained in the Run error | `job.error` via the caller | `inspect run <id>` → `error` | Same lifetime as the Run |
| CI | Five checks per PR head | GitHub Actions | `gh pr checks` | GitHub retention |

Correlation identifiers, in order of usefulness:

1. **Run id** (`job.id`) — the logical operation. Survives retry as
   `retry_of`; each retry is a new Run with its own attempts.
2. **Request id** — `x-request-id` from a client, or minted by the middleware;
   echoed on every response row and stored as the `admitted` event action
   (`request:<id>`), so a browser report reaches the Run timeline.
3. **Attempt number** — distinguishes a lease expiry from a fresh failure.
4. **Environment/build context** — the boot banner line (`chief-of-rust 0.1.0`,
   provider, model) plus `/healthz`; the image tag and volume path come from
   Compose. There is no per-Run build hash: a Run does not record which image
   or config revision produced it.

## Coverage inventory

Components are listed separately from cross-component workflows. Disposition
is the strongest claim actually supported.

### Components

| Area | Source | Disposition |
| --- | --- | --- |
| HTTP surface, middleware, correlation | `routes.rs`, `web.rs`, `correlation.rs` | Inspected; runtime-verified (request id round-trip, healthz, diagnostics) |
| Queue, worker loop, leases, finalization | `work.rs` | Inspected; runtime-verified (heartbeat, panic survival, lease recovery) |
| Store and schema | `db.rs`, `store.rs` | Inspected; runtime-verified (prune caps, ops persistence across reopen) |
| Run recording ports | `connection.rs`, `llm/usage.rs` | Inspected; runtime-verified (failed call rows, cap counter) |
| Generation providers | `llm.rs`, `llm/providers.rs`, `llm/catalog.rs` | Inspected; runtime-verified against Wiremock (failure cause, retry, redaction) |
| Evidence judgments | `judgments.rs` | Inspected; runtime-verified (failed judgment row) |
| Collectors and search sources | `collect.rs`, `sources.rs`, `research.rs` | Inspected statically (existing `collector` timeline rows, coverage rows); not re-exercised by this work |
| Terminal product | `terminal/**` | Inspected statically; runtime-verified for the research Run path of the reproduction |
| Meetings product | `meetings/**` | Inspected statically (phase checkpoints, segment progress); no new instrumentation needed |
| People, Tasks, Content | `people.rs`, `tasks.rs`, `content/**` | Inspected statically; all mutate through the same queue and store |
| Integrations (Google, Asana, HubSpot, YouTube) | `integrations.rs` | Inspected statically; **not runtime-verified** — requires accounts not available here |
| PDF parsing and its worker | `pdf.rs` | Inspected; runtime-verified (worker-failure test now asserts retained stderr) |
| Settings and provider selection | `settings.rs`, `settings/providers.rs` | Inspected statically (saved choices, `llm_call` diagnostics) |
| Inspection CLI | `inspect.rs`, `main.rs` | Implemented; runtime-verified end to end against a real store |
| Deployment | `Dockerfile`, `docker-compose.yml`, `.github/workflows` | Inspected statically; **not runtime-verified** (no Docker build in this environment) |

### Cross-component workflows

| Workflow | Disposition |
| --- | --- |
| Browser form → admission → worker → provider → finalize → page/diagnostics | Inspected; runtime-verified |
| Scheduler admission → enqueue (dedup) → worker | Inspected statically (dedup and `admission_failed` rows); scheduler paths not exercised locally (needs Google accounts) |
| Retry of a failed Run | Inspected; runtime-verified (attempt history preserved, `retry_of` link) |
| Lease expiry and re-claim after restart | Inspected; runtime-verified (existing test; attempt 1 closed as `interrupted: lease expired`) |
| Meeting debrief phases | Inspected statically; phase rows are durable, one Run owns the segment loop |
| PDF extraction inside a Run | Inspected; runtime-verified (failure retains stderr) |
| Google-backed Runs | Static only — binding requirement and `GOOGLE_RUN_BINDING` scope read; unverified |
| Container boot → health → smoke → restart persistence | Static only — `scripts/smoke.py`, Compose healthcheck read; unverified here |

## Gap register

Priority reflects diagnostic value against cost and risk, not measured
incident frequency (unknown). Status applies to this branch.

| ID | Gap | Priority | Change | Acceptance check | Status |
| --- | --- | --- | --- | --- | --- |
| ISS-1.01 | Worker heartbeat seam was dead code: no production caller wrote `tick`, so nothing distinguished an idle worker from a dead one | High | A dedicated heartbeat task writes one `tick` every 2 s, independent of Run progress, and stops with the supervised loop; `/healthz` and `inspect health` expose `worker_tick_age_ms` (`unknown` when empty) | `health_reports_durable_worker_heartbeat_state`; `worker_leaves_durable_boot_and_heartbeat_evidence`; `a_busy_worker_still_records_heartbeats` | Implemented, verified |
| ISS-1.02 | Worker-loop anomalies (tick panic, failed admission, failed prune) left stdout-only evidence, lost on container recreation | High | `ops_event` table + `inspect ops`; worker writes `started`, `admission_failed`, `run_once_failed`, `prune_failed`, `tick_panicked`; `lifecycle shutdown` on graceful stop | `ops_events_persist_across_reopen_and_prune_to_the_cap`, `ops_event_window_filters_by_since`, panic test now asserts the durable row | Implemented, verified |
| ISS-1.03 | No supported path from an approximate time and symptom to Run ids without the server | High | Shipped `chief-of-rust inspect` (read-only SQLite): `runs --since/--until/--kind/--status/--limit`, `run <id>`, `ops --since`, `health`; RFC 3339 or epoch input; UTC everywhere; missing store and corrupt store fail with the path | `crates/app/tests/inspect.rs` (three tests, runs the real binary) | Implemented, verified |
| ISS-1.04 | The 500-event timeline cap dropped events silently — a truncated timeline looked like a quiet one | Medium | Every drop path lands in one `diagnostics_truncated` row that bypasses the cap: rows streamed at the cap leave a first-time notice, and finalization upgrades it to the full counts — storage-side drops from write-through and the flush, plus in-memory recorder drops (which alone also leave a marker). Capped events are counted as dropped, never silently discarded; `usage_summary` carries `timeline_dropped_events`, and `inspect run`/diagnostics JSON expose `timeline_truncated` from both signals | `timeline_flush_marks_truncation_instead_of_dropping_silently`, `streamed_events_at_the_cap_leave_one_marker_not_a_silent_drop`, `overflow_is_counted_and_reported_in_the_usage_summary`, diagnostics `timeline_truncated: false` assertion | Implemented, verified |
| ISS-1.05 | Correlation stopped at the HTTP boundary: a request id never reached the Run | Medium | Request id enters a task-local scope; `work::enqueue` stamps it as the `admitted` action (`request:<id>`) | `request_correlation_reaches_the_durable_admission_row` | Implemented, verified |
| ISS-1.06 | Failed generation and judgment calls left no per-call evidence in the timeline | Medium | A failed call records `generation`/`failed_or_cancelled` with provider, elapsed and bounded cause (from the usage guard); a failed judgment records `judgment`/`failed` with a bounded cause and no question text | `failed_calls_keep_provider_and_cause_but_never_the_key`, `failed_judgments_leave_a_timeline_row_with_the_cause` | Implemented, verified |
| ISS-1.07 | PDF worker stderr was discarded, so a parser crash had no cause | Medium | Worker exit status plus a bounded (2 000-char) stderr tail are appended to the Run error | `worker_stderr_tail_is_bounded_and_keeps_the_end` (bound, tail kept, lossy decode) | Implemented, verified at the error-formatting seam; the spawn path itself is not re-exercised by a failing child |
| ISS-1.08 | Container stdout is unbounded and the logging destination was undocumented | Low | Documented here and in `README.md`: stdout is secondary evidence, JSON via `RUST_LOG_FORMAT=json`; Docker-level rotation remains a deployment choice | Documentation review | Documented (deployment-dependent, unverified) |
| ISS-1.09 | `tower-http` with the `trace` feature was a declared dependency that no code used, implying HTTP tracing that did not exist | Low | Dependency removed | `cargo check --workspace --all-targets --locked` | Implemented, verified |
| ISS-1.12 | Provider errors discarded their source cause (`map_err(|_| …)`), and reqwest's Display alone names only the URL, so `job.error` could not distinguish DNS failure from refusal, timeout, truncated body or JSON position | Medium | Transport, read and parse errors render the anyhow source chain (`{:#}`), bounded to 300 chars — on both provider paths (`LiveLlm` and `MistralLlm`, retry and terminal arms); URL userinfo is stripped before persistence, and the timeline `generation` cause and `job.error` inherit it | `transport_failure_records_the_underlying_source_cause` (dead port) asserts the cause names the connect error; `failed_calls_keep_provider_and_cause_but_never_the_key` covers HTTP 401 | Implemented, verified |
| ISS-1.10 | The request-failure log printed only the top error, losing the `anyhow` cause chain | Low | Failure log renders the error with `?error`, the standard `anyhow` debug form that includes every context level | Live server log during the reconstruction exercise showed the rendered error; multi-level chains are not exercised because no handler attaches `.context()` today | Implemented; single-level rendering verified, multi-level unexercised |
| ISS-1.11 | (duplicate of ISS-1.09, recorded twice by the review pass) | — | — | — | Closed as duplicate |

Known limits kept visible, not fixed:

- No per-Run build/config hash. Two identical stores cannot prove which image
  produced a Run.
- Timeline cap is per Run and global to the attempt; a fan-out Run can hit it.
  Truncation is now explicit, the details are not recovered.
- `llm_call` keeps 50 rows and `ops_event` 200; a high-volume incident can
  evict early evidence within hours.
- Container lifecycle (image rebuild, volume loss) is outside what the store
  can prove. A missing `worker started` row is evidence, but absence of all
  rows may mean an empty volume rather than a silent worker.
- No metrics/OTel. Cost is deliberately bounded at "one SQLite file read".

| ISS-1.13 | Timeline rows and usage lived only in memory until finalization: a panic or kill lost every workflow-stage event and all usage for the attempt — the crash-before-export case | High | The dispatch loop writes new recorder rows and the usage snapshot through to the store every 2 s; the database work runs outside the cancellable `select!`, so a completing dispatch cannot drop a transaction mid-await (duplicate rows, stale snapshot overwrites); the snapshot uses a revision-less put (a value replaced every 2 s must not append full-body revision history); judgment totals update and snapshot under one lock, so a persisted snapshot is never half-counted; finalization flushes only the unpersisted tail; a failing write warns and retries at the next tick (bounded); a worker that lost the Run bails at its next lease renewal — at most one heartbeat period of late appends | `cursor_drain_returns_only_unpersisted_rows_and_counts_drops`; `recovered_run_totals_…` asserts an interrupted attempt's snapshot survives | Implemented, verified |
| ISS-1.14 | `inspect` conflated query errors with absence (`.ok()` on the summary, result and tick-age lookups), so a broken store read as "Run not found" / "no result" / "no heartbeat" | Medium | Row lookups use `OptionalExtension::optional()?`; errors propagate and name the store; absence is a genuine empty result | `wrong_identifiers_and_missing_stores_fail_loudly` still passes; the corrupt-store case now fails in `open_store` with the path named | Implemented, verified |

## Investigation runbook

All commands assume the workspace store. Locally that is `WORKSPACE_DIR`
(default `./workspace`); in Compose it is the `chief-of-rust_workspace` volume
mounted at `/data/workspace` (`docker-compose.yml`). Copy the store out or run
the binary inside the container:

```sh
docker compose cp app:/data/workspace/chief.db ./chief.db
WORKSPACE_DIR=. ./chief-of-rust inspect health
```

`chief.db` alone is the whole diagnostic store; the WAL is checkpointed on
open, and `inspect` opens read-only, so copying while the server runs is safe
for reading but may miss the most recent uncheckpointed writes.

1. **Symptom and window.** Start with a time you can defend and a status you
   observed. UTC is the only timezone in the tools; convert once, up front.

   ```sh
   chief-of-rust inspect runs --status failed --since 2026-11-03T00:00:00Z --until 2026-11-04T00:00:00Z
   chief-of-rust inspect runs --kind people.research --limit 20      # symptom-first without status
   ```

   `--since` is inclusive, `--until` exclusive, both by `created_at`.

   Rows carry `created_at_utc`, `updated_at_utc`, `attempt`, `retry_of` and the
   redacted `error`. An empty result is "no matching records" — it is not
   evidence that nothing ran; widen the window or the filters before
   concluding. Unknown options and epoch-*seconds* input are rejected rather
   than reinterpreted, so a typo cannot silently return the wrong window.

2. **Worker liveness for that window.** A server that never claimed the work
   looks different from a worker that died mid-Run.

   ```sh
   chief-of-rust inspect health
   chief-of-rust inspect ops --since 2026-11-03T00:00:00Z
   ```

   `worker_tick_age_ms` near zero with `failed>0` means the worker is alive and
   the failure is per-Run. A large age, a `tick_panicked` row, or a `started`
   row without later activity points at the process itself. `unknown` means no
   tick row at all — suspect an empty or replaced volume, or a worker that
   never started.

3. **Follow one Run.** This is the whole sequence: admission correlation,
   attempts with provider/model, per-stage timeline, and the closing row.

   ```sh
   chief-of-rust inspect run <RUN_ID>
   ```

   Read the timeline as an attempt sequence: `admitted` (correlation + kind) →
   `claimed` (provider + model) → stage rows (`collector`, `generation`,
   `judgment`) → `done`/`failed`. A `failed` closing row repeats the Run error;
   the stage rows that precede it carry the causes.

4. **Test competing hypotheses.** The store distinguishes these classes:

   | Hypothesis | Evidence that supports it | Evidence that rules it out |
   | --- | --- | --- |
   | Provider refused or timed out | `generation` row with `failed_or_cancelled` and an HTTP/timeout cause; `usage_per_attempt[].cause` | A `generation` row with `succeeded`, or no generation row at all |
   | Judgment/dependency unavailable | `judgment` row with `failed` and the cause | Closing row naming a different stage |
   | Worker died or was restarted | `ops` `started` after the failure time; `tick_panicked`; attempt `interrupted: lease expired` | Continuous ticks through the window, closing row present |
   | Bad input or unsupported kind | `error` names the kind or field; no provider stage reached | A provider stage row exists |
   | Never admitted | no `job` row in the window; `/healthz` queued age climbing | `admitted` event exists |
   | Truncated evidence | `timeline_truncated: true` | `false` |

   Timestamps alone never establish causality: the timeline order is the row
   order, and `at_ms` is millisecond-resolution wall clock. Two same-millisecond
   rows are ordered by insertion, not by meaning.

5. **Verify a fix.** A fix is a new Run, not an edit to the old one.

   ```sh
   curl -s -o /dev/null -D - -X POST http://127.0.0.1:5317/runs/<RUN_ID>/retry   # Location: /runs/<NEW_ID>
   chief-of-rust inspect run <NEW_ID>
   ```

   Check the new Run reaches `done` with its stages recorded, and that the old
   Run is unchanged (attempt rows, error, timeline). A passing test proves the
   instrumentation; it does not prove the application fix — the new Run's
   outcome does.

6. **During an incident, not after.** `/runs`, `/runs/{id}` and
   `/runs/{id}/diagnostics` read the same store over HTTP; `x-request-id`
   from a client ties a browser action to its Run.

## Verification record

Baseline before any change (branch point `origin/main`): `fmt`, `check`,
`clippy`, `test` green; 393 tests passed, 46 skipped.

After the changes: `fmt`, `check`, `clippy` (`-D warnings`) green; 412 tests
passed, 46 skipped. New tests:

- `tests/inspect.rs` — symptom-first query, id follow-up, ops/health, wrong id,
  missing store, corrupt store, all through the shipped binary.
- `tests/runtime.rs` — correlation to the admission row, worker boot/heartbeat
  evidence, heartbeat under sustained load, panic row retained, capped timeline
  carrying its marker plus the terminal row.
- `tests/web.rs` — healthz heartbeat states and `timeline_truncated` in the
  diagnostics JSON.
- `tests/generation_usage.rs` — failed call keeps provider and cause, key never
  stored.
- `tests/judgments.rs` — failed judgment row with cause, no state text.
- Unit tests — truncation marker, overflow counter, prune caps, ops persistence, PDF stderr tail bounds.

### Incident reconstruction exercise

Injected ground truth (recorded before reconstruction, in a scratch workspace):
LLM provider endpoint unreachable (connection refused on `127.0.0.1:9`), worker
healthy, client request carried `x-request-id: incident-2026-11-03`.

Procedure: real server, real forms, real worker; server killed; reconstruction
using only `chief-of-rust inspect` and the store; then the "fix" (provider
reachable at a mock endpoint) and a retry of the failed Run.

Retrieved evidence (abridged from `inspect run <id>` and `inspect health`):

```text
run: 1646ae8d-… failed  attempts: [(1, 'opencode request failed or timed out', 'opencode')]
 timeline: 10:42:15Z att 0 admitted      request:incident-2026-11-03  queued   | people.research
 timeline: 10:42:17Z att 1 claimed       -                            running  | opencode beam-free
 timeline: 10:42:17Z att 1 generation    opencode                     failed_or_cancelled | opencode request failed or timed out
 timeline: 10:42:17Z att 1 failed        -                            failed   | opencode request failed or timed out
health: ok failed 1 queued 0 worker_tick_age_ms 108
ops: [('2026-11-04T10:42:23Z','lifecycle','shutdown'), ('2026-11-04T10:42:15Z','worker','started')]
```

What the evidence establishes: which operation (kind, Run id), its scope (one
Run, one attempt), the handoffs (admitted → claimed → generation), the failing
boundary (the generation step at provider `opencode`, before any collector or
judgment row), the dependency outcome (request failed/timed out, not a
validation error), and that the worker was alive and heartbeating through the
window.

What it rules out: a dead or panicking worker (fresh tick, no `tick_panicked`);
a judgment failure (no `judgment` row); a collector failure (no `collector`
row); "never admitted" (admitted row with the caller's correlation id); silent
truncation (`timeline_truncated: false`).

What remains hypothetical: *why* the endpoint refused — DNS, container
networking, provider outage — is outside the store. The store names the
boundary and the outcome, not the network cause.

Fix verification: retry after pointing the provider at a reachable endpoint →
new Run `1afecd93-…` reached `done`, `retry_of` links the original, and the
original Run's attempt history and error were unchanged.

CLI hardening was exercised against the same workspace:

```text
$ chief-of-rust inspect runs --sine 2026-11-03T00:00:00Z
Error: Unknown option --sine. See `chief-of-rust inspect --help`.        (exit 1)
$ chief-of-rust inspect runs --since 1793787530
Error: --since/--until take epoch milliseconds or RFC 3339, not epoch seconds; got 1793787530   (exit 1)
$ chief-of-rust inspect runs --since --kind people.research
Error: --since needs a value. See `chief-of-rust inspect --help`.        (exit 1)
$ chief-of-rust inspect health --limit 5
Error: Unknown option --limit. See `chief-of-rust inspect --help`.       (exit 1)
$ chief-of-rust inspect ops --limit 0
[ … ]   (one row minimum, never an empty page that reads as "no events")
```

Two defects were found *by* this exercise and fixed before it is recorded
here: the closing row reused the last stage name (producing a second
`generation` row with a different status), and `ops` output carried epoch
milliseconds without a UTC rendering.

### Failure-mode checks

- **Telemetry path fails:** every diagnostics write is best-effort — the
  recorder is in-memory, `record_event`/`flush_events` failures are logged and
  swallowed, and a failed Run finalizes regardless. The worker loop records
  ops events with `let _ =` so a broken store cannot stop the worker.
- **Bounds:** timeline 500 rows/Run plus one truncation row; ops 200 rows;
  cause/details bounded at 200–300 chars; `inspect` clamps `--limit` to 500.
  Memory: the recorder holds at most `RUN_EVENT_CAP` events per Run.
- **Redaction:** provider errors pass `redact_error` (installation keys are
  stripped by value); causes are caller-supplied category text; no prompt,
  transcript, or evidence body enters `ops_event`, the timeline, or the
  retry/error columns.
- **Isolation:** timeline rows are keyed by `run_id` + attempt; concurrent Runs
  have separate recorders; the correlation scope is task-local, so two
  concurrent requests cannot borrow each other's id.

### Unverified here

- Docker image build, container boot, healthcheck behavior, `docker compose
  logs` retrieval, and log-volume growth: no container was built or run in
  this environment.
- `/healthz` heartbeat under a real container restart cycle (the test restarts
  no process; it seeds state and reads the endpoint).
- Retention over real wall-clock time: caps are enforced by code paths and
  asserted in tests, not observed across days.
- Google/Asana/HubSpot/YouTube-backed Runs and scheduler admission: require
  accounts; inspected statically only.

## Resuming this work

If interrupted, the next action is: run `cargo fmt --all -- --check`,
`cargo check --workspace --all-targets --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`,
`cargo nextest run --profile ci`; then `cargo build --bin chief-of-rust` and
re-run the exercise in this document's "Incident reconstruction exercise"
section against a scratch `WORKSPACE_DIR`. Open items requiring authorization:
Docker build/boot verification, and any change to deployment logging
configuration.
