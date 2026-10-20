# Bloomberg Terminal — System Architecture, Load Analysis, and Re-architecture Plan

> Research note only. No code changes.
> Every factual claim cites its primary source as `path:line` or an official docs URL.
> All repo paths are relative to the workspace root. Line numbers were read at note time.

## 0. Scope and method

This note covers the Bloomberg Terminal product area: `docs/bloomberg-terminal-spec.md`,
`crates/app/src/terminal/`, `crates/app/src/collect.rs`, `crates/app/src/db.rs`,
`crates/app/src/store.rs`, `crates/app/src/work.rs`, `crates/app/src/pdf.rs`,
`crates/app/src/llm.rs`, `crates/app/src/llm/providers.rs`,
`crates/app/src/llm/catalog.rs`, `crates/app/src/judgments.rs`,
plus runtime wiring in `crates/app/src/lib.rs`, `crates/app/src/main.rs`,
`Cargo.toml`, `crates/app/Cargo.toml`, `Dockerfile`, `docker-compose.yml`.
Supporting vocabulary lives in `crates/app/src/research.rs`; provider-adjacent HTTP
lives in `crates/app/src/integrations.rs`.

Sources for this section: `docs/bloomberg-terminal-spec.md:1-2` (automation amendment
supersedes manual intake), `docs/bloomberg-terminal-spec.md:11-16` (Rust-native Terminal,
shared persisted research engine, no parallel queue or plugin subprocess),
`crates/app/src/lib.rs:258-269` (`App` shape), `crates/app/src/main.rs:16-23`
(`App` construction).

---

## 1. Current architecture map

### 1.1 Product contract and module wiring

The Terminal replaces standalone Person Profiles with adjacent Person and Company
sections under canonical `/terminal` routes; old `/people` routes are removed without
redirects (`docs/bloomberg-terminal-spec.md:100-106`, `crates/app/src/terminal/mod.rs:1-6`).

Key contract points:

- One shared deep Research module for context, identity, evidence, inspection,
  coverage, frontier, verification, synthesis; company/person adapters own
  applicability and presentation (`docs/bloomberg-terminal-spec.md:107-115`,
  `crates/app/src/research.rs:1-8`, `crates/app/src/terminal/mod.rs:20-25`).
- Reuse of the SQLite revisioned records, durable Run queue, worker dispatch, Run UI,
  model provider, and typed judgment interfaces; no second scheduler
  (`docs/bloomberg-terminal-spec.md:107-115`,
  `docs/bloomberg-terminal-spec.md:164-172`).
- Full research starts explicitly; profile save/edit does not start external
  collection, except saved-evidence comparison regeneration
  (`docs/bloomberg-terminal-spec.md:111-115`, `crates/app/src/terminal/execution.rs:61-106`).
- Depth (`quick`/`deep`/`exhaustive`) and presentation (`short`/`long`) are
  independent; `deep`/`short` are defaults (`docs/bloomberg-terminal-spec.md:111-115`,
  `crates/app/src/lib.rs:79-93`).
- 26 collector actions are accounted for per full company Run
  (`docs/bloomberg-terminal-spec.md:130-142`, `crates/app/src/research.rs:18-45`).
- Person research uses the maximum applicable subset; 11 organization-scoped
  actions are excluded from personal evidence
  (`docs/bloomberg-terminal-spec.md:130-142`,
  `crates/app/src/research.rs:59-74`).
- Comparison workflows are explicit two-company requests and regenerate from saved
  evidence without new external collection (`docs/bloomberg-terminal-spec.md:164-172`).
- Operator contact gates 7 contact-bearing actions (`crates/app/src/research.rs:47-57`,
  `crates/app/src/terminal/execution.rs:477-496`).
- Privacy deletion purges company/person research artifacts and revision rows
  (`docs/bloomberg-terminal-spec.md:117-129`,
  `crates/app/src/terminal/mod.rs:281-380`).

Module wiring: `crates/app/src/lib.rs:4-20` declares `collect`, `db`, `integrations`,
`judgments`, `llm`, `pdf`, `research`, `store`, `tasks`, `terminal`, `work` among
others; `crates/app/src/terminal/mod.rs:20-25` declares `automatic`, `comparison`,
`continuation`, `execution`, `person`, `runner`; `crates/app/src/llm.rs:1-7` declares
`catalog` and `providers`.

### 1.2 Runtime, configuration, and deployment

- Workspace root declares edition 2024 and a single member `crates/app`
  (`Cargo.toml:1-3`).
- App crate uses `tokio` with `rt-multi-thread, macros, time, signal, fs, net, sync,
  process, io-std, io-util` (`crates/app/Cargo.toml:22`), `axum 0.8.9`
  (`crates/app/Cargo.toml:11`), `reqwest` with `json, form, query, rustls`
  (`crates/app/Cargo.toml:17`), `rusqlite 0.40.2` with `bundled`
  (`crates/app/Cargo.toml:12`), `base64`, `scraper`, `url`, `sha2`, `jsonschema`
  (`crates/app/Cargo.toml:15-28`).
- `#[tokio::main]` boots one multi-thread runtime (`crates/app/src/main.rs:4-5`).
- `Config::from_env` supplies port, workspace dir, terminal archive dir, terminal
  limits, provider keys/models, and Google token paths (`crates/app/src/lib.rs:124-154`).
- `TerminalLimits` carries `collection_seconds`, `request_seconds`, `rounds`,
  `sources` (`crates/app/src/lib.rs:79-84`); defaults are `600, 600, 3, 80`
  (`crates/app/src/lib.rs:85-93`); env overrides clamp to `30..=1800`,
  `30..=1800`, `1..=10`, `10..=120` (`crates/app/src/lib.rs:96-103`).
- Compose passes the same four knobs through (`docker-compose.yml:12-15`);
  provider/model vars are listed explicitly (`docker-compose.yml:16-45`).
- The single SQLite file is `<workspace_dir>/chief.db`
  (`crates/app/src/lib.rs:234-237`); compose mounts `workspace:/data/workspace` and
  `./archive/terminal:/data/terminal-archive` (`docker-compose.yml:48-50`).
- Docker builds with `cargo-chef` on Rust 1.98; `aws-lc-sys` needs `cmake`
  (`Dockerfile:1-16`); the runtime image is `debian:trixie-slim` with `curl` and
  `ca-certificates` for rustls native roots (`Dockerfile:18-23`); the server runs
  as UID/GID `1000:1000` with `/data/workspace` owned by `app`
  (`Dockerfile:24-26`).
- Health check is `curl -fsS http://127.0.0.1:5317/healthz` every 5 s, 3 s timeout,
  12 retries (`docker-compose.yml:52-57`).
- `App` is `Clone` and holds `cfg`, `db`, `llm: Arc<dyn LlmProvider>`,
  `judge: Arc<dyn Judge>`, `pacer: Arc<collect::Pacer>`
  (`crates/app/src/lib.rs:258-269`).
- `main` constructs `Db::open(&cfg.db_path())`, `collect::Pacer::system()`,
  `judgments::from_config(&cfg)`, `llm::from_config(&cfg)`
  (`crates/app/src/main.rs:15-23`), then spawns one worker task and serves axum
  with graceful shutdown on `Ctrl-C`/`SIGTERM` (`crates/app/src/main.rs:24-52`).

Sources: `Cargo.toml:1-3`, `crates/app/Cargo.toml:12-22`,
`crates/app/src/main.rs:4-23`, `crates/app/src/main.rs:24-52`,
`crates/app/src/lib.rs:79-103`, `crates/app/src/lib.rs:258-269`,
`Dockerfile:1-26`, `docker-compose.yml:12-57`.

### 1.3 Connection layers (reqwest clients, DNS pinning, TLS, LLM/Jev providers)

There is no shared HTTP client. Each call site builds its own `reqwest::Client`:

| Call site | Construction | Timeout / policy |
|---|---|---|
| Public collector GET, per request | `crates/app/src/collect.rs:408-416` (`Client::builder().no_proxy().timeout(18s).redirect(none)…build()`) | 18 s (`crates/app/src/collect.rs:25`, `crates/app/src/collect.rs:410`) |
| USAspending group fan-out, one client for 6 award groups | `crates/app/src/collect.rs:2559-2563` (same builder shape, 18 s) | 18 s (`crates/app/src/collect.rs:2561`) |
| Google integration helper | `crates/app/src/integrations.rs:82-87` (`client()`, 45 s, redirects off) | 45 s (`crates/app/src/integrations.rs:83-86`) |
| Firecrawl search | `crates/app/src/integrations.rs:501-504` (90 s, redirects off) | 90 s (`crates/app/src/integrations.rs:501-504`) |
| Bounded public-source fetch | `crates/app/src/integrations.rs:748-756` (`no_proxy`, 30 s, `resolve_to_addrs`, redirects off) | 30 s (`crates/app/src/integrations.rs:753`) |
| Mistral LLM | `crates/app/src/llm.rs:107-110` (180 s, redirects off) | 180 s (`crates/app/src/llm.rs:108`) |
| Live LLM (`opencode`/`zai`/`ollama-cloud`) | `crates/app/src/llm/providers.rs:66-70` (180 s, redirects off, version UA) | 180 s (`crates/app/src/llm/providers.rs:68`) |
| TypeSafe/Jev judgments | `crates/app/src/judgments.rs:67-71` (90 s, redirects off) | 90 s (`crates/app/src/judgments.rs:68-71`) |

No call site sets pool tuning (`pool_idle_timeout`, `pool_max_idle_per_host`),
TCP keepalive, HTTP/2, or DNS caching. The only reuse is incidental: the
USAspending client is reused across its 6 sequential group POSTs
(`crates/app/src/collect.rs:2559-2603`), and `reqwest::Client::clone` shares the
pool inside one provider instance (see §1.7).

DNS pinning and perimeter:

- `collect::pinned_addresses` does `tokio::net::lookup_host((host, port))`,
  then requires every answer to be a global/public IP
  (`crates/app/src/collect.rs:236-246`, `crates/app/src/collect.rs:209-234`).
- `collector_get_with` validates the target (`https`, no credentials, no private
  names), computes `host`/`port`, paces, then pins that host via
  `resolve_to_addrs(&host, &addresses)` on a fresh builder
  (`crates/app/src/collect.rs:399-416`, `crates/app/src/collect.rs:174-207`).
- Loopback is only reachable when it matches a configured provider base
  (`CHIEF_COLLECT_*_BASE` or `SEARXNG_BASE_URL` seam)
  (`crates/app/src/collect.rs:110-149`).
- Redirects are disabled at the client (`Policy::none`); each `3xx` is rejoined
  and revalidated manually, up to `MAX_REDIRECTS = 5`
  (`crates/app/src/collect.rs:27`, `crates/app/src/collect.rs:442-471`).
- `integrations.rs` duplicates the same pattern for its public-source path:
  `lookup_host`, public-IP check, `resolve_to_addrs`, then GET with redirect
  handling (`crates/app/src/integrations.rs:740-771`).

Per-host pacing:

- `Pacer { clock, last: Mutex<HashMap<String, Instant>> }`
  (`crates/app/src/collect.rs:275-278`); production uses the wall clock
  (`crates/app/src/collect.rs:257-269`); tests inject a recording clock
  (`crates/app/src/collect.rs:288-293`).
- `pace()` advances the deadline under the lock before sleeping, so bursts wake
  together rather than queueing a full delay apart
  (`crates/app/src/collect.rs:295-314`).
- The key is `scheme://host:port` (`crates/app/src/collect.rs:329-336`); the
  product-wide gate is `SYSTEM_PACER` (`crates/app/src/collect.rs:323-325`),
  owned per caller (`App.pacer`) rather than process-global so tests never share
  a gate (`crates/app/src/collect.rs:271-274`, `crates/app/src/lib.rs:264-268`).
- `collector_get_with` paces before every request including each redirect hop
  (`crates/app/src/collect.rs:407`).

Response bounding: `bounded_body` rejects a known `content-length` over budget,
then streams `chunk()` up to `limit`, returning `(bytes, truncated)`
(`crates/app/src/collect.rs:354-376`); `integrations::bounded_bytes` is the same
shape with a hard error instead of truncation
(`crates/app/src/integrations.rs:88-105`). Collector envelope constants are
`TIMEOUT_SECS = 18`, `MAX_BYTES = 2 MB`, `TEXT_SLICE_CHARS = 30_000`,
`LINK_SLICE = 500`, `JSON_LD_SLICE = 100`
(`crates/app/src/collect.rs:25-30`).

Sources: `crates/app/src/collect.rs:25-30`, `crates/app/src/collect.rs:110-149`,
`crates/app/src/collect.rs:174-246`, `crates/app/src/collect.rs:271-336`,
`crates/app/src/collect.rs:354-416`, `crates/app/src/collect.rs:2559-2563`,
`crates/app/src/integrations.rs:82-105`, `crates/app/src/integrations.rs:501-504`,
`crates/app/src/integrations.rs:740-771`.

### 1.4 State persistence (SQLite/rusqlite, record/revision/job schema, transactions)

- One `rusqlite::Connection` behind `Arc<Mutex<Connection>>`
  (`crates/app/src/db.rs:1-4`, `crates/app/src/db.rs:12-14`).
- `open()` creates parent dirs, opens the file, sets `journal_mode = WAL` and
  `busy_timeout = 5_000` ms, then runs the three schema batches
  (`crates/app/src/db.rs:33-45`). No explicit `synchronous` pragma is set, so
  SQLite's default applies.
- Every access goes through `tokio::task::spawn_blocking` holding the mutex:
  `with_conn` for reads (`crates/app/src/db.rs:50-62`), `transaction` for
  mutations with `TransactionBehavior::Immediate` plus commit
  (`crates/app/src/db.rs:64-82`).
- `record(kind, id, body, revision, updated_at)` PK `(kind, id)` and
  `revision(kind, id, revision, body, at_ms)` PK `(kind, id, revision)`
  (`crates/app/src/store.rs:6-9`).
- `put` serializes the full JSON body, upserts `record`, then copies the full
  body into `revision` (`crates/app/src/store.rs:32-38`).
- `list` prepares `SELECT body … ORDER BY updated_at DESC, id` and parses every
  row (`crates/app/src/store.rs:26-31`); there is no limit or key-only path.
- `Db::{get,list,put,delete}` wrap the sync helpers in `transaction`
  (`crates/app/src/store.rs:54-84`).
- `job(id, kind, dedup_key, input, status, created_at, updated_at, attempt,
  lease_until, result, error, retry_of)` with `status CHECK (queued|running|done|
  failed)`; unique partial index `active_job(kind, dedup_key)` over
  `queued|running`; `job_attempt(job_id, attempt, started_at, finished_at,
  outcome, provider, model)` (`crates/app/src/work.rs:18-22`).
- Queue UX listing caps at 200 rows (`crates/app/src/work.rs:108-118`).
- `claim` closes expired attempts, requeues expired leases, then claims the
  oldest `queued` row with `LIMIT 1`, sets `status='running'`,
  `lease_until = now + 600_000`, and inserts a `job_attempt` row — all in one
  `Immediate` transaction (`crates/app/src/work.rs:120-134`).
- `run_once` resolves the provider, claims one job, optionally narrows the LLM
  session/timeout, runs dispatch under a 30 s lease-heartbeat `select!`, then
  writes `done`/`failed` plus the attempt row in one transaction; terminal
  profile failures also fence the originating `terminal_request`
  (`crates/app/src/work.rs:138-195`).
- `transaction` is documented as the seam where related records and history
  commit together (`crates/app/src/db.rs:64-66`).

Official references: SQLite WAL mode (`https://www.sqlite.org/wal.html`),
`journal_mode` / `synchronous` / `busy_timeout` pragmas
(`https://www.sqlite.org/pragma.html`), `rusqlite::Connection`
(`https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html`),
`tokio::task::spawn_blocking`
(`https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html`).

### 1.5 Process isolation (pdf-worker re-exec model)

- The same binary re-executes as `pdf-worker`: `main` checks `argv[1]` and calls
  `pdf::run_worker()` instead of serving (`crates/app/src/main.rs:5-8`,
  `crates/app/src/pdf.rs:23`).
- Parent `extract_isolated(bytes, page_offset, max_pages)` rejects inputs over
  2 MB, base64-encodes them into a JSON request, resolves the exe from
  `CHIEF_PDF_WORKER_EXE` or `current_exe()`, and spawns
  `Command::new(exe).arg("pdf-worker")` with piped stdin/stdout, null stderr,
  and `kill_on_drop(true)` (`crates/app/src/pdf.rs:110-148`).
- The worker reads stdin to a string, parses `WorkerRequest`, base64-decodes,
  enforces `max_pages 1..=20`, `page_offset <= 100_000`, input/output caps, runs
  `extract_pdf_text`, and prints one JSON `WorkerResponse`
  (`crates/app/src/pdf.rs:58-96`).
- The parent writes the JSON request to stdin, shuts it down, then
  `timeout(WALL_TIMEOUT, child.wait_with_output())` (8 s), checks exit status,
  and parses stdout as `WorkerResponse` (`crates/app/src/pdf.rs:139-170`).
- Bounds: `INPUT_MAX_BYTES = 2 MB`, `WALL_TIMEOUT = 8 s`,
  `STREAM_MAX_BYTES = 8 MB`, `PAGE_MAX_CHARS = 10_000`,
  `PAGE_OFFSET_MAX = 100_000` (`crates/app/src/pdf.rs:23-28`).
- The module documents the tradeoff explicitly: no in-process parser can give
  the required fault/resource isolation; CPU rlimits are not applied by this
  build (no libc dep), wall-time kill plus input/output caps always apply, and
  only `Tj`/`TJ` text-show operators from decodable streams are extracted — no
  OCR or rendered content (`crates/app/src/pdf.rs:1-16`,
  `crates/app/src/pdf.rs:172-176`).
- One fresh process is spawned per `extract_isolated` call; there is no pool,
  keep-alive, or length-delimited multi-request protocol.

Official reference: `tokio::process::Command`
(`https://docs.rs/tokio/latest/tokio/process/struct.Command.html`).

### 1.6 Memory management (body TEXT blobs, list-all loads, bounded caps)

- Record and revision bodies are full JSON `TEXT` blobs
  (`crates/app/src/store.rs:6-9`); `put` writes the full body twice per mutation
  (live row + history row) (`crates/app/src/store.rs:32-38`).
- `store::list` loads and parses every body for the kind
  (`crates/app/src/store.rs:26-31`); `Db::list` routes through a write
  (`Immediate`) transaction even for reads (`crates/app/src/store.rs:63-69`,
  `crates/app/src/db.rs:66-82`).
- Research snapshots (sources, claims, coverage, frontier) ride inside these
  bodies; the automatic-research path truncates retained sources to
  `max_sources` before synthesis (`crates/app/src/terminal/automatic/research.rs:763`).
- Collector evidence is bounded at the edge (`MAX_BYTES`, `TEXT_SLICE_CHARS`)
  (`crates/app/src/collect.rs:25-30`); runner excerpts take at most
  `TEXT_SLICE_CHARS` chars (with a `sec_companyfacts` snapshot carve-out)
  (`crates/app/src/terminal/runner.rs:40-96`).
- Collector envelopes carry `result_count`/`total_result_count`/`next_cursor`
  plus notes/limits rather than full provider pages where the collector shapes
  them (`crates/app/src/collect.rs:79-104`).
- Terminal collection is capped by `TerminalLimits.sources` (default 80,
  clamp 10..120) and `collection_seconds` (default 600, clamp 30..1800)
  (`crates/app/src/lib.rs:85-103`); the loop checks both before every expansion
  (`crates/app/src/terminal/automatic/research.rs:365-368`,
  `crates/app/src/terminal/automatic/research.rs:413-417`,
  `crates/app/src/terminal/automatic/research.rs:597-602`).
- LLM prompts are capped at 400_000 chars client-side before spending a request
  (`crates/app/src/llm/providers.rs:80-83`); judgment answers and PDF text carry
  their own truncation/validation (`crates/app/src/judgments.rs:79-130`,
  `crates/app/src/pdf.rs:23-28`).

### 1.7 Execution runtimes (tokio multi-thread, blocking pool, poll loop, Run dispatch)

- The worker task loops: `settings::tick` (schedule admission), then
  `work::run_once`; when no job is claimed it sleeps 2 s
  (`crates/app/src/main.rs:24-37`).
- `run_once` executes exactly one claimed Run per wakeup (sequential dispatch);
  the 2 s sleep is the idle cadence and the worst-case admission latency for a
  newly queued Run (`crates/app/src/main.rs:30-35`,
  `crates/app/src/work.rs:138-144`).
- Live leases are never stolen by a second process sharing the volume; expiry is
  by `lease_until` (`crates/app/src/work.rs:122-133`). In-flight execution renews
  the lease every 30 s and aborts the outcome write if the lease moved
  (`crates/app/src/work.rs:157-169`).
- `dispatch` → `dispatch_product` routes by `job.kind` prefix through a single
  sequential `if/else` chain (`meetings.`, `people.`, `tasks.`,
  `terminal.profile|report`, `terminal.comparison`, `terminal.person_research`,
  `terminal.company_continue|person_continue`, `terminal.*`, `content.*`)
  (`crates/app/src/work.rs:197-235`).
- Company full research (`terminal.company_research`) iterates `planned_actions`
  sequentially, awaiting `runner::run_single` for each action
  (`crates/app/src/terminal/execution.rs:445-508`); unplanned families get
  `NotApplicable` rows (`crates/app/src/terminal/execution.rs:509-530`).
- `run_single` awaits `collect::run_collector_with(&app.pacer, …)` and appends
  one source row, one coverage row, and at most one frontier item per action
  (`crates/app/src/terminal/runner.rs:99-208`).
- Automatic research runs bounded **rounds**: an initial round plus
  `for _ in 1..rounds` follow-ups (default `rounds = 3`)
  (`crates/app/src/terminal/automatic/research.rs:596-677`,
  `crates/app/src/lib.rs:85-93`); saturation stops after two successive
  nonproductive expansions (`crates/app/src/terminal/continuation.rs:12-15`,
  `crates/app/src/terminal/automatic/research.rs:673-676`).
- Continuation carries machine-readable cursors (`ResumeItem { action, args,
  cursor }`) and monotonic page/offset/skip advancement
  (`crates/app/src/terminal/continuation.rs:23-72`).
- LLM/Jev fan-out inside automatic research is bounded by chunked `JoinSet`
  batches (`chunks(4)`, `chunks(2)`, `chunks(3)`), never an unbounded spawn or
  a `Semaphore` (`crates/app/src/terminal/automatic/research.rs:1182-1184`,
  `crates/app/src/terminal/automatic/research.rs:1571-1572`,
  `crates/app/src/terminal/automatic/research.rs:2071-2072`,
  `crates/app/src/terminal/automatic/research.rs:2204-2205`,
  `crates/app/src/terminal/automatic/research.rs:3296-3331`; cf. meeting debrief
  `JoinSet` with `limit` in `crates/app/src/meetings/debrief.rs:619-623`).
- `RunJudgments` memoizes judgment evaluations for one execution only, keyed by
  `content_hash(state + questions)` behind `Mutex<HashMap<…, OnceCell<…>>>`;
  identical concurrent callers share one in-flight evaluation and the cache
  never survives a fresh Run (`crates/app/src/terminal/automatic/research.rs:6-42`).
- LLM session handling: `LiveLlm` owns `client: reqwest::Client` plus a UUID
  `session` (`crates/app/src/llm/providers.rs:11-18`,
  `crates/app/src/llm/providers.rs:60-63`); `for_session` clones the provider
  (sharing the same `Client` allocation) and overrides the session id
  (`crates/app/src/llm/providers.rs:249-252`); the `x-opencode-session` header
  is sent only for `opencode` (`crates/app/src/llm/providers.rs:140-144`).
  `with_request_timeout` clones and narrows only the per-request timeout,
  preserving provider/model/session/pool
  (`crates/app/src/llm.rs:21-25`, `crates/app/src/llm.rs:122-125`,
  `crates/app/src/llm/providers.rs:244-248`).
- `run_once` applies `for_session(&job.id)` then, for terminal kinds,
  `with_request_timeout(terminal_limits.request_seconds)`
  (`crates/app/src/work.rs:144-156`).
- LLM completion POSTs with retries on timeout/connect/request and sleeps
  between attempts (`crates/app/src/llm.rs:170-216`); provider errors are
  recorded on Runs with secrets redacted (`crates/app/src/work.rs:170-176`,
  `crates/app/src/llm.rs:339-359`).

Official references: `tokio::task::JoinSet`
(`https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html`),
`tokio::sync::Notify` / `watch`
(`https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html`,
`https://docs.rs/tokio/latest/tokio/sync/struct.watch.html`),
`reqwest::Client` sharing (`https://docs.rs/reqwest/latest/reqwest/struct.Client.html`),
`reqwest::ClientBuilder` pool options
(`https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html`).

---

## 2. Under-load analysis: where time and money go

All costs below are derived from code structure, not live measurement. They are
stated as operations-per-event so they survive hardware differences.

### 2.1 Cold TLS/handshake on nearly every collector call

- `collector_get_with` builds a new `Client` per call **and per redirect hop**
  (the builder is inside the `for _ in 0..=MAX_REDIRECTS` loop)
  (`crates/app/src/collect.rs:403-416`). Dropping the client drops its
  connection pool, so the next same-host request cannot reuse a warm
  keep-alive connection (`https://docs.rs/reqwest/latest/reqwest/struct.Client.html`
  documents `Client` as the pool owner; `ClientBuilder` pool options in
  `https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html` are never
  set here).
- Cost per cold request: 1× `lookup_host` DNS round-trip
  (`crates/app/src/collect.rs:236-246`) + 1× TCP handshake + 1–2× TLS round
  trips (rustls; `crates/app/Cargo.toml:17`, `Dockerfile:19-20`) + the HTTP
  exchange. None of these is amortized across the 26 collector actions or
  across the up-to-`rounds` collection loop
  (`crates/app/src/research.rs:18-45`,
  `crates/app/src/terminal/automatic/research.rs:596-677`).
- A full company Run that touches most of the 26 actions therefore pays ~26
  cold handshakes per round (fewer when actions are `NotApplicable`), times up
  to `rounds` (default 3) (`crates/app/src/terminal/execution.rs:477-530`,
  `crates/app/src/lib.rs:85-93`).
- Secondary sites repeat the pattern: Firecrawl search builds per call
  (`crates/app/src/integrations.rs:501-504`); the public-source helper builds
  per redirect hop (`crates/app/src/integrations.rs:748-762`); the generic
  Google helper builds per call (`crates/app/src/integrations.rs:82-87`).
- The one exception proves the rule: USAspending builds one client and reuses
  it across 6 group POSTs (`crates/app/src/collect.rs:2559-2603`) — the shape
  every other path should copy.

### 2.2 DNS pinning cost (safety-critical, but paid per request)

- Every `collector_get_with` request performs an async `lookup_host` before
  connecting (`crates/app/src/collect.rs:413`), plus a full-list public-IP
  validation (`crates/app/src/collect.rs:241-244`). Redirect hops re-resolve
  the new host (`crates/app/src/collect.rs:442-454`).
- The integrations public-source path pays the same lookup + validate on every
  hop (`crates/app/src/integrations.rs:740-756`).
- The pinning itself is load-bearing safety (SSRF/perimeter), not waste: it
  enforces HTTPS-only, credential-free, global-address-only targets with
  redirect revalidation (`crates/app/src/collect.rs:171-207`,
  `docs/bloomberg-terminal-spec.md:174-182`). The inefficiency is that the
  answer is never cached: identical hosts re-resolve on every action, round,
  and continuation Run, even within one collection burst.

### 2.3 Mutex-serialized SQLite plus `spawn_blocking` hop per access

- All DB traffic serializes on one `Mutex<Connection>`
  (`crates/app/src/db.rs:12-14`); readers and writers share the same lock
  (`crates/app/src/db.rs:48-62`).
- Every access pays a `spawn_blocking` schedule plus a mutex acquisition, even
  for single-row reads (`crates/app/src/db.rs:55-61`).
- `Db::list`/`get` route through `transaction(Immediate)` — i.e. they take a
  reserved write lock even when only reading (`crates/app/src/store.rs:54-69`,
  `crates/app/src/db.rs:66-82`). Under the current single worker this is
  merely overhead; under any concurrent dispatcher it becomes lock contention
  plus `SQLITE_BUSY` pressure (mitigated only by the 5 s `busy_timeout`,
  `crates/app/src/db.rs:39`).
- No prepared-statement cache exists: `store::list` prepares per call
  (`crates/app/src/store.rs:27-28`); `work::list` and `claim` format and
  prepare per call (`crates/app/src/work.rs:108-133`).
- `synchronous` is never set, so the build inherits SQLite's default rather
  than the commonly recommended `NORMAL`-with-WAL durability/performance
  tradeoff (see `https://www.sqlite.org/pragma.html#pragma_synchronous` and
  `https://www.sqlite.org/wal.html`).

### 2.4 Full-body revision growth and list-all loads

- Every `store::put` writes the full JSON body twice (live `record` + history
  `revision`) (`crates/app/src/store.rs:32-38`). A brief that is re-synthesized
  N times stores N full copies; there is no delta, pruning, or archival
  compaction in `store.rs` (`crates/app/src/store.rs:1-53`).
- `store::list` returns **all** bodies for a kind with no `LIMIT`, no keyset
  pagination, and no key-only listing (`crates/app/src/store.rs:26-31`). Any
  caller that lists a high-cardinality kind pays O(total bodies) JSON parse per
  call.
- The Run list caps at 200 (`crates/app/src/work.rs:108-118`), but record kinds
  do not.
- Synthesis inputs are bounded (`sources.truncate(max_sources)`,
  `crates/app/src/terminal/automatic/research.rs:763`; excerpt slicing,
  `crates/app/src/terminal/runner.rs:85-95`), which caps prompt growth but
  does not reduce stored bytes.

### 2.5 2-second poll-loop latency and sequential dispatch

- The worker claims at most one Run per `run_once` and sleeps 2 s whenever the
  queue is empty (`crates/app/src/main.rs:24-37`,
  `crates/app/src/work.rs:138-144`). Expected admission delay for a newly
  enqueued Run is therefore ~1 s average, 2 s worst case, before any execution
  time.
- `settings::tick` runs before every claim attempt, so admission work also
  serializes with execution (`crates/app/src/main.rs:26-35`).
- Company collection itself is sequential across planned actions
  (`crates/app/src/terminal/execution.rs:477-508`): with per-action latency L
  (cold handshake + provider RTT + pacing delay), wall time is ~ΣL per round,
  even though actions are independent until synthesis. The `collection_seconds`
  budget (default 600) bounds the loop but does not parallelize it
  (`crates/app/src/terminal/automatic/research.rs:365-372`).
- Lease mechanics (10 min lease, 30 s heartbeat) are correct for crash recovery
  but add one DB transaction per 30 s of execution per Run
  (`crates/app/src/work.rs:130-131`, `crates/app/src/work.rs:159-169`).

### 2.6 Per-PDF fork plus base64 tax

- Each PDF extraction spawns a full re-exec of the server binary
  (`crates/app/src/pdf.rs:132-138`), writes `base64(input)` JSON over stdin
  (`crates/app/src/pdf.rs:119-123`, `crates/app/src/pdf.rs:146-148`), waits up
  to 8 s (`crates/app/src/pdf.rs:150-155`), and parses one JSON response
  (`crates/app/src/pdf.rs:161-169`).
- Base64 inflates every input by ~33%: a 2 MB PDF sends ~2.7 MB of JSON; the
  8 MB decompressed cap and 10 k chars/page caps bound the child, not the IPC
  (`crates/app/src/pdf.rs:23-28`).
- There is no worker pool: K PDFs in one Run pay K process spawns (dynamic
  linker + `aws-lc-sys`/rustls init + Tokio runtime init per child), K base64
  encode/decode passes, and K JSON serialize/parse passes.
- Output JSON returns full page strings; page count is capped at 20, but each
  page can still carry 10 k chars (`crates/app/src/pdf.rs:78-86`).

### 2.7 Per-call `Client::build` in integrations and terminal-adjacent paths

- `integrations::client()` builds per call (45 s timeout)
  (`crates/app/src/integrations.rs:82-87`); Firecrawl builds per call (90 s)
  (`crates/app/src/integrations.rs:501-504`); the public-source helper builds
  per redirect hop (30 s) (`crates/app/src/integrations.rs:748-762`).
- Google token persistence uses `spawn_blocking` file I/O under `TOKEN_LOCK`
  (`crates/app/src/integrations.rs:18`,
  `crates/app/src/integrations.rs:957-975`), serializing credential refresh
  across concurrent Google callers by design — but combined with per-call
  clients, refresh still pays a cold handshake.
- LLM and judgment clients are constructed once per provider selection and
  then reused via `Arc` (`crates/app/src/llm.rs:306-338`,
  `crates/app/src/judgments.rs:315`ff via `from_config`), which is the correct
  shape — but the per-Run `for_session`/`with_request_timeout` clones are only
  useful if the underlying `Client` actually holds warm connections, which
  requires the pool-tuning work in §3.1.

### 2.8 What this costs in practice (model, not measurement)

Let H = cold-handshake cost (DNS + TCP + TLS), P = provider RTT, W = pacing
wait, E = execution/parse, Q = queue/poll delay, S = process-spawn cost.

| Path today | Cost shape | Dominant waste |
|---|---|---|
| One collector action | H + P + W + E | H repaid per action/round |
| Full company Run (A applicable actions, R rounds) | R × Σ(H + P + W + E) + Q | R×A cold handshakes; sequential Σ |
| Continuation Run | Same as one bounded round + full-body revision write | Re-resolves identical hosts; rewrites full brief |
| K PDFs in one Run | K × (S + base64 33% + JSON + up-to-8 s wait) | K spawns, K codecs |
| Idle-to-admission | Q ∈ [0, 2 s] | Polling, not event-driven |
| Every DB touch | spawn_blocking + mutex + (Immediate txn) | Serialization; write locks for reads |

The spec already warns that broader Rust concurrency must not evade provider
pacing/backoff or `Retry-After`
(`docs/bloomberg-terminal-spec.md:130-142`); any concurrency proposal must keep
the `Pacer` gates (`crates/app/src/collect.rs:295-314`).

---

## 3. Re-architecture proposals (concrete, Rust-native)

Each proposal preserves the durable-Run and evidence contracts in
`docs/bloomberg-terminal-spec.md:117-129` (record/revision identity, source and
claim ledgers, coverage/frontier vocabulary) unless stated otherwise.

### 3.1 Shared `reqwest::Client` per provider/host with pool and keep-alive tuning

**Change.** Replace every per-request `Client::builder()…build()` in collector
and integrations paths with a small set of long-lived clients:

- One lazy-static (or `App`-owned) client per trust domain: (a) public
  collectors, (b) Firecrawl, (c) Google APIs, (d) each LLM base URL, (e) Jev
  endpoint. Key the public-collector pool by `(scheme, host, port)` only where
  `resolve_to_addrs` pinning requires a distinct pool entry (see §3.2).
- Configure each shared builder once: `pool_idle_timeout(90s)`,
  `pool_max_idle_per_host(<bounded, e.g. 8–32>)`, `tcp_keepalive(60s)`,
  `timeout(<existing per-site value>)`, `redirect(Policy::none())`,
  existing `no_proxy`/`user_agent` settings. Current per-site timeouts to
  preserve: 18 s collectors (`crates/app/src/collect.rs:25`), 45 s Google
  helper (`crates/app/src/integrations.rs:83-86`), 90 s Firecrawl
  (`crates/app/src/integrations.rs:501-504`), 30 s public source
  (`crates/app/src/integrations.rs:753`), 180 s LLM
  (`crates/app/src/llm.rs:108`, `crates/app/src/llm/providers.rs:68`),
  90 s Jev (`crates/app/src/judgments.rs:68-71`).
- Keep `reqwest::Client: Clone` sharing (cheap `Arc` internally) for
  `for_session`/`with_request_timeout` variants, which already clone correctly
  (`crates/app/src/llm/providers.rs:244-252`).

**Why.** `Client` owns the connection pool; building per request guarantees cold
handshakes (`https://docs.rs/reqwest/latest/reqwest/struct.Client.html`,
`https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html`). Pool reuse
converts §2.1's R×A handshakes into ~1 per host per idle window.

**Safety.** Redirect policy stays `none` with manual revalidation
(`crates/app/src/collect.rs:442-471`); proxy stays disabled on the pinned paths
(`crates/app/src/collect.rs:408-411`, `crates/app/src/integrations.rs:748-756`);
per-host `Pacer` gates stay in front of every send
(`crates/app/src/collect.rs:407`).

### 3.2 DNS cache in front of pinning; keep pinning where it is load-bearing

**Change.** Insert a short-TTL DNS cache (e.g. 30–60 s, bounded to a few hundred
entries) between `pinned_addresses` and `resolve_to_addrs`:

- Cache key `(host, port)` → `(resolved_at, Vec<SocketAddr>)`; on hit within
  TTL, reuse after re-applying the existing `public_ip` filter
  (`crates/app/src/collect.rs:209-246`).
- Keep per-request `resolve_to_addrs` (it is cheap once the address list is
  cached) so the established-connection-in-spite-of-DNS-change guarantee and
  the public-perimeter checks remain (`crates/app/src/collect.rs:413-414`).
- Do **not** cache loopback allow-list decisions beyond the request; the
  `CHIEF_COLLECT_*_BASE` check stays per request
  (`crates/app/src/collect.rs:136-149`).
- Eliminate `resolve_to_addrs` only where it is provably redundant (same
  process, same pooled host, no perimeter requirement) — never on the
  arbitrary-target collector or public-source paths.

**Why.** DNS typically costs a fraction of TLS but is paid on every hop today
(§2.2). A TTL cache preserves the SSRF/perimeter semantics while removing the
repeated `lookup_host` round-trips inside one Run's burst.

### 3.3 Pooled SQLite: connection pool, WAL + `synchronous=NORMAL` + `busy_timeout`, prepared statements, paged reads, revision deltas

**Change (in dependency order).**

1. **Pragmas first (no schema change).** Keep `journal_mode = WAL`
   (`crates/app/src/db.rs:38`) and `busy_timeout = 5_000`
   (`crates/app/src/db.rs:39`); add `synchronous = NORMAL` (the documented
   WAL-appropriate setting; see `https://www.sqlite.org/pragma.html` and
   `https://www.sqlite.org/wal.html`). This is a one-line, low-risk win.
2. **Read/write split without a second scheduler.** Keep `Immediate` for
   `transaction` writers (`crates/app/src/db.rs:66-82`); add a read path that
   does **not** take `Immediate` (deferred/shared lock) so `get`/`list`/stats
   stop reserving write locks (`crates/app/src/store.rs:54-69`).
3. **Pool.** Replace `Arc<Mutex<Connection>>` (`crates/app/src/db.rs:12-14`)
   with a small bounded pool (e.g. `r2d2` + `r2d2-sqlite`, or a hand-rolled
   `deadpool`-style set of `Connection`s each running the same pragmas). Size
   it to worker concurrency + 1 web reader (e.g. 4–8). Every pooled connection
   must run the identical `WAL + NORMAL + busy_timeout` setup on checkout.
   Keep `spawn_blocking` around every checkout because rusqlite remains
   synchronous (`https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html`,
   `https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html`).
4. **Prepared-statement cache.** Cache the hot statements (`record` get/upsert,
   `revision` insert, `job` claim/list/update, attempt insert) per pooled
   connection instead of preparing per call (`crates/app/src/store.rs:26-38`,
   `crates/app/src/work.rs:108-133`).
5. **Paged/list-keys reads.** Add `list_keys(kind, after, limit)` and
   `list_page(kind, after_updated_at, limit)` alongside the existing full
   `list`; migrate index pages and any high-cardinality caller off full `list`.
   Keep `store::list` for small kinds to avoid a flag-day.
6. **Append-only frontier deltas + revision pruning.** Keep the `record` +
   `revision` contract (`crates/app/src/store.rs:6-9`), but (a) write
   frontier/progress deltas as small append-only rows during a Run and
   materialize the full snapshot only at Run completion, and (b) add a bounded
   retention job (e.g. keep last N revisions or last T days; privacy purge
   keeps its full-delete semantics in `crates/app/src/terminal/mod.rs:285-380`
   and `crates/app/src/store.rs:46-53`). Any pruning rule needs explicit
   product approval because historical snapshots are user-visible history
   (`docs/bloomberg-terminal-spec.md:117-129`).

**Why.** Removes the single-mutex ceiling (§2.3), stops reads from taking write
locks, cuts prepare overhead, and converts list-all O(n) parses into O(page).
Deltas convert per-heartbeat full-body rewrites into small inserts.

### 3.4 Event-driven worker wake (`Notify`/`watch`) plus bounded `JoinSet` concurrency with per-host pacing preserved

**Change.**

- Add `tokio::sync::Notify` (or a `watch` generation counter) to `App`; every
  `enqueue` notifies after commit (`crates/app/src/work.rs:67-92`,
  `https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html`,
  `https://docs.rs/tokio/latest/tokio/sync/struct.watch.html`). The worker
  loop (`crates/app/src/main.rs:24-37`) waits on `notified()` with the existing
  2 s sleep retained only as a liveness backstop (lease-expiry recovery in
  `crates/app/src/work.rs:122-133` still needs periodic sweeps).
- Keep one-claim-at-a-time by default (durable-Run fencing depends on it,
  `crates/app/src/work.rs:120-134`), but allow a bounded `JoinSet` of Run
  executions (e.g. `--worker-concurrency 1..4`, default 1) once the pool in
  §3.3 lands. Fencing rules that must survive: input-version checks
  (`crates/app/src/terminal/execution.rs:467-470`), superseding queued/in-flight
  comparison results (`docs/bloomberg-terminal-spec.md:164-172`), lease
  ownership (`crates/app/src/work.rs:159-169`).
- Inside one company Run, execute independent collector actions through a
  bounded `JoinSet` (e.g. 4–8 in flight) **behind the existing `Pacer`**, which
  already spaces per-origin requests (`crates/app/src/collect.rs:295-314`).
  Preserve `Retry-After` and contact-gating
  (`crates/app/src/terminal/execution.rs:477-496`,
  `crates/app/src/collect.rs:338-352`). This mirrors the already-accepted
  chunked-`JoinSet` pattern used for judgment batches
  (`crates/app/src/terminal/automatic/research.rs:1182-1184` and siblings).
- Keep synthesis, correction, and persistence sequential after collection
  joins (`crates/app/src/terminal/execution.rs:531-544`).

**Why.** Converts admission latency from up-to-2 s polling (§2.5) to
notification latency, and converts per-round wall time from ΣL to ~max(L) per
pacing domain — without weakening the pacing/backoff contract the spec
requires (`docs/bloomberg-terminal-spec.md:130-142`).

### 3.5 Persistent PDF worker pool (long-lived child + length-delimited protocol) or in-process sandboxed parser with equivalent isolation

**Change (preferred first).** Keep the re-exec isolation model
(`crates/app/src/main.rs:5-8`) but replace fork-per-PDF with a small pool of
long-lived workers:

- Spawn N (e.g. `min(num_cpus, 2–4)`) children at startup; each speaks a
  length-delimited JSON protocol over stdin/stdout (4-byte LE length prefix +
  JSON frame) instead of one-shot stdin-to-EOF
  (`crates/app/src/pdf.rs:139-170` today).
- Parent sends `{bytes_b64, page_offset, max_pages}` frames (same validation
  bounds, `crates/app/src/pdf.rs:23-28`); child replies with the same
  `WorkerResponse` shape and loops for the next frame.
- Enforce per-request wall time (existing 8 s,
  `crates/app/src/pdf.rs:25`) by killing and respawning only the offending
  child; enforce an idle recycle (e.g. restart each worker every K requests or
  M minutes) to bound state accumulation.
- Optionally switch the frame payload from base64 JSON to length-prefixed raw
  bytes + JSON header to remove the 33% codec tax; keep JSON envelopes so the
  honest `partial`/`error` contract is unchanged
  (`crates/app/src/pdf.rs:1-16`).

**Alternative (only with equivalent isolation).** An in-process sandboxed
parser is acceptable only if it reproduces fault isolation (a malformed PDF
cannot crash the server), resource bounds (input/output/time caps), and the
no-OCR honesty rule (`docs/bloomberg-terminal-spec.md:174-182`,
`crates/app/src/pdf.rs:1-16`). On Linux that means a seccomp/namespace or
equivalent sandbox around the parser — a larger review surface than the worker
pool, so it is the second choice.

**Why.** Removes K process spawns and K×(base64+JSON) codecs per Run (§2.6)
while keeping the crash/hang-cannot-kill-the-server guarantee that justifies
the subprocess in the first place.

### 3.6 LLM/Jev connection/session reuse plus JSON batching and caching

**Change.**

- The provider structs already hold one `Client` and clone it for session and
  timeout variants (`crates/app/src/llm/providers.rs:244-252`,
  `crates/app/src/llm.rs:122-125`) — keep that shape and make it actually warm
  by applying §3.1 pool tuning to the LLM/Jev builders (180 s / 90 s timeouts
  preserved, `crates/app/src/llm.rs:107-110`,
  `crates/app/src/llm/providers.rs:66-70`,
  `crates/app/src/judgments.rs:67-71`).
- Keep `for_session(&job.id)` per Run (`crates/app/src/work.rs:144-156`) so a
  Run's parallel generation calls share routing/cache affinity
  (`crates/app/src/llm.rs:17-20`).
- Extend the `RunJudgments` per-execution memo (keyed by
  `content_hash(state+questions)`,
  `crates/app/src/terminal/automatic/research.rs:26-42`) in two cautious
  steps: (a) batch independent audit/support questions for one section into a
  single `evaluate` call where the Jev question schema allows it, rather than
  one call per claim; (b) persist only *validated* judgments keyed by
  (model, normalized question, evidence-hash) with explicit invalidation on
  evidence change — never across changed evidence, per the module's own reuse
  rule (`crates/app/src/terminal/automatic/research.rs:6-18`). Unchanged
  rejected content already avoids re-rolls by design.
- Keep strict JSON-schema validation on every model output
  (`crates/app/src/llm/providers.rs:84-132`,
  `docs/bloomberg-terminal-spec.md:143-155`); batching must not weaken the
  per-claim support-review or extraction-audit semantics.

**Why.** Converts per-claim LLM/Jev round-trips into fewer, warmer, schema-
checked calls. Cost scales with tokens (prompt cap 400 k chars,
`crates/app/src/llm/providers.rs:80-83`); batching reduces request count and
handshake overhead while caching removes exact-duplicate spend inside and
across retried Runs.

---

## 4. Cost/speed model: handshake vs reuse, spawn vs pooled, polling vs notify, serialization vs concurrency

Symbols: H = cold-connection cost (DNS + TCP + TLS), P = provider RTT,
W = pacing wait, E = local execution/parse, Q = queue admission delay,
S = process-spawn cost, C = codec cost (base64 + JSON), M = mutex/pool wait.

| Decision | Cold (today) | Warm (proposed) | Saving | Source |
|---|---|---|---|---|
| Collector HTTP | H + P + W + E per action/round (`crates/app/src/collect.rs:408-416`) | P + W + E after first H per host idle window | (R×A − hosts) × H | `https://docs.rs/reqwest/latest/reqwest/struct.Client.html`, `https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html` |
| DNS pinning | `lookup_host` + validate per request/hop (`crates/app/src/collect.rs:236-246`, `crates/app/src/integrations.rs:740-756`) | lookup per TTL window, validate per request | (requests − TTL misses) × DNS RTT | `https://docs.rs/tokio/latest/tokio/net/fn.lookup_host.html` (via tokio net docs) |
| PDF extraction (K docs) | K×(S + C + ≤8 s) (`crates/app/src/pdf.rs:110-170`) | N warm children; per doc C′ (smaller without base64) + ≤8 s | K×S + K×(C − C′) | `https://docs.rs/tokio/latest/tokio/process/struct.Command.html` |
| Run admission | Q ≤ 2 s polling (`crates/app/src/main.rs:30-35`) | Q ≈ notify latency | ~1 s mean, 2 s worst case per admission | `https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html` |
| Collection wall time (A actions) | Σ(H+P+W+E) sequential (`crates/app/src/terminal/execution.rs:477-508`) | ≈ max over pacing domains with JoinSet ≤ limit | Σ − max per round | `https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html` |
| DB access | `spawn_blocking` + single mutex + `Immediate` even for reads (`crates/app/src/db.rs:50-82`) | pooled conns + shared-lock reads + stmt cache | M contention → ~1/lock; prepare cost → ~0 hot | `https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html`, `https://www.sqlite.org/wal.html` |
| Revisions | 2× full body per `put` (`crates/app/src/store.rs:32-38`) | deltas during Run + full snapshot at completion + retention | (writes − 1) × body bytes during Run | `crates/app/src/store.rs:6-9` |
| LLM/Jev | 1 call per claim/question + cold H (`crates/app/src/llm/providers.rs:140-144`, `crates/app/src/judgments.rs:79-130`) | batched + cached + warm H | (calls − batches − cache hits) × (H + P) | Provider builders above; memo in `crates/app/src/terminal/automatic/research.rs:26-42` |

Worked illustration (structure-derived, not a benchmark): a full company Run
with A = 20 applicable actions and R = 3 rounds pays ~60 cold handshakes today
(`crates/app/src/research.rs:18-45`, `crates/app/src/lib.rs:85-93`). With a
shared pool over D ≈ 10 distinct hosts, warm cost is ~10 handshakes per idle
window — a ~6× reduction in handshake count before any provider-RTT change.
Sequential ΣL → JoinSet(4) with per-host pacing converts the round wall time
toward the slowest pacing domain rather than the sum, while the `Pacer`
(`crates/app/src/collect.rs:295-314`) still enforces provider spacing.

Measurement hooks (to confirm before/after): record per-Run
`{actions, rounds, cold_hosts, handshake_ms, pacing_wait_ms, db_wait_ms,
pdf_spawns, llm_calls, jev_calls}` in the Run result or `job_attempt` row
(`crates/app/src/work.rs:18-22`); the lease-heartbeat path already shows where
periodic writes go (`crates/app/src/work.rs:159-169`).

---

## 5. Phased cutover that preserves durable Runs and evidence contracts

Constraints carried through every phase: durable Run status/retry/progress
(`docs/bloomberg-terminal-spec.md:73-74` in spec user stories numbering —
“durable Run status, failure details, retry and partial research progress”),
stale-research fencing on profile change (`crates/app/src/terminal/execution.rs:467-470`),
revision provenance (`crates/app/src/store.rs:6-9`), input-version fencing for
comparisons (`docs/bloomberg-terminal-spec.md:164-172`), privacy purge
(`crates/app/src/terminal/mod.rs:285-380`), and no invented completeness
(`crates/app/src/terminal/automatic/research.rs:350-355` limits text).

### Phase 0 — Baseline and guardrails (no behavior change)

- Add per-Run timing/cost counters (§4) to Run results; expose them in the Run
  detail view (`crates/app/src/work.rs:260-344` renders Run detail).
- Add regression tests pinning: redirect revalidation
  (`crates/app/src/collect.rs:442-471`), DNS perimeter rejection
  (`crates/app/src/collect.rs:174-246`), pacing decisions via the test clock
  (`crates/app/src/collect.rs:288-314`), revision provenance
  (`crates/app/src/store.rs:32-38`), lease fencing
  (`crates/app/src/work.rs:120-169`), version fencing
  (`crates/app/src/terminal/execution.rs:467-470`), PDF isolation honesty
  (`crates/app/src/pdf.rs:1-16`).
- Verification: `cargo fmt`, workspace check, warning-denying Clippy, full
  test suite with lockfile, plus browser smoke of both profile types and
  comparison updates per the spec's completion rule
  (`docs/bloomberg-terminal-spec.md:184-195`).

### Phase 1 — Warm connections (low risk, high return)

- Introduce shared clients per §3.1 behind the existing call signatures
  (`collector_get_with(pacer, …)`, `run_collector_with`,
  `integrations::client()`); keep timeouts, `no_proxy`, redirect policy, and
  `Pacer` gates byte-identical.
- Add the DNS TTL cache per §3.2 with the perimeter checks untouched.
- Roll out behind no flag (pure optimization): the observable contract —
  envelope statuses, coverage states, frontier items
  (`crates/app/src/terminal/runner.rs:99-208`) — is unchanged.
- Verification: existing HTTP tests with controlled transports still assert
  user-visible outcomes (`docs/bloomberg-terminal-spec.md:184-195`); add a pool-
  reuse test (two sequential same-host fetches → one pool entry / second fetch
  without new connect, observable via test hook or timing-insensitive pool
  counter); smoke live collection once and label real vs controlled behavior.

### Phase 2 — Event-driven wake + bounded collection concurrency

- Add `Notify`/`watch` to `App` and notify on enqueue; keep the 2 s sleep as a
  backstop (`crates/app/src/main.rs:24-37`, `crates/app/src/work.rs:67-92`).
- Gate collection fan-out behind `JoinSet` with a fixed limit and the existing
  `Pacer`; keep synthesis sequential
  (`crates/app/src/terminal/execution.rs:477-544`).
- Keep worker Run concurrency at 1 until Phase 3 proves the pool; the notify
  change alone removes admission latency without touching fencing.
- Verification: admission-latency test (enqueue → execution start without
  waiting 2 s), pacing-invariance test (same per-origin spacing under
  concurrency), `Retry-After` honored, contact-gated actions still blocked
  without contact (`crates/app/src/terminal/execution.rs:477-496`).

### Phase 3 — Pooled storage and paged reads

- Land pragmas (`synchronous = NORMAL`), read/write split, pool, statement
  cache, then paged/key listings (§3.3 steps 1–5 in order).
- Migrate high-cardinality list callers to pages; keep full `list` for small
  kinds during the transition (`crates/app/src/store.rs:26-31`).
- Only then raise worker Run concurrency above 1, with lease/input-version/
  comparison-supersede tests green (`crates/app/src/work.rs:120-195`,
  `docs/bloomberg-terminal-spec.md:164-172`).
- Verification: concurrent-claim test (no double-claim under contention),
  busy-timeout recovery test, full-suite plus a production-image boot and
  isolated Workspace persistence smoke per the spec's container rule
  (`docs/bloomberg-terminal-spec.md:184-195`).

### Phase 4 — PDF worker pool and LLM/Jev batching

- Replace fork-per-PDF with the pooled length-delimited workers (§3.5), keeping
  `extract_isolated`'s signature and all bounds
  (`crates/app/src/pdf.rs:110-170`); kill-and-respawn on timeout preserves the
  honest `partial`/`error` envelope.
- Ship LLM/Jev batching + validated-judgment cache (§3.6) after the pool work
  so token-spend changes are independently measurable.
- Verification: malformed-PDF crash test (server survives), timeout-kill test
  (8 s honored, child respawned), oversized-input rejection
  (`crates/app/src/pdf.rs:23-28`); judgment tests asserting unchanged-evidence
  reuse only and re-evaluation on changed evidence
  (`crates/app/src/terminal/automatic/research.rs:6-42`); schema-validation
  failures still surface as operational limits, never passes
  (`docs/bloomberg-terminal-spec.md:143-155`,
  `crates/app/src/judgments.rs:79-130`).

### Phase 5 — Revision deltas and retention (needs product sign-off)

- Frontier deltas during Runs; full snapshots at completion; bounded retention
  with privacy-purge preservation (§3.3 step 6).
- Requires explicit approval because it touches user-visible history
  (`docs/bloomberg-terminal-spec.md:117-129`); ship behind a migration that
  never rewrites historical source evidence, only routing references where the
  spec allows (`docs/bloomberg-terminal-spec.md:100-106`).
- Verification: history-preservation test (old snapshots byte-identical),
  purge-completeness test (all retained artifacts for the subject removed),
  archive smoke (`docker-compose.yml:48-50` volume).

### Rollback and safety notes

- Every phase is independently revertible: shared clients → per-request
  builders; notify → 2 s poll; pool → single mutex; worker pool → fork-per-PDF;
  batching/cache → per-claim calls. No phase changes the `record`/`revision`/
  `job` schemas (`crates/app/src/store.rs:6-9`, `crates/app/src/work.rs:18-22`)
  except Phase 5, which ships its own forward migration.
- Provider pacing, `Retry-After`, robots/login/paywall boundaries, and the
  public-network perimeter stay enforced throughout
  (`docs/bloomberg-terminal-spec.md:130-142`,
  `docs/bloomberg-terminal-spec.md:174-182`).
- Credentials/contact echoes stay out of evidence, errors, and judgment inputs
  (`docs/bloomberg-terminal-spec.md:174-182`,
  `crates/app/src/llm.rs:339-359`).

---

## Appendix A. File map (where each layer lives)

- Entry/runtime: `crates/app/src/main.rs:1-52`, `crates/app/src/lib.rs:124-269`.
- Config/limits: `crates/app/src/lib.rs:30-103`, `docker-compose.yml:12-45`.
- Collectors/HTTP: `crates/app/src/collect.rs:1-30` (constants/envelope),
  `crates/app/src/collect.rs:174-246` (perimeter/DNS),
  `crates/app/src/collect.rs:271-336` (pacing),
  `crates/app/src/collect.rs:381-471` (GET + redirects),
  `crates/app/src/collect.rs:2559-2603` (USAspending reuse example).
- Integrations HTTP: `crates/app/src/integrations.rs:82-105`,
  `crates/app/src/integrations.rs:501-504`,
  `crates/app/src/integrations.rs:740-771`.
- Persistence: `crates/app/src/db.rs:1-82`, `crates/app/src/store.rs:1-84`,
  `crates/app/src/work.rs:18-22`.
- Queue/worker: `crates/app/src/main.rs:24-37`, `crates/app/src/work.rs:108-235`.
- PDF isolation: `crates/app/src/pdf.rs:1-170`.
- LLM: `crates/app/src/llm.rs:1-147` (trait + Mistral),
  `crates/app/src/llm/providers.rs:1-252` (LiveLlm),
  `crates/app/src/llm/catalog.rs` (allow-lists).
- Judgments: `crates/app/src/judgments.rs:1-130`.
- Terminal: `crates/app/src/terminal/mod.rs:1-106`,
  `crates/app/src/terminal/execution.rs:445-545`,
  `crates/app/src/terminal/runner.rs:99-208`,
  `crates/app/src/terminal/automatic/research.rs:350-417` (rounds/budgets),
  `crates/app/src/terminal/automatic/research.rs:596-677` (follow-ups),
  `crates/app/src/terminal/continuation.rs:1-72`.
- Deploy: `Dockerfile:1-28`, `docker-compose.yml:1-71`.

## Appendix B. Official documentation references

- `reqwest::Client` (pool ownership, `Clone` shares pool):
  `https://docs.rs/reqwest/latest/reqwest/struct.Client.html`
- `reqwest::ClientBuilder` (`pool_idle_timeout`, `pool_max_idle_per_host`,
  `tcp_keepalive`, `timeout`, `redirect`):
  `https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html`
- `tokio::task::spawn_blocking`:
  `https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html`
- `tokio::task::JoinSet`:
  `https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html`
- `tokio::sync::Notify` / `watch`:
  `https://docs.rs/tokio/latest/tokio/sync/struct.Notify.html`
  and `https://docs.rs/tokio/latest/tokio/sync/struct.watch.html`
- `tokio::process::Command` (`kill_on_drop`):
  `https://docs.rs/tokio/latest/tokio/process/struct.Command.html`
- `rusqlite::Connection`:
  `https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html`
- SQLite WAL: `https://www.sqlite.org/wal.html`
- SQLite pragmas (`journal_mode`, `synchronous`, `busy_timeout`, `cache_size`):
  `https://www.sqlite.org/pragma.html`
