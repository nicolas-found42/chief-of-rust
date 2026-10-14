# omp ↔ Jev integrations

_Researched 2026-10-14. Question: are there already-built omp-side integrations (MCP servers,
Eval helpers, extensions, hooks, marketplace packages, CLI tools, SDKs) that talk to
Jev/TypeSafe, and could this repo use them instead of, or alongside, its raw `reqwest` client?
Repo commit: `4e304e9`._

_Path note: this repo has no `docs/research/` convention (it keeps `docs/agents/`,
`docs/meetings/`, `docs/teardown/`, `docs/ux/`), so this file lives at the repo root of `docs/`
as `docs/omp-jev-integrations.md`._

"omp" = the oh-my-pi coding-agent harness (`/opt/homebrew/bin/omp` → `Cellar/omp/18.10.4`).
"Jev" = TypeSafe's System One judgment model (`typesafe/jev-1.13`, `jev-latest`).

## Bottom line

- **Yes.** omp already has a *first-class, built-in* Jev integration: the `judge` model role
  plus the `judge()` / `judge_batch()` Eval helpers, wired through a native `typesafe`
  transport (also `openrouter-decisions` / `openai-decisions` / `workers-ai-systemone`). It is
  the same System One protocol `crates/app` speaks, and it is selected purely by config
  (`modelRoles.judge`) and `TYPESAFE_API_KEY` — no code.
- **A real omp extension exists**: `omp-typesafe` v0.2.0 (npm, `omp.extensions` manifest) — an
  adversarial/advisory reviewer, ambiguity gate, stop gate, and Jev-scored context compaction
  that also registers a `typesafe_ask` tool. It is a *coding-agent supervisor*, not a library
  this repo's server could call; it consumes Jev, it does not serve it.
- **Two general-purpose Jev MCP servers exist**: the already-mounted `jev-browser` (v0.2.0,
  browser-only) and the community `typesafe-mcp` v0.3.0 (general noul/choice/score tools over
  stdio, Bun runtime). Either is declarable in `.omp/mcp.json`.
- **Vendor surface**: TypeSafe ships **only** Python (`typesafe-sdk` 0.7.4) and JS/TS
  (`@typesafe-ai/sdk` 0.6.0) SDKs plus an agent *skill* — **no official MCP server, no hosted
  MCP endpoint, and no official Rust SDK/crate**. The Rust ecosystem is all *unofficial*
  third-party crates.
- **For `crates/app` specifically**, the raw `reqwest` path is already correct and
  documented; the only concrete wins available are (a) a different auth route
  (`api.typesafe.ai` with `TYPESAFE_API_KEY` instead of OpenRouter billing), (b) a
  typed Rust client crate instead of hand-rolled JSON, or (c) routing through a local
  `omp auth-gateway serve`. omp's own `judge` role cannot be called *from* Rust except by
  spawning `omp`.
- **One real defect found**: the OpenRouter/TypeSafe `DecisionsResponse` schema that
  `crates/app/src/judgments.rs` parses has **no `warnings` field** (nor `refused`). The repo
  treats a non-empty `warnings` as a hard failure, but nothing populates it over the wire —
  only its own test fixture does.

## Inventory

### 1. Built-in omp judge role + `judge()` / `judge_batch()` Eval helpers (native TypeSafe)

- **What it is:** omp's own judgment subsystem. `modelRoles.judge` selects a `judge`-kind model;
  the same transport serves `eval`'s `judge(state, questions)` / `judge_batch(...)` helpers,
  auto-thinking difficulty classification, unexpected-stop detection, AI-assisted git staging,
  `find` (semantic search), and TTSR `question:` rules.
- **Where it lives:** harness docs `omp://models.md:143-151`, `omp://settings.md:395-419`,
  `omp://environment-variables.md:422-432`, `omp://tools/find.md:33`,
  `omp://ttsr-injection-lifecycle.md:294-297`, `omp://auth-broker-gateway.md:193,204,214`;
  Eval device docs `xd://eval/judge`, `xd://eval/agents`;
  local config `/Users/nicolas/.omp/agent/config.yml` (`modelRoles.judge:
  openrouter/typesafe/jev-1.13`).
- **Transport APIs** (declared per-model in `models.yml` or the bundled catalog):
  `typesafe` → `POST {baseUrl}/v1/systemone`; `openrouter-decisions` → `POST {baseUrl}/decisions`;
  `openai-decisions` → OpenAI Decisions API; `workers-ai-systemone` → Cloudflare Workers AI
  (`omp://models.md:143-149`). The `typesafe` API is described as accepting "any System One
  server: TypeSafe, OpenJEV, Kev, self-hosted Clef".
- **How to use it:** set the `judge` role, e.g.
  `modelRoles: { judge: typesafe/jev-latest }` in `~/.omp/agent/config.yml` (or
  `openrouter/~typesafe/jev-latest` for the OpenRouter route). Credential resolution:
  `TYPESAFE_API_KEY` (native, discovers from `GET /v1/models`), or `OPENROUTER_API_KEY` for the
  `~typesafe/*` OpenRouter rows. Env overrides: `TYPESAFE_BASE_URL`,
  `TYPESAFE_DEFAULT_MODEL` (`omp://environment-variables.md:428-432`).
- **Bundled judge chain** (verified in the installed binary): `typesafe/jev-latest` →
  `openrouter/~typesafe/jev-latest` → `@tiny` → `@smol` → `@default`.
- **Evidence (executed):** `omp models --kind judge --json` on this machine listed
  `typesafe/jev-latest` (baseUrl `https://api.typesafe.ai`, cost $0.042/Mtok in),
  `openrouter/~typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`, `openrouter/typesafe/jev-router`,
  `opencode-zen/jev-1.13`, and OpenAI/Cloudflare/Span/Decider judges. A live `judge_batch` call
  from Eval returned `model: "openrouter/typesafe/jev-1.13-20260917"`, cost `$2.34e-05`
  **[EXECUTED]**. The native `typesafe` transport row was read from the embedded catalog:
  `{"id":"jev-latest","api":"typesafe","provider":"typesafe","baseUrl":"https://api.typesafe.ai",…}`.

### 2. Mounted `jev-browser` MCP server (browser-only)

- **What it is:** an MCP server wrapping Jev for browser automation. Jev picks the element /
  action / value each round; Playwright acts. Its own client (`src/jev.mjs`) is a minimal
  System One caller: `POST {JEV_API_URL}` with `{state, model, questions}`, returning
  `body.answers` and `body.usage.input_tokens`.
- **Where it lives:** `/opt/homebrew/lib/node_modules/jev-browser/` (v0.2.0,
  `bin/jev-browser-mcp.mjs`, stdio); declared in `/Users/nicolas/.omp/agent/mcp.json` as
  `jev-browser` with `TYPESAFE_API_KEY`, `JEV_API_URL=https://openrouter.ai/api/v1/systemone`,
  `JEV_MODEL=typesafe/jev-1.13`. Docs: `xd://mcp__jev_browser_*`, package `README.md`,
  `NOTES.md`, `RESULTS.md`.
- **Tools:** `browser_open`, `browser_do`, `browser_check`, `browser_choose`,
  `browser_snapshot`, `browser_act`, `browser_screenshot`, `browser_close`, `browser_read`,
  `browser_webmcp_tools`, `browser_webmcp_call` (`bin/jev-browser-mcp.mjs`).
- **Is it browser-only?** Yes for its tool surface. It exposes **no** general Jev judgment tool;
  `browser_check` / `browser_choose` are page-scoped yes/no and choice questions only. Its
  reusable part is the library (`src/index.mjs` re-exports `jev`, `apiKey`) and CLI
  (`bin/jev-browser.mjs`), not an RPC surface for arbitrary states.
- **Evidence:** `src/jev.mjs:12-13` (default `https://api.typesafe.ai/v1/systemone`,
  `jev-latest`), `src/jev.mjs:20-35` (key resolution: `TYPESAFE_API_KEY` only),
  `src/jev.mjs:40-53` (`{state, model, questions}` body; reads `answers`, `usage.input_tokens`).
  Also note the harness drops recognized browser MCP servers when the built-in browser prelude
  is active (`omp://mcp-config.md`) — `jev-browser` is *not* on that drop list, which is why it
  still loads here.

### 3. `typesafe-mcp` (community, general Jev MCP server)

- **What it is:** "MCP server exposing TypeSafe AI's Jev decision model (Choice / Score / Noul)
  as typed tools." Default tool `jev_ask` covers all three question types; `TYPESAFE_TOOLS=all`
  adds `jev_check`, `jev_classify`, `jev_score`, `jev_models`.
- **Where it lives:** npm `typesafe-mcp` v0.3.0 (repo `github.com/MarkChu-git/typesafe-mcp`,
  depends on `@typesafe-ai/sdk ^0.6.0`), stdio transport, **requires Bun ≥1.2** (`engines.bun`).
- **How to use it:** add to `.omp/mcp.json`:
  `{"mcpServers":{"jev":{"command":"bunx","args":["typesafe-mcp"],"env":{"TYPESAFE_API_KEY":"…"}}}}`.
  Env: `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`), `TYPESAFE_TIMEOUT_MS` (10000),
  `TYPESAFE_TOOLS`, `TYPESAFE_FILES_ROOT`.
- **Notable**: batch `files` + `items`/`where`/`top`/`counts` for judging many records in one
  call; a code-computed `decision: act|review|abstain` gate from `certainty`; results are
  `{answer, certainty, decision}` with probabilities under `detailed: true`. It is **not**
  first-party TypeSafe.
- **Evidence:** `npm view typesafe-mcp --json` (bin `dist/typesafe-mcp.js`, `engines.bun >=1.2.0`);
  package README (tool table, env table, `_meta["typesafe.ai/jev"]`, roadmap: Streamable HTTP
  not yet implemented).
- **Sibling community MCP servers** (registry `registry.modelcontextprotocol.io`): e.g.
  `io.github.Renwang-Huang/typesafe-mcp`, `com.jev-agent/jagent`, `io.github.PerryLink/jevcore`,
  `io.github.amidabuddha/jev-decision-mcp`. Not audited individually.

### 4. `omp-typesafe` (real omp extension package)

- **What it is:** an omp extension that adds a Jev-powered adversarial/advisory **reviewer**, an
  **ambiguity gate** (plan mode), an optional **stop gate**, **Jev-scored context compaction**,
  pipeline guards, and a model-callable `typesafe_ask` tool. Registers `/adversary` and
  `/typesafe` commands, hooks `tool_result` / `message_end` / `turn_end` / `tool_call` /
  `before_agent_start`.
- **Where it lives:** npm `omp-typesafe` v0.2.0 (repo `github.com/siddicky/omp-typesafe`); the
  manifest carries the omp-native hook: `"omp": { "extensions": ["./src/index.ts"] }`;
  depends on `@typesafe-ai/sdk ^0.6.0`, `engines.bun >=1.3`. Install with
  `omp plugin install github:siddicky/omp-typesafe`.
- **How to use it:** set `TYPESAFE_API_KEY`, install the plugin, restart omp; optional
  `<agent dir>/typesafe.json` (defaults: `model: "jev-latest"`, `role: "adversarial"`,
  `adversary.reviewActions/reviewMessages/reviewTurns: true`, `compaction.enabled: true`).
- **Fit for this repo as a *dev tool*:** yes — it would review this repo's own agent edits and
  gate plan mode. **Fit as a *library for `crates/app`: no** — it is a Bun/TS extension running
  in an omp session, with no HTTP surface this repo's server could call.
- **Evidence:** `npm view omp-typesafe --json` (keywords `omp`, `oh-my-pi`, `extension`; `omp.extensions`);
  unpacked `package/src/{client.ts,index.ts,pipeline/*}`; README config block and env table
  (`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`); `src/client.ts:1-11` imports
  `TypeSafeClient, choice, noul, score` from `@typesafe-ai/sdk`, and pins SDK log level to `warn`.

### 5. `pi-package` extensions (omp-compatible legacy packages)

- **What they are:** extensions built for omp's upstream `pi`/senpi lineage; omp rewrites legacy
  pi-package specifiers and shims their imports (`omp://extension-loading.md:279-281`), so these
  load in omp.
  - `pi-typesafe` v0.9.1 — "batched Choice/Score/Noul evaluation tool, terminal playground, and
    a typed API other extensions build on"; depends on `@typesafe-ai/sdk ^0.6.0`.
  - `@bismawy/pi-jev-eye` v0.1.17 — supervisor/guardrails semantic gate via TypeSafe Jev or
    OpenRouter or Cloudflare Clef; reports spend in `/jev-eye usage`.
  - `omo-jev-plugin` v0.0.11 — "Configurable Jev decision layer for OmO and senpi" (OmO is a
    separate host, not omp); depends on `@typesafe-ai/sdk 0.6.0`.
- **Evidence:** `npm view … --json` for each (keywords `pi-package`, `pi-extension`).

### 6. Official vendor SDKs

- **`@typesafe-ai/sdk` v0.6.0** (JS/TS, `github.com/typesafe-ai/typesafe-sdk-js`, docs
  `https://docs.typesafe.ai/sdk/javascript`): `new TypeSafeClient()`; reads `TYPESAFE_API_KEY`,
  `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`; `client.systemOne({state, questions, model?})`
  returns `{model, answers, usage:{input_tokens, output_tokens}}`; `client.models.list()`;
  retries + `X-TypeSafe-SDK` / `X-TypeSafe-Runtime` headers.
- **`typesafe-sdk` v0.7.4** (Python, `github.com/typesafe-ai/typesafe-sdk-python`, docs
  `https://docs.typesafe.ai/sdk/python`): `TypeSafeClient` / `AsyncTypeSafeClient`, question
  objects `Noul`/`Choice`/`Score`, `system_one`.
- **Official HTTP API:** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer
  <key>`, body `{state, model, questions}`, response `{model, answers, usage:{input_tokens,
  output_tokens}}`; `GET /v1/models` returns `{name, description, release_date}`. OpenAPI 3.1,
  `info.version "0.2.0"` (`https://api.typesafe.ai/openapi.json`).
- **Official agent integration is a *skill*, not MCP**: `claude plugin marketplace add
  typesafe-ai/skills`; `https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md`.
  `https://docs.typesafe.ai/mcp.md` → 404.
- **Other first-party surface:** `@typesafe-ai/n8n-nodes-typesafe-ai` v0.9.0 (author "TypeSafe AI
  <support@typesafe.ai>"). The `@typesafe-ai` npm scope holds exactly `@typesafe-ai/sdk` and that
  n8n node.
- **Ecosystem adapters (not first-party repos):** `@ai-sdk/typesafe-ai` v3.0.18 (Vercel AI SDK),
  `@effect/ai-typesafe` v4.0.4, `@langchain/typesafe` v0.0.2, `@tanstack/ai-typesafe` v0.1.12,
  `@openrouter/sdk` (docs cover `systemOne.create`, but the published README does not).
- **Evidence:** `npm view @typesafe-ai/sdk --json` + unpacked `dist/index.d.mts`
  (`TypeSafeClient`, `SystemOneRequest`, `SystemOneResult`, `ModelCard`, `TYPESAFE_API_KEY`
  default); `pypi.org/pypi/typesafe-sdk/json`; `docs.typesafe.ai/{sdk.md,api.md,models.md}`;
  `api.typesafe.ai/openapi.json`; `registry.npmjs.org/-/v1/search?text=maintainer:alliesafe`.

### 7. Rust clients (all unofficial)

- **What they are:** no vendor-published crate exists. Third-party crates that speak the same
  System One wire as `crates/app`:
  - `typesafe-sdk-client` 0.6.2 + siblings (`-config`, `-env`, `-http`, `-questions`,
    `-answers`, `-retry`, `-derive`, `-error`, `-headers`, `-log`, `-runtime`) —
    `github.com/douglance/typesafe-sdk-rs`; `Client::system_one(SystemOneRequest)`, brings its
    own `reqwest` transport, `TYPESAFE_API_KEY`, typed `Questions` derive; companion CLI
    `jevon`.
  - `typesafe-ai-sdk` 0.5.0 — `github.com/aoprisan/typesafe-ai-rust-sdk`; deps `reqwest ^0.13.5`,
    `serde`, `tokio`, `thiserror`, `sha2`.
  - `typesafe-systemone` 0.2.0, `typesafe-system-one` 0.1.1, `typesafe-client` 0.1.0,
    `systemone` 0.1.0 (+ `-facet`/`-macro`), `jev` 0.1.2, `jev-sdk` 0.1.0, `jev-driver` 0.1.0,
    `jevlin` 0.2.1, `fuzzy-jev` 0.6.0 (explicitly targets OpenRouter's decisions endpoint),
    `polyc-judgment-systemone` 2026.10.3.
- **Fit for this repo:** `typesafe-sdk-client` / `typesafe-ai-sdk` target **`api.typesafe.ai`
  with `TYPESAFE_API_KEY`**, not OpenRouter. Adopting one means changing the credential and
  base URL, and taking on a young, low-download (25–300 downloads) third-party dependency in
  place of ~40 lines of `reqwest` that already work.
- **Evidence:** `crates.io/api/v1/crates/{…}` for each crate (name, version, description,
  repository, `max_version`, downloads); `typesafe-sdk-client` dep tree; raw README of
  `typesafe-sdk-rs` (`cargo add typesafe-sdk-client typesafe-sdk-config …`);
  `typesafe-ai-sdk/0.5.0/dependencies`.

### 8. omp auth-gateway `/v1/systemone` route

- **What it is:** `omp auth-gateway serve` is a forward proxy that accepts TypeSafe System One
  judgment requests and resolves the credential from the broker. `POST /v1/systemone` (bearer);
  `/alpha/decisions` is the OpenRouter alias; the model id may be `typesafe/jev-latest` or bare
  `jev-latest`. Chat routes reject judge models with a `400` naming `/v1/systemone`.
- **Fit for this repo:** `crates/app` could point `TYPESAFE_BASE_URL` at a local gateway
  (`TYPESAFE_BASE_URL=http://gateway:4000`) and use a gateway token as the bearer, so the real
  TypeSafe key never enters the app container. This is the one **in-harness** surface a
  non-omp process can call over plain HTTP.
- **Evidence:** `omp://auth-broker-gateway.md:193,204,206,214`.

## How this repo could adopt each

| Integration | Effort | What changes in `crates/app` | Gain / loss vs the current `reqwest` client |
|---|---|---|---|
| Built-in omp `judge` role / `judge_batch` | None in Rust | Nothing in `crates/app`. Used only when a *developer* runs omp (`find`, TTSR, reviews). | Cannot be called from Rust except by spawning `omp -p`. No change to the server's own judgments. |
| `omp auth-gateway serve` `/v1/systemone` | Low | Set `TYPESAFE_BASE_URL=http://gateway:4000` and pass the gateway token where `OPENROUTER_API_KEY` is read (`lib.rs:58`, `judgments.rs:46,68`). Already supported because the client just appends `/v1/systemone`. | Gain: real key stays out of the app container; central credential rotation. Loss: an extra local service to run; adds a hard dependency on omp being installed. |
| Point at `api.typesafe.ai` directly | Low | Change the default base URL in `judgments.rs:46` to `https://api.typesafe.ai`, read `TYPESAFE_API_KEY` instead of `OPENROUTER_API_KEY`, and use a native model id (`jev-latest` / `jev-1.13.0`) in the body at `judgments.rs:227`. | Gain: first-party vendor route, vendor-published schema (OpenAPI 0.2.0), no OpenRouter markup. Loss: a second credential to provision; loses OpenRouter's model routing/fallbacks. |
| Unofficial Rust client crate (`typesafe-sdk-client`, `typesafe-ai-sdk`, …) | Medium | Replace `judgments.rs`'s `reqwest` call with the crate; map `Evaluation`/`Usage`. Note: the repo's `Judge` trait already isolates this (`judgments.rs:26`), and tests use `TYPESAFE_BASE_URL` + wiremock (`tests/judgments.rs:70-74`). | Gain: typed `questions`/`answers`, retries. Loss: a young third-party dependency (25–300 downloads) replacing ~40 lines of working code; the crate targets `api.typesafe.ai`, so the OpenRouter route/credential changes too. |
| `typesafe-mcp` MCP server | None in Rust | Declare in `.omp/mcp.json` for *omp sessions*; the Rust server cannot call MCP. | Developer-side only. The repo's server still needs its own HTTP client. |
| `omp-typesafe` extension | None in Rust | `omp plugin install github:siddicky/omp-typesafe` + `TYPESAFE_API_KEY`. | Developer-side review/gating/compaction for agent work on this repo. No effect on `crates/app`'s meeting-debrief pipeline. |
| `@typesafe-ai/sdk` / `typesafe-sdk` | N/A | Wrong language; useful only if a JS/Python sidecar is added. | — |
| `jev-browser` MCP (already mounted) | None | Nothing. | Already available in omp sessions for browser work; no general judgment RPC. |

## Dead ends / does not exist

- **No official TypeSafe MCP server / hosted MCP endpoint.** `https://docs.typesafe.ai/mcp.md`
  → 404; `docs.typesafe.ai/llms.txt` has no MCP page; `registry.npmjs.org/@typesafe-ai%2fmcp`
  → 404; the `@typesafe-ai` scope holds only `sdk` and the n8n node. The official agent
  integration is a Claude/agent **skill**, not MCP.
- **No official Rust SDK, crate, or repo.** `docs.typesafe.ai/sdk.md` lists only Python and
  JS/TS; `docs.typesafe.ai/sdk/rust` → 404; `api.github.com/search/repositories?q=org:typesafe-ai+rust`
  → `total_count: 0`.
- **OpenRouter documents nothing under the names you'd guess.** `openrouter.ai/docs/features/systemone`,
  `/docs/decisions`, `/docs/api-reference/systemone`, `/docs/api-reference/decisions` → all 404.
  The documented pages are `POST /api/v1/systemone` (tag `SystemOne`, op `createSystemone`) and
  `POST /api/alpha/decisions`; a changelog link to a "TypeSafe SDK compatible alias" page is
  itself stale (404).
- **`warnings` is not a documented response field.** Neither `api.typesafe.ai/openapi.json` nor
  OpenRouter's `DecisionsResponse` defines `warnings` or `refused`; the documented keys are
  `model`, `answers`, `usage` (+ OpenRouter's `id`, `provider`, `usage.cost`). `crates/app` reads
  `warnings` with `#[serde(default)]` and hard-fails on non-empty (`judgments.rs:20,79-81`), but
  only its own wiremock fixture ever populates it (`tests/meeting_debrief.rs:50`).
- **No omp *marketplace* package for Jev.** The user's `~/.omp/marketplaces.json` and
  `~/.omp/plugins/installed_plugins.json` are absent/empty; no Jev marketplace catalog is
  registered. `omp-typesafe` installs by git/npm spec, not from a Jev marketplace.
- **`omp models` does not list a bare `typesafe/jev-1.13`** as the *native* TypeSafe provider
  model; the native row is `typesafe/jev-latest` at `https://api.typesafe.ai`. The
  `typesafe/jev-1.13` id the repo sends is mapped by OpenRouter onto `typesafe/jev-1.13` and
  accepted by the native API as a versioned alias, but omp's own catalog exposes the version
  id under OpenRouter/opencode-zen rows.
- **`@openrouter/sdk` does not document `systemOne` in its published README** (grep: no
  matches); only the docs site does. **[DOCUMENTED, NOT EXECUTED]** — no live API call made.
- **`npm search` is not a reliable discovery surface**: it omits `@typesafe-ai/sdk` from a
  `typesafe` keyword search but returns it for the `@typesafe-ai` scope. Registry search
  (`registry.npmjs.org/-/v1/search?text=…`) was used to enumerate the scope instead.
- **crates.io's search endpoint rejects plain reader fetches (403)**; results above were
  obtained via the crates.io JSON API with a `User-Agent`.

## Sources

Local (read, not modified):

- `/opt/homebrew/lib/node_modules/jev-browser/` v0.2.0 (gitHead `31551c3`):
  `README.md`, `NOTES.md`, `RESULTS.md`, `package.json`, `.env.example`,
  `bin/jev-browser-mcp.mjs`, `bin/jev-browser.mjs`, `src/jev.mjs`, `src/index.mjs`,
  `src/session.mjs`, `src/flow.mjs`, `examples/claude-code-mcp.json`.
- `/opt/homebrew/Cellar/omp/18.10.4/bin/omp` — embedded catalog rows for `typesafe`,
  `commandcode`, `opencode-zen`, `openrouter` judges; embedded source chunks for
  `packages/ai/src/judgment/{systemone,native}.ts`,
  `packages/ai/src/providers/systemone-server.ts`,
  `packages/catalog/src/discovery/typesafe.ts`, `packages/coding-agent/src/config/model-registry.ts`,
  the judge fallback chain, and the `TYPESAFE_*` env table.
- `/Users/nicolas/.omp/agent/mcp.json` (`jev-browser` server definition).
- `/Users/nicolas/.omp/agent/config.yml` (`modelRoles.judge: openrouter/typesafe/jev-1.13`).
- Harness docs (`omp://…`): `mcp-config.md`, `models.md`, `settings.md`, `providers.md`,
  `environment-variables.md`, `extensions.md`, `custom-tools.md`, `hooks.md`, `marketplace.md`,
  `skills.md`, `sdk.md`, `cli-reference.md`, `magic-keywords.md`, `local-models.md`,
  `rulebook-matching-pipeline.md`, `ttsr-injection-lifecycle.md`, `auth-broker-gateway.md`,
  `provider-quirks.md`, `provider-endpoint-constraints.md`, `tools/browser.md`, `tools/eval.md`,
  `tools/find.md`, `extension-loading.md`, `plugin-manager-installer-plumbing.md`.
- Eval device docs (`xd://eval…`): `eval`, `eval/judge`, `eval/agents`, `eval/browser`,
  `eval/helpers`; and `xd://mcp__jev_browser_browser_do`.
- Repo files (read only): `crates/app/src/judgments.rs`, `crates/app/src/llm.rs`,
  `crates/app/src/lib.rs`, `crates/app/Cargo.toml`, `Cargo.toml`,
  `crates/app/tests/meeting_debrief.rs`, `crates/app/tests/judgments.rs`.
- Executed on this machine: `omp models --kind judge --json`; `omp config list --json`;
  a live `judge_batch` Eval cell (`model: openrouter/typesafe/jev-1.13-20260917`, cost $2.34e-05).

Registries / packages fetched:

- npm: `jev-browser@0.2.0`, `typesafe-mcp@0.3.0`, `omp-typesafe@0.2.0` (unpacked),
  `pi-typesafe@0.9.1`, `@bismawy/pi-jev-eye@0.1.17`, `omo-jev-plugin@0.0.11`,
  `@typesafe-ai/sdk@0.6.0` (unpacked `dist/index.d.mts`, `dist/index.mjs`),
  `@ai-sdk/typesafe-ai@3.0.18`, `@effect/ai-typesafe@4.0.4`, `@langchain/typesafe@0.0.2`,
  `@tanstack/ai-typesafe@0.1.12`, `@typesafe-ai/n8n-nodes-typesafe-ai@0.9.0`,
  `@openrouter/sdk` (dist-tags).
- PyPI: `typesafe-sdk@0.7.4`, `typesafe-ai@0.1.0` (redirect shim), `jev@0.3.0`.
- crates.io API: `typesafe-sdk-client@0.6.2` (+siblings), `typesafe-ai-sdk@0.5.0`,
  `typesafe-systemone@0.2.0`, `typesafe-system-one@0.1.1`, `typesafe-client@0.1.0`,
  `systemone@0.1.0`, `jev@0.1.2`, `fuzzy-jev@0.6.0`, `polyc-judgment-systemone@2026.10.3`;
  searches `q=typesafe|jev|systemone`.
- GitHub raw: `github.com/douglance/typesafe-sdk-rs` README,
  `github.com/typesafe-ai/skills` SKILL.md.

Vendor docs / sites:

- `https://docs.typesafe.ai/sdk.md`, `/sdk/javascript.md`, `/sdk/python.md`, `/api.md`,
  `/models.md`, `/agent-skill.md`, `/llms.txt`, `/introduction/{coding-agents,quickstart}.md`.
- `https://api.typesafe.ai/openapi.json` (OpenAPI 3.1, `info.version "0.2.0"`), `https://api.typesafe.ai/docs`.
- `https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md`,
  `…/alphadecisions/submit-a-decisions-request.md`,
  `…/guides/community/{typesafe-sdk,jev,jev-tutorial,multimodal-decisions}.md`,
  `…/guides/routing/routers/jev-router.md`, `…/openapi/openapi.yaml`, `https://openrouter.ai/openapi.json`,
  `…/api/v1/models?output_modalities=decisions`, `…/api/v1/models/typesafe/jev-1.13/endpoints`,
  `…/api/v1/models/typesafe/jev-1.13-20260917/endpoints`, `https://openrouter.ai/typesafe`,
  `https://openrouter.ai/typesafe/jev-1.13`.
- `https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe` (second drop-in gateway:
  `https://ai-gateway.vercel.sh/typesafe`, `POST /typesafe/v1/systemone`).

## Un-grounded claims

- No claim in this report rests solely on a secondary source. The community npm/crates packages
  are first-party *to their own authors*; their existence/versions are grounded in registry
  metadata, their internal behavior in their own published READMEs and (for `jev-browser` and
  `omp-typesafe`) their shipped source.
- **[DOCUMENTED, NOT EXECUTED]** and therefore not observed directly: the live `typesafe-mcp`
  tool calls, the `omp auth-gateway serve` `/v1/systemone` round trip, the Vercel AI Gateway
  TypeSafe route, and `@openrouter/sdk`'s `systemOne.create`. All are documented in the sources
  cited above but were read, not run.
