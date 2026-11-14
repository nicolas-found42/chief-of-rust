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
| `ops_event` | Process-level evidence: `worker started` (with `version=`, `build=` from `CHIEF_BUILD_ID`, provider, model, `people_terminal`), `schedule admission_failed`, `people_terminal_admission_failed`, `worker run_once_failed`, `prune prune_failed`, `worker tick_panicked`, `lifecycle shutdown` | SQLite `ops_event` | `inspect ops [--since TS]`, `inspect health` → `latest_ops_events`, `/healthz` heartbeat | Latest 200 rows; detail bounded to 300 chars (`prune_diagnostics`) |
| `http_error` | One row per browser-visible 5xx: request id, method, route, status and the redacted cause chain. A failure before admission has no Run row; this is its durable evidence | SQLite `http_error` | `inspect http [--since TS] [--request-id ID] [--limit N]`, `inspect health` → `http_failures_24h` / `retention_caps.http_errors` | Latest 200 rows, its own cap so a storm cannot evict `ops_event`; detail bounded to 300 chars. `/healthz` and `/static/` are excluded; only 5xx is recorded |
| Schedule state | One `record` row per known schedule: enabled, interval, last attempt, bounded last error | `record` kind `schedule` | `inspect schedules`, Settings page | Latest value plus revision history of user edits; the tick's own bookkeeping is a snapshot, not a revision |
| `tick` | Worker heartbeat: one row per 2 s from a dedicated task, written even while a Run holds the loop | SQLite `tick` | `inspect health` → `worker_tick_age_ms`; `/healthz` → `worker_tick_age_ms=` | Latest 500 rows; age is the clock, not the count |
| Council `revision` | Advisory review per report Run, with input hashes and usage | SQLite `revision` | Run page, `/runs/{id}/diagnostics` | Never pruned (user-visible records) |
| Workflow checkpoints (meeting debrief phases, terminal request phase/report) | Durable phase state and stage evidence for resumable and failed Runs | `record` table (`meeting_debrief_trace`, `terminal_request`, `terminal_report`) | `/runs/{id}` progress, `inspect run <id>` → `traces`, `/runs/{id}/diagnostics` → `traces` (progress metadata only: phase, segment, attempt, status, `details_keys`; newest 100, `traces_truncated` reports the bound) | Never pruned; checkpoint bodies stay on the owner-facing Run page |
| PDF worker | Spawned under the hidden worker mode; exit status and bounded stderr tail now retained in the Run error | `job.error` via the caller | `inspect run <id>` → `error` | Same lifetime as the Run |
| CI | Five checks per PR head | GitHub Actions | `gh pr checks` | GitHub retention |

Correlation identifiers, in order of usefulness:

1. **Run id** (`job.id`) — the logical operation. Survives retry as
   `retry_of`; each retry is a new Run with its own attempts.
2. **Request id** — `x-request-id` from a client, or minted by the middleware;
   echoed on every response row, stored as the `admitted` event action
   (`request:<id>`) and as `http_error.request_id`, so a browser report
   reaches both a failed request and its Run timeline. `inspect runs
   --request-id` and `inspect http --request-id` are the two joins.
3. **Admission origin** — with no browser request, the scheduler stamps
   `schedule:<kind>` as the admission action (including
   `schedule:people.terminal_watch`). A tick that found live work appends
   `admitted`/`deduplicated` to that Run instead of vanishing, so "never
   fired" and "fired and joined live work" differ.
4. **Attempt number** — distinguishes a lease expiry from a fresh failure.
5. **Environment/build context** — the boot banner line plus the durable
   `worker started` row (`version=… build=… provider=… model=…`), `/healthz`
   and `inspect health` (`version`, `store_path`); the image tag and volume
   path come from Compose. `CHIEF_BUILD_ID` is optional; when the deployment
   sets it, the store names the image that produced later Runs within one
   boot generation. A Run still carries no per-Run build hash: two boots
   between a Run and the investigation leave the build ambiguous.

The queue owns the health counts and `db` owns the durable heartbeat query.
`/healthz` and `inspect health` share those reads and keep their own output and
error handling. Terminal owns its profile and report state transitions; the
queue runs them inside the same transactions as retry admission and failure
finalization, so a Run cannot commit without its corresponding record update.

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
| Evidence judgments | `judgments.rs` | Inspected; runtime-verified (failed judgment row, transport cause preservation without key leak) |
| Collectors and search sources | `collect.rs`, `sources.rs`, `research.rs` | Inspected; transport/JSON cause preservation added; `fetch_url` failure path runtime-verified |
| Terminal product | `terminal/**` | Inspected statically; runtime-verified for the research Run path of the reproduction |
| People Terminal | `people_terminal/**` | Inspected; runtime-verified (`collector` failure/timeout and `output` timeline rows, `schedule` ops isolation) |
| Meetings product | `meetings/**` | Inspected statically (phase checkpoints, segment progress); no new instrumentation needed |
| People, Tasks, Content | `people.rs`, `tasks.rs`, `content/**` | Inspected statically; all mutate through the same queue and store |
| Integrations (Google, Asana, HubSpot, YouTube, SearXNG, Firecrawl) | `integrations/mod.rs` | Inspected; transport/JSON cause preservation present (`llm::error_chain`); **not runtime-verified** for live accounts/services |
| PDF parsing and its worker | `pdf.rs` | Inspected; runtime-verified (both error-formatting seam and failing-child spawn path retain stderr) |
| Settings and provider selection | `settings.rs`, `settings/providers.rs` | Inspected statically (saved choices, `llm_call` diagnostics) |
| Inspection CLI | `inspect.rs`, `main.rs` | Implemented; runtime-verified end to end against a real store (`--request-id`, `retried_by`, `health` caps, `--limit` notices; `events`, `http`, `schedules`, `traces`) |
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

### OpenCode output-token recovery

OpenCode generation starts with an 8,192-token output allowance. An explicit
Chat Completions `finish_reason: length`, or Responses `incomplete` with
`incomplete_details.reason: max_output_tokens`, permits bounded retries at
16,384 and 32,768 tokens. Model, reasoning effort, session, prompt and output
contract stay the same. Partial responses are never returned for publication;
refusals, unknown incomplete reasons and invalid contracts remain failures.
The section writer does not repeat exhausted token recovery as a formatting
repair. Other provider adapters keep their existing retry policy.

Each wire attempt retains its own measured usage and outcome. A failed
token-limited attempt records the exhausted allowance and, when applicable,
the next allowance in its bounded cause. The successful completion's usage
includes all attempts; an absent cost stays unknown. Prompts, partial output
and credentials are excluded from the recorder. The ordinary Wiremock tests
in `generation_usage.rs` cover recovery, its ceiling and refusal boundaries;
the section-writer regression confirms that exhausted token recovery is not
repeated as a formatting repair. The three-attempt bound applies to one
adapter completion; an existing format-repair pass can request a separate
completion for a different contract error.

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

- No per-Run build/config hash. The `worker started` row names the nearest
  deployment; two boots between a Run and the investigation leave the image
  ambiguous. `CHIEF_BUILD_ID` is only useful when the deployment sets it.
- HTTP evidence covers 5xx only. A 4xx caused by a client bug or a CSRF
  rejection is not retained; the page and the request log are all there is.
- `http_error` keeps 200 rows: a sustained failure storm evicts its own
  earliest rows within the storm. The durable evidence then names the status
  quo, not the onset.
- Timeline cap is per Run and global to the attempt; a fan-out Run can hit it.
  Truncation is now explicit, the details are not recovered.
- `llm_call` keeps 50 rows and `ops_event` 200; a high-volume incident can
  evict early evidence within hours.
- Container lifecycle (image rebuild, volume loss) is outside what the store
  can prove. A missing `worker started` row is evidence, but absence of all
  rows may mean an empty volume rather than a silent worker.
- No metrics/OTel. Cost is deliberately bounded at "one SQLite file read".

| ISS-1.13 | Timeline rows and usage lived only in memory until finalization: a panic or kill lost every workflow-stage event and all usage for the attempt — the crash-before-export case | High | The dispatch loop writes new recorder rows and the usage snapshot through to the store every 2 s; the database work runs outside the cancellable `select!`, so a completing dispatch cannot drop a transaction mid-await (duplicate rows, stale snapshot overwrites); the snapshot uses a revision-less put (a value replaced every 2 s must not append full-body revision history); judgment totals update and snapshot under one lock, so a persisted snapshot is never half-counted; finalization flushes only the unpersisted tail; a failing write warns and retries at the next tick (bounded); a worker that lost the Run bails at its next lease renewal — at most one heartbeat period of late appends | `cursor_drain_returns_only_unpersisted_rows_and_counts_drops`; `recovered_run_totals_…` asserts an interrupted attempt's snapshot survives | Implemented, verified |
| ISS-2.01 | A browser-visible 5xx that failed before admission left no durable row: yesterday's failed form or page survived only as a stdout line | High | `request_id` middleware records every non-`/healthz` 5xx into `http_error` with request id, method, route, status and the redacted cause chain; handlers attach the chain (the generic `web::Error` path and the two provider-test paths); `inspect http` and `inspect health` retrieve it | `a_server_error_leaves_durable_evidence_with_the_request_id`; `http_failures_persist_and_prune_to_their_own_cap`; `cross_run_and_pre_run_evidence_is_retrievable_by_symptom` | Implemented, verified |
| ISS-2.02 | A scheduled admission had no trigger identity and a deduplicated tick left no trace; "the schedule didn't run" was indistinguishable from "it ran and joined live work" | Medium | Admission origin task-local: the scheduler and the People Terminal watch scheduler stamp `schedule:<kind>` (a request id still wins); `enqueue_tx` appends `admitted`/`deduplicated` to the live Run; `inspect schedules` exposes enabled/interval/last attempt/last error in UTC | `scheduled_admission_names_its_trigger_and_a_suppressed_tick_is_recorded`; `cross_run_and_pre_run_evidence_is_retrievable_by_symptom` | Implemented, verified |
| ISS-2.03 | Finding a symptom class across Runs meant opening every Run; the timeline was only readable one Run at a time | Medium | `inspect events [--since --until --stage --status --action --limit]` joins `run_event` to `job`, newest first, with explicit UTC and the shared truncation notice | `cross_run_and_pre_run_evidence_is_retrievable_by_symptom` | Implemented, verified |
| ISS-2.04 | Workflow checkpoints (meeting-debrief stages, terminal request/report phase) were durable but retrievable only from the HTML Run page | Medium | `work::traces_sync` reads the three checkpoint kinds by `$.run_id`, projects progress metadata only (never transcript/report bodies), bounded to the newest 100 with `traces_truncated`; exposed in `inspect run` and `/runs/{id}/diagnostics` | `cross_run_and_pre_run_evidence_is_retrievable_by_symptom`; the Council diagnostics contract still asserts report text never enters the JSON | Implemented, verified |
| ISS-2.05 | The store could not name the deployment that produced a Run; the version existed only in a stdout banner | Low | `worker started` carries `version=`, `build=` (`CHIEF_BUILD_ID`, `unset` when absent), provider, model and `people_terminal`; nearest boot row before the failure is the deployment context | `worker_leaves_durable_boot_and_heartbeat_evidence` | Implemented, verified |
| ISS-2.06 | Every scheduler tick appended a `revision` row for the same schedule, growing history with mutable bookkeeping and no reader | Low | Tick updates use `put_snapshot`; user saves still append revisions, so the history that matters survives | `cargo test -p chief-of-rust --test runtime` (schedule test) | Implemented, verified |

| ISS-1.14 | `inspect` conflated query errors with absence (`.ok()` on the summary, result and tick-age lookups), so a broken store read as "Run not found" / "no result" / "no heartbeat" | Medium | Row lookups use `OptionalExtension::optional()?`; errors propagate and name the store; absence is a genuine empty result | `wrong_identifiers_and_missing_stores_fail_loudly` still passes; the corrupt-store case now fails in `open_store` with the path named | Implemented, verified |
| ISS-2.01 | `people.terminal_inspect` silently discarded `run_single` timeouts/errors (`let _ =`) and `CoverageState::Error`, and `people.terminal_output` / `verify_independent_input` emitted no stage/failure diagnostics | High | Pass `&RunScope` into `people_terminal::execute`; inspect `timeout` and `coverage` states to record `collector` (`ok`/`failed`/`timed_out`/`blocked`) and `output` (`brief`/`report`) timeline rows; log redacted `tracing::warn!` on origin-check failures | `failing_inspection_and_output_record_timeline_evidence` | Implemented, verified |
| ISS-2.02 | `judgments.rs`, `integrations.rs`, and `collect.rs` discarded underlying transport/parse error causes (`map_err(\|_\| ...)`) | High | Preserve bounded `{:#}` source chains via `llm::error_chain` (with URL credentials and env/API keys scrubbed in `redact_error` and inline) | `typesafe_transport_failure_preserves_underlying_cause_without_leaking_key` | Implemented, verified |
| ISS-2.03 | `inspect` lacked `--request-id` correlation lookup, forward `retried_by` links, retention/version metadata in `health`, and `--limit` truncation notices; `claim` lease recovery had no `ops_event` | High | Added `inspect runs --request-id`, `retried_by` on `inspect run` and `/runs/{id}/diagnostics`, `version`/`store_path`/`retention_caps`/`ops_event_count`/`tick_count` on `inspect health`, stderr truncation notice at `--limit`, `worker started` boot detail, and `worker lease_recovered` `ops_event` | `request_id_retry_links_and_health_boundaries_are_retrievable`, `expired_lease_recovery_records_durable_ops_event` | Implemented, verified |
| ISS-2.04 | `people_terminal::schedule` ran inside `run_once_heartbeat`, so a schedule error aborted job claiming and logged as `worker run_once_failed` | Medium | Isolate `people_terminal::schedule` errors into `ops_event` (`schedule`/`people_terminal_admission_failed`) so queued jobs still drain | `work.rs` (`run_once_heartbeat`) | Implemented; compile-verified, error branch unexercised |
| ISS-2.05 | `pdf.rs` spawn path had no failing-child integration test (ISS-1.07 left spawn unexercised) | Low | Added Unix failing-child script test exercising `pdf::extract_isolated` end to end | `failing_worker_process_retains_stderr_tail` | Implemented, verified |

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
   If the report is "the page returned an error", check the HTTP inbox first:
   a failure before admission never becomes a Run.

   ```sh
   chief-of-rust inspect http  --since 2026-11-03T00:00:00Z
   chief-of-rust inspect http  --request-id <X_REQUEST_ID>
   chief-of-rust inspect runs  --status failed --since 2026-11-03T00:00:00Z --until 2026-11-04T00:00:00Z
   chief-of-rust inspect runs  --kind people.research --limit 20      # symptom-first without status
   chief-of-rust inspect runs  --request-id <X_REQUEST_ID>            # correlate HTTP request to Run
   chief-of-rust inspect events --stage judgment --status failed --since 2026-11-03T00:00:00Z
   ```

   `inspect events` is the cross-Run search: stage names (`admitted`,
   `claimed`, `collector`, `generation`, `judgment`, `done`, `failed`,
   `diagnostics_truncated`) and statuses (`queued`, `running`, `succeeded`,
   `failed`, `failed_or_cancelled`, `deduplicated`, `truncated`) are the
   stable vocabulary.

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

   A saved schedule whose `last_enqueued_at_utc` stopped advancing means the
   scheduler is not firing (check `worker_tick_age_ms`); a recent attempt
   with `last_error` means the dependency failed, not the scheduler.

   ```sh
   chief-of-rust inspect schedules
   ```

3. **Follow one Run.** This is the whole sequence: admission correlation,
   attempts with provider/model, per-stage timeline, the workflow checkpoints
   written beside it (`traces`), and the closing row.

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
   | Never admitted | no `job` row in the window; `/healthz` queued age climbing; a matching `http_error` row explains a rejected request | `admitted` event exists; no `http_error` row for the request |
   | Schedule never fired | `inspect schedules` shows an old `last_enqueued_at_utc`; no `admitted` row with `schedule:<kind>` | a recent attempt or an admission row exists |
   | Schedule fired but joined live work | `admitted`/`deduplicated` row on the existing Run | a new Run exists or no dedup row |
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
  `http_error` 200 rows in its own table (a request storm cannot evict worker
  lifecycle evidence); causes/details bounded at 300 chars; checkpoint traces
  are capped at the newest 100 per Run with `traces_truncated`; `inspect`
  clamps `--limit` to 500 and warns on stderr when the clamp is reached.
  Memory: the recorder holds at most `RUN_EVENT_CAP` events per Run.
- **HTTP failure path never blocks the response:** the row is written after
  the handler returns, best-effort, with a warning on failure. Recording stops
  at 5xx; `/healthz` and `/static/` are excluded so a failing probe cannot
  flood the inbox.
- **Redaction:** provider errors pass `redact_error` (installation keys are
  stripped by value); HTTP failure causes pass the same function before the
  `http_error` row is written and never reach the response body; no prompt,
  transcript, report body, or evidence body enters `ops_event`, `http_error`,
  the timeline, `traces`, or the retry/error columns. Checkpoint bodies stay
  on the owner-facing Run page; only progress metadata is projected.
- **Isolation:** timeline rows are keyed by `run_id` + attempt; concurrent Runs
  have separate recorders; the correlation scope is task-local, so two
  concurrent requests cannot borrow each other's id.

### Second pass: pre-Run, scheduler, and cross-Run evidence

Injected ground truth in a scratch workspace (`LLM_PROVIDER=unsupported`,
`CHIEF_BUILD_ID=e2e-build-7`): two form posts to `/llm`, one carrying
`x-request-id: e2e-incident-42`; then an enabled `meetings.calendar` schedule
with no Google connection. The server was stopped with SIGTERM before any
retrieval.

Retrieved with the shipped binary only (`WORKSPACE_DIR=<scratch>`):

```text
$ chief-of-rust inspect http --request-id e2e-incident-42
[{ "at_utc": "2026-11-14T07:12:34Z", "request_id": "e2e-incident-42",
   "method": "POST", "path": "/llm", "status": 500,
   "detail": "Unknown LLM_PROVIDER. Use mistral, opencode, zai, ollama-cloud or mock." }]
$ chief-of-rust inspect health
{ "store": "ok", "failed": 1, "worker_tick_age_ms": 1134, "http_failures_24h": 2,
  "latest_ops_events": [ …, "worker started",
    "version=0.1.0 build=e2e-build-7 provider=unavailable model=unavailable" ] }
$ chief-of-rust inspect events --stage admitted --limit 5
[{ "run_id": "e769d0bf-…", "kind": "meetings.calendar", "stage": "admitted",
   "action": "schedule:meetings.calendar", "status": "queued" }]
$ chief-of-rust inspect schedules
[{ "kind": "meetings.calendar", "enabled": true, "interval_minutes": 5,
   "last_enqueued_at_utc": "2026-11-14T07:12:36Z", "last_error": null }]
$ chief-of-rust inspect run e769d0bf-…
  timeline: admitted schedule:meetings.calendar queued
            claimed   -                         running  unavailable unavailable
            failed    -                         failed   "Google is not connected. Connect in Settings."
```

Established: both 500s were the same unsupported-provider misconfiguration
(the cause names it), the request id links the browser report to its row, the
worker was alive and named the exact build, the scheduler fired at 07:12:36
and its Run names `schedule:meetings.calendar`, and the Run failed before any
collector or generation stage because Google was never connected.

Ruled out: a dead worker (fresh heartbeat, `worker started` present), a
missing schedule (admission row and `last_enqueued_at_utc` agree), and a
provider failure (the closing row names Google connection, and no generation
row exists).

Still hypothetical: whether the user had a Google account at all; the store
records the binding's absence, not the user's intent.

Two defects were found and fixed before recording: `http_error` first shared
the `ops_event` cap, so a request storm would have evicted the boot/panic rows
that explain it; and the checkpoint projection first carried full bodies, which
broke the diagnostics contract that report text never reaches that JSON.

Whole-tree gate for this pass: `fmt`, `check`, `clippy` (`-D warnings`) green;
463 tests passed, 44 ignored; new tests `a_server_error_leaves_durable_evidence_with_the_request_id`,
`scheduled_admission_names_its_trigger_and_a_suppressed_tick_is_recorded`,
`cross_run_and_pre_run_evidence_is_retrievable_by_symptom`,
`http_failures_persist_and_prune_to_their_own_cap`, plus the boot-detail
assertion in `worker_leaves_durable_boot_and_heartbeat_evidence`.

### Unverified here

- Docker image build, container boot, healthcheck behavior, `docker compose
  logs` retrieval, and log-volume growth: no container was built or run in
  this environment.
- `/healthz` heartbeat under a real container restart cycle (the test restarts
  no process; it seeds state and reads the endpoint).
- Retention over real wall-clock time: caps are enforced by code paths and
  asserted in tests, not observed across days.
- Google/Asana/HubSpot/YouTube-backed Runs: require accounts; transport and
  JSON causes are inspected statically, and account-backed flows are not
  runtime-verified.
- Long-lived `CHIEF_BUILD_ID` propagation: the boot row is verified locally;
  the deployed image must set the variable for the build name to be useful.

## Resuming this work

If interrupted, the next action is: run `cargo fmt --all -- --check`,
`cargo check --workspace --all-targets --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`,
`cargo nextest run --profile ci`; then `cargo build --bin chief-of-rust` and
re-run the exercises in this document's "Incident reconstruction exercise" and
"Second pass" sections against a scratch `WORKSPACE_DIR`. Open items requiring
authorization: Docker build/boot verification, any change to deployment
logging configuration, and setting `CHIEF_BUILD_ID` in the deployed image.

## People Terminal

Beta watchlists persist cadence, review position and admitted Run IDs.
Targeted inspections and saved research outputs use the same Run queue
and usage recorder. Inspect an affected person’s Coverage view or Run
timeline to distinguish a collector failure, a policy exclusion, and a
recorded observation. The profile views do not turn collector failures
into claims or compare them as changes in a person's work.
