# Debrief eval CLI — research findings

_Researched 2026-09-03 against the repo sources listed in §5. No code was changed. Companion tone/format reference: [modal-provider.md](modal-provider.md). Revised 2026-09-03 after review: §1 now quotes the user verbatim; the model format is OpenRouter `author/model` slugs (no app-provider prefix); prior-art ideas from promptfoo captured in §3.7. Implemented 2026-09-03 with amendments: concurrency default 20 (user decision, raised twice); the OpenRouter seam now streams (`§2.3`'s "no retry" no longer describes it) with a 30-second token idle ceiling — which is also the time-to-first-token limit — under a 120-second absolute ceiling (user decision, down from 300), and the CLI retries a failed run within a 60-second cumulative budget (max 10 attempts) before printing the model-boundary diagnostic._

## 1. Question

can we create a cli to run the evals, it should always run each transcript, it should always run each run with parallel llm calls, and the option should be the openrouter model(s) to use, "provider/model" format. cli should show progress and the directory the results went to.

## 2. Findings — how the eval pipeline actually works today

### 2.1 Current runner: one model per invocation, strictly sequential

`scripts/run-debrief-eval.mts` is a positional-argv script: `OUT = process.argv[3] ?? "/tmp/debrief-runs"` (`scripts/run-debrief-eval.mts:7`), `files = process.argv.slice(4)` (`scripts/run-debrief-eval.mts:8`), usage `tsx scripts/run-debrief-eval.mts <model> <outdir> <files...>` (`scripts/run-debrief-eval.mts:10`), `model = process.argv[2]` (`scripts/run-debrief-eval.mts:13`), and it exits non-zero when `OPENROUTER_API_KEY` is missing (`scripts/run-debrief-eval.mts:14-18`).

The provider is hardcoded, not parsed from the model string: `makeCompleteJson({ provider: "openrouter", model, apiKey }, "")` (`scripts/run-debrief-eval.mts:20`). So today there is exactly one model per invocation. The `"provider/model"` format the question asks for **is** OpenRouter's native `author/model` slug — `upstage/solar-pro4` in the `eval:debrief` script is already passed straight through as the OpenRouter model id (`package.json:31`). The app-level provider vocabulary (`PROVIDERS`, §2.3) is a different, app-internal axis and must not be layered onto the CLI input.

The run loop is a sequential `for...of` with an `await`ed LLM call per file (`scripts/run-debrief-eval.mts:22`), one output file per input at `` `${OUT}/${name}.debrief.json` `` carrying `{ model, ms, valid, raw }` (`scripts/run-debrief-eval.mts:51-52`), where `valid` is the `MeetingDebriefExtractionSchema.safeParse(raw)` verdict (`scripts/run-debrief-eval.mts:50`). Per-file console output is a `=== ${name} ===` header (`scripts/run-debrief-eval.mts:24`), a `system prompt chars / user chars` line (`scripts/run-debrief-eval.mts:39-41`), then one of `OK ${ms}ms summary=… decisions=… actions=… questions=… recipients=…` plus per-action lines (`scripts/run-debrief-eval.mts:60-64`), `INVALID after …` with the first 5 zod issues (`scripts/run-debrief-eval.mts:53-57`), or `ERROR after …` with a 2000-char-truncated message (`scripts/run-debrief-eval.mts:66-68`, `scripts/run-debrief-eval.mts:70-73`). There is no skip-if-exists check — every listed file is always re-run — but there is also no glob default: with zero files it prints usage and exits 1 (`scripts/run-debrief-eval.mts:9-12`). A failed file logs `ERROR` and the loop continues to the next file (the `try/catch` is inside the loop, `scripts/run-debrief-eval.mts:43-68`).

The prompt is built per file via `buildDebriefMessages(record, { mentions: [], decisions: [], organizations: [] })` (`scripts/run-debrief-eval.mts:38`), i.e. with empty identity context, and the meeting date is crudely derived from the filename (`scripts/run-debrief-eval.mts:27`), defaulting to `null` (`scripts/run-debrief-eval.mts:30`).

### 2.2 Scorer input expectations: flat `<runDir>/<transcript>.debrief.json`, paired via golden `transcript` field

The scorer's two forms are documented in its header: `tsx scripts/score-debrief-eval.mts <golden.json> <run.debrief.json> [...]` and `tsx scripts/score-debrief-eval.mts --all [<runDir>]` (`scripts/score-debrief-eval.mts:5-6`). `--all` scores "every golden in tests/fixtures/debrief-golden/ against `<runDir>/<transcript>.debrief.json` (default runDir: /tmp/debrief-gate/solar)" (`scripts/score-debrief-eval.mts:8-9`), and "spends no API budget; produce runs with scripts/run-debrief-eval.mts" (`scripts/score-debrief-eval.mts:10-11`). Either form accepts `--json` (`scripts/score-debrief-eval.mts:11-12`).

Arg parsing is `argv.includes("--json")` plus positional filtering (`scripts/score-debrief-eval.mts:506-508`); the `--all` branch reads every `*.json` in `FIXTURES_DIR` in sorted filename order (`scripts/score-debrief-eval.mts:511-515`), prints a `──── ${file}` header per golden (`scripts/score-debrief-eval.mts:529`), and ends with a `N/M goldens pass` summary plus a `FAIL <file>` list (`scripts/score-debrief-eval.mts:549-554`), exiting 1 on any failure (`scripts/score-debrief-eval.mts:555`). The single-golden form requires `<golden> <run>...` and prints usage otherwise (`scripts/score-debrief-eval.mts:558-564`), scoring each run path in a loop (`scripts/score-debrief-eval.mts:567-572`).

The pairing rule is exact: for each golden, `runPath = join(runDir, \`${golden.transcript}.debrief.json\`)` (`scripts/score-debrief-eval.mts:534`); a golden without a `transcript` field is skipped as unpairable (`scripts/score-debrief-eval.mts:530-533`), a missing run file is recorded as `no run file: ${runPath}` (`scripts/score-debrief-eval.mts:535-538`), and one unreadable golden never blocks the rest ("One unreadable golden must not cost the other nineteen their results", `scripts/score-debrief-eval.mts:519`). The run file shape the scorer reads is `{ model?, valid?, raw?: { decisions?, actionItems?, openQuestions?, suggestedRecipients? } }` (`scripts/score-debrief-eval.mts:76-85`), with the model name surfaced on the report (`scripts/score-debrief-eval.mts:93`). Consequence: the scorer scans **one flat directory, one model per directory**. There is no per-model subdirectory logic and no multi-model fan-in — a second model's runs in the same directory would overwrite the first model's `<transcript>.debrief.json` files.

### 2.3 OpenRouter call path: per-request closure, safe to parallelize, with one shared promise cache

The whole app's LLM traffic flows through `makeCompleteJson(cfg, mockResultPath)` which returns a `CompleteJson` closure typed `(request: CompletionRequest) => Promise<unknown>` (`apps/server/src/llm/providers.ts:44`, `apps/server/src/llm/providers.ts:739-762`). Config is `{ provider: ProviderId; model: string; apiKey: string; baseUrl?: string }` (`apps/server/src/llm/providers.ts:24-30`), and the request schema belongs to the calling module per the inline comment (`apps/server/src/llm/providers.ts:741-742`). The OpenRouter arm posts to `https://openrouter.ai/api/v1/chat/completions` with `Bearer` auth (`apps/server/src/llm/providers.ts:641-656`).

Parallel-safety evidence, all in `apps/server/src/llm/providers.ts`:

- Each call builds its own closure state: `makeCompleteJson` is documented "Cheap to rebuild per attempt" (`apps/server/src/llm/providers.ts:738`), the wire schema is derived per request (`apps/server/src/llm/providers.ts:743`), and each attempt gets a fresh `AbortController` + timeout inside `withinRequestCeiling` (`apps/server/src/llm/providers.ts:704-736`). No completions share response buffers.
- The only shared mutable state is the capability-declaration cache: `openrouterDeclarations = new Map<string, Promise<Set<string> | null>>()` (`apps/server/src/llm/providers.ts:572`), keyed by model, with "The promise is cached rather than its result so that concurrent Stages share one lookup" (`apps/server/src/llm/providers.ts:568-571`), populated once per model via `openrouterDeclarations.set(cfg.model, pending)` (`apps/server/src/llm/providers.ts:582-586`). Concurrent calls for the same model share one in-flight `GET .../models/${cfg.model}/endpoints` lookup (`apps/server/src/llm/providers.ts:589-603`); a failed lookup resolves to `null` ("which is not the same as declaring no support", `apps/server/src/llm/providers.ts:575-576`) and the call steps down bindings instead of failing.
- Binding selection is per call, not global: a declared binding is sent as final; an unknown one starts at `response_format` and steps down `response_format → forced_tool_call → prompt_only` one step per 4xx refusal (`apps/server/src/llm/providers.ts:521-553`, `apps/server/src/llm/providers.ts:555-565`).
- Failure handling is per request: `postJson` classifies aborts as `request_timeout` and other fetch throws as `transport_failure` (`apps/server/src/llm/providers.ts:132-158`, `apps/server/src/llm/providers.ts:160-166`). There is **no retry loop and no rate-limit (429) handling** anywhere on this path — a 429 surfaces as a classified model-boundary failure, not a backoff. The per-call ceiling is `REQUEST_TIMEOUT_MS` (`apps/server/src/llm/providers.ts:46-47`), sourced from `MODEL_REQUEST_TIMEOUT_MS = 300_000` (`packages/shared/src/llm.ts:4`), i.e. 5 minutes per call.
- The provider vocabulary is `["openai", "anthropic", "openrouter", "gemini", "ollama", "mock"]` (`packages/shared/src/schemas.ts:14-15`); the runner hardcodes `"openrouter"`, and the CLI keeps that hardcoding — model inputs are OpenRouter slugs and are never split or validated against this app-internal list.

Net: parallel `complete()` calls are safe (stateless per call + concurrency-designed cache), but unbounded parallelism has no backstop in the seam — the CLI must impose its own ceiling.

### 2.4 Golden fixture layout

Shared constants: `FIXTURES_DIR = "tests/fixtures/debrief-golden"` and `TRANSCRIPT_DIR = \`${FIXTURES_DIR}/transcripts\`` (`scripts/golden.mts:7-8`). Goldens are flat `*.json` files directly under `tests/fixtures/debrief-golden/` (scorer reads `readdirSync(FIXTURES_DIR)` filtered to `.json`, `scripts/score-debrief-eval.mts:513-515`); inputs are transcripts under the `transcripts/` subdirectory. Each golden names its transcript via a `transcript` field (the scorer skips goldens lacking it, `scripts/score-debrief-eval.mts:530-533`), and the golden schema carries `meetingDate`, three expectation buckets (`decisions`, `actionItems`, `openQuestions`), `mustNotAppear` guards, and per-bucket floors (`scripts/golden.mts:34-51`).

### 2.5 Wiring: package.json scripts and the verification gate

- `eval:lint`: `tsx scripts/lint-golden.mts` (`package.json:29`) — lints hand-written goldens, defaulting to every golden (`scripts/lint-golden.mts:5`).
- `eval:score`: `tsx scripts/score-debrief-eval.mts --all` (`package.json:30`) — re-scores the default run dir, no API spend.
- `eval:debrief`: `tsx scripts/run-debrief-eval.mts upstage/solar-pro4 /tmp/debrief-gate/solar tests/fixtures/debrief-golden/transcripts/*.md && pnpm run eval:score` (`package.json:31`) — one hardcoded model, one flat outdir, shell-globbed transcript list, then score.
- `.mts` scripts run under `tsx` (`package.json:29-31`) and are type-checked via `scripts/tsconfig.json` (`scripts/tsconfig.json:1-13`, includes `run-debrief-eval.mts` and `score-debrief-eval.mts`).
- The eval is a named prompt gate: "`npm run eval:debrief` | Solar-pro4 debrief extractions on all 20 real fixture transcripts score clean against hand-written goldens" (`docs/agents/verification.md:16`). `upstage/solar-pro4` is the gate model; cheaper models "run as data points only, never as the gate" (`docs/agents/verification.md:26-28`). The gate needs `OPENROUTER_API_KEY` and "is not part of `check`" (`docs/agents/verification.md:29-30`); `pnpm run eval:score` re-scores recorded runs for free and `pnpm run eval:lint` checks goldens after editing one (`docs/agents/verification.md:36-38`).

### 2.6 CLI conventions in the repo (positional vs flags)

There is no shared arg-parsing helper; each script hand-rolls:

- `run-debrief-eval.mts`: pure positional (`<model> <outdir> <files...>`, `scripts/run-debrief-eval.mts:7-13`).
- `score-debrief-eval.mts`: mixed — `--all [<runDir>]` / `--json` flags plus positionals (`scripts/score-debrief-eval.mts:506-508`, `scripts/score-debrief-eval.mts:558-564`).
- `orchestrator-loop-gate.mjs`: full long-flag style with `--opt value` and `--opt=value` forms, `--help`, and a `helpText()` usage block (`scripts/orchestrator-loop-gate.mjs:19-44`).
- `run-search-canaries.mjs` / `run-canaries.mjs`: minimal (one optional positional / no args) with `[canary]`/`[search-canary]`-prefixed status lines (`scripts/run-search-canaries.mjs:47-49`, `scripts/run-canaries.mjs:38-53`).

Precedent therefore favors: keep the existing positional script untouched, and write the new fan-out CLI flag-style in the `orchestrator-loop-gate.mjs` shape (`--models`, `--outdir`, `--help`), reusing the runner's `=== name ===` / `OK …` / `INVALID …` / `ERROR …` per-run line style.

### 2.7 Prompt builder signature (what each parallel task calls)

`buildDebriefMessages(record: TranscriptRecord, identity: DebriefIdentityReview): DebriefMessages` (`apps/server/src/modules/meeting-debrief/extraction.ts:118-121`) returns `{ system, user, schema }` (`apps/server/src/modules/meeting-debrief/extraction.ts:161-165`) where the triple is typed as `DebriefMessages { system: string; user: string; schema: typeof MeetingDebriefExtractionSchema }` (`apps/server/src/modules/meeting-debrief/extraction.ts:168-173`). It is a pure function of its two arguments (trusted-context lines + transcript text), so concurrent invocations with distinct records need no synchronization.

## 3. Answer — yes, feasible; concrete design

**Yes.** Nothing in the pipeline forbids it: the runner is already a thin per-file loop over a stateless `complete()` closure, the OpenRouter seam is concurrency-safe by design (shared promise cache, per-call deadlines), and the scorer's contract is a simple flat directory. The work is a **new CLI file only** — no scorer change — provided the output layout keeps the scorer's one-model-per-directory invariant (one subdirectory per model; details below).

### 3.1 CLI surface

New file: `scripts/run-debrief-eval-all.mts` (keeps `run-debrief-eval.mts` as the single-model primitive; listed in `scripts/tsconfig.json` alongside it).

Suggested invocation, following the `orchestrator-loop-gate.mjs` long-flag convention (`scripts/orchestrator-loop-gate.mjs:19-44`):

```sh
tsx scripts/run-debrief-eval-all.mts \
  --models upstage/solar-pro4,openai/gpt-oss-20b,mistralai/mistral-nemo \
  --outdir /tmp/debrief-gate \
  [--glob 'tests/fixtures/debrief-golden/transcripts/*.md'] \
  [--concurrency 20] [--score] [--help]
```

- `--models`: comma-separated OpenRouter `author/model` slugs — this **is** the question's `provider/model` format, consumed verbatim by the current runner (`scripts/run-debrief-eval.mts:20`, `package.json:31`). No prefix-splitting and no `PROVIDERS` validation: the provider stays hardcoded `"openrouter"`. Each slug fans out to **one run per (transcript × model)**. Default: `upstage/solar-pro4` (the gate model, `docs/agents/verification.md:26-28`).
- `--outdir`: run root. The CLI creates `<outdir>/<model-slug>/` per model (slug = model id with `/` → `-`, e.g. `upstage-solar-pro4`), each a scorer-compatible flat run dir.
- Transcript selection: default glob `tests/fixtures/debrief-golden/transcripts/*.md` (the `TRANSCRIPT_DIR` constant, `scripts/golden.mts:8`, as expanded by the `eval:debrief` script, `package.json:31`). **No skip-if-exists**: always re-run every transcript (matches the current runner, which unconditionally overwrites `scripts/run-debrief-eval.mts:51-52`). An explicit `--files ...` override may replace the glob, but the default path must never filter.
- `--concurrency N`: cap on in-flight LLM calls, default **20** (user decision; see §4.1). `--score`: after all runs complete, invoke the scorer per model dir (§3.3) instead of only printing the commands. `--help` prints usage in the `helpText()` style (`scripts/orchestrator-loop-gate.mjs:42-44`).

`OPENROUTER_API_KEY` is required unconditionally (same check as `scripts/run-debrief-eval.mts:14-18`): every accepted slug routes through OpenRouter, whose provider stays hardcoded as today (`scripts/run-debrief-eval.mts:20`).

### 3.2 Parallelism

- **What runs concurrently:** the cartesian product (transcript × model). Each task builds its own `TranscriptRecord` + `buildDebriefMessages` triple and calls its own `makeCompleteJson({ provider, model, apiKey }, "")` closure — one closure per model, shared across that model's transcript tasks (closure construction is cheap, `apps/server/src/llm/providers.ts:738`).
- **Primitive:** a bounded pool — an `async.forEachOfLimit`-style worker loop (counter + `Promise.all`; ~15 lines inline, no new dependency; the same shape promptfoo's evaluator uses, §3.7), **not** bare `Promise.all` over all tasks. Default cap 20. Reason: the seam has no retry/backoff/rate-limit handling (`§2.3`), and each call can run up to the 5-minute ceiling (`packages/shared/src/llm.ts:4`), so unbounded fan-out risks mass 429s and a hung tail.
- **What MUST NOT be parallelized:** (a) file writes to the same path — but the layout below gives each task a unique path, so this falls out naturally; (b) the declaration lookup needs no protection — the promise cache already dedupes concurrent lookups per model (`apps/server/src/llm/providers.ts:568-571`); (c) keep console output serialized per task-completion line (collect each task's `OK`/`INVALID`/`ERROR` line and `console.log` it atomically on completion, preserving the existing line formats from `scripts/run-debrief-eval.mts:53-68`).

### 3.3 Output layout (keeps `eval:score` working unchanged)

Per model, write the exact layout the scorer already scans:

```
<outdir>/<model-slug>/<transcript-filename>.debrief.json   # { model, ms, valid, raw }
```

i.e. the same `` `${OUT}/${name}.debrief.json` `` files (`scripts/run-debrief-eval.mts:51`) with the same `{ model, ms, valid, raw }` payload (`scripts/run-debrief-eval.mts:52`), only namespaced one directory deeper per model. Then:

```sh
tsx scripts/score-debrief-eval.mts --all <outdir>/<model-slug>   # per model, unchanged scorer
```

No scorer change is needed: `--all [<runDir>]` already accepts any run dir (`scripts/score-debrief-eval.mts:511-512`), and the pairing rule (`scripts/score-debrief-eval.mts:534`) works against each per-model dir independently. The CLI should **not** write multiple models into one flat dir (filenames would collide and overwrite). Scoring chain, made explicit: by default the closing summary prints the exact per-model command `tsx scripts/score-debrief-eval.mts --all <outdir>/<model-slug>` (§3.4); with `--score` the CLI also runs it per model dir (`node:child_process` `spawnSync`, stdio inherited), feeding each results directory straight into the scorer's `<runDir>` argument (`scripts/score-debrief-eval.mts:511-512`). Both paths keep the `run && score` two-stage shape of `eval:debrief` (`package.json:31`).

### 3.4 Progress

Match the existing per-file line style (`scripts/run-debrief-eval.mts:24`, `scripts/run-debrief-eval.mts:39-41`, `scripts/run-debrief-eval.mts:53-68`), prefixed with the model slug so parallel output stays attributable:

```
[upstage-solar-pro4 3/20] === <transcript> ===
[upstage-solar-pro4 3/20] OK 12345ms summary=…ch decisions=… actions=… questions=… recipients=…
```

Plus a start line (`N transcripts × M models = K runs, concurrency=C`), and a closing summary reporting the results directories:

```
done: K/K runs in <outdir>/<model-slug>/ (×M) — score with:
  tsx scripts/score-debrief-eval.mts --all <outdir>/<model-slug>
```

Optional polish, not required: promptfoo renders a `cli-progress` bar (`gracefulExit`, hidden under debug logging) and gates rendering behind a web-UI check (§3.7). The zero-dependency line format above already satisfies "cli should show progress".

Exit non-zero if any task errored or produced schema-invalid output (mirroring that `INVALID`/`ERROR` are already terminal-visible in the current runner), and list the failed (transcript × model) pairs.

### 3.5 Always-run-each-transcript semantics

Default glob `tests/fixtures/debrief-golden/transcripts/*.md`; expand, sort, run all, overwrite unconditionally. No `--all` discovery shortcut via goldens is needed (the scorer owns golden pairing; the runner owns transcripts), and no timestamp/mtime check may skip a file. This preserves the current overwrite behavior (`scripts/run-debrief-eval.mts:51-52`) and the gate's "all 20 real fixture transcripts" expectation (`docs/agents/verification.md:16`).

### 3.6 Files that would change

- **New:** `scripts/run-debrief-eval-all.mts` (+ one entry in `scripts/tsconfig.json`'s `include`, `scripts/tsconfig.json:12`).
- **Unchanged:** `scripts/score-debrief-eval.mts`, `scripts/run-debrief-eval.mts`, `scripts/golden.mts`, `apps/server/src/llm/providers.ts`, `package.json` (a later `eval:debrief:all` script entry is optional and out of scope for the research question).

### 3.7 Prior art (promptfoo, via context-awesome → gh-grep)

[context-awesome](https://github.com/promptslab/awesome-prompt-engineering) surfaces `promptfoo/promptfoo` (MIT; multi-list-endorsed LLM-eval CLI). Its source, searched directly with gh-grep, confirms the design choices above:

- **Bounded pool:** the evaluator drives concurrent API calls with `async.forEachOfLimit(concurrentRunEvalOptions, processingContext.concurrency, …)` (`src/evaluator.ts` in promptfoo/promptfoo); every strategy worker uses the same primitive (e.g. `src/redteam/strategies/likert.ts`).
- **Flag convention:** `-j, --max-concurrency <number>` — "Maximum number of concurrent API calls" (promptfoo.dev/docs/usage/command-line). This CLI's `--concurrency N` keeps the repo's long-flag style (`orchestrator-loop-gate.mjs:19-44`); renaming to `--max-concurrency` would match promptfoo if preferred.
- **Default 5 vs this repo's 20:** promptfoo's bounded stream processor defaults to `concurrency = 5` (`src/commands/mcp/lib/performance.ts`); this CLI's default was raised to 20 by user decision after the first live runs.
- **Progress:** `cli-progress` SingleBar with `shades_classic`, started with the total, hidden under debug logging (`src/testCase/synthesis.ts`); the bar is default-on with `--no-progress-bar` to disable (CLI docs). The main evaluator gates rendering behind a web-UI check and tracks `totalCount/completedCount/concurrency` (`src/evaluator.ts`).
- **Deeper machinery exists but is out of scope:** AIMD-style adaptive concurrency on rate-limit feedback (`src/scheduler/adaptiveConcurrency.ts`) and a fetch connection-pool default of 4 with env override (`src/util/fetch/index.ts`). Worth revisiting only if 429s appear in practice (§4.1).
- **Parallelize only stateless work:** promptfoo documents that shared counters break under concurrency > 1 (`examples/config-extension-api/hooks.py`) — the same rule as §3.2's "what must NOT be parallelized".
- **Exit codes:** `eval` returns `100` when at least one test case fails (or the pass rate is below `PROMPTFOO_PASS_RATE_THRESHOLD`) and `1` for any other error (CLI docs). This CLI keeps a single non-zero exit to match the scorer's `process.exit(failed.length === 0 ? 0 : 1)` (`scripts/score-debrief-eval.mts:555`); a distinct "runs completed but scored failing" code is a deliberate non-goal.

## 4. Gaps / open decisions

1. **Concurrent-request ceiling.** The sources determine no safe number: no rate-limit, retry, or concurrency evidence exists in the provider seam (§2.3), and OpenRouter-side limits are undocumented in-repo. The default is fixed at **20** (user decision, raised from 5 → 10 → 20 across live runs); watch for 429s and back off via `--concurrency` if they appear. promptfoo's AIMD adaptive-concurrency scheduler (§3.7) is the prior art to borrow from if they do.
2. **Whether the scorer should learn multi-model dirs.** The design above says no (one dir per model, scorer unchanged). If a single-table multi-model comparison is later wanted, that is a scorer feature (`--all` over multiple `--runDir`s, or a new `--compare`), not needed for this CLI.
3. **Beyond-OpenRouter routing.** Because inputs are OpenRouter slugs, other authors (`openai/gpt-4o-mini`, `anthropic/claude-…`) already work through the same `OPENROUTER_API_KEY` — no extra key handling. True direct-API providers (bypassing OpenRouter) would need per-provider keys the eval scripts don't have today; the hardcoded `"openrouter"` provider (`scripts/run-debrief-eval.mts:20`) keeps that door closed until needed.
4. **Transcript set vs golden set drift.** The runner globs transcripts; the scorer iterates goldens (`scripts/score-debrief-eval.mts:513-515`). A transcript with no golden scores nothing, and a golden whose transcript is missing from the glob yields `no run file` (`scripts/score-debrief-eval.mts:535-538`). The CLI could warn on the difference, but the sources don't require it.
5. **Gate-model vs data-point reporting.** Verification policy distinguishes the gate model from data-point models (`docs/agents/verification.md:26-28`). The CLI is neutral infrastructure — policy about which model's score gates a commit stays in `docs/agents/verification.md`, not in CLI flags.

## 5. Sources

- `scripts/run-debrief-eval.mts` — runner argv, sequential loop, output file shape, console style
- `scripts/score-debrief-eval.mts` — scorer usage, `--all` pairing rule, `RunFile` shape, exit codes
- `scripts/golden.mts` — `FIXTURES_DIR`, `TRANSCRIPT_DIR`, golden schema
- `scripts/lint-golden.mts` — golden linter usage
- `scripts/tsconfig.json` — how `.mts` eval scripts are type-checked/run
- `scripts/orchestrator-loop-gate.mjs` — long-flag CLI convention + `helpText()` pattern
- `scripts/run-search-canaries.mjs`, `scripts/run-canaries.mjs` — minimal-script conventions, prefixed status lines
- `apps/server/src/llm/providers.ts` — `LlmConfig`, `makeCompleteJson`, OpenRouter path, declaration cache, step-down, timeouts, no-retry evidence
- `packages/shared/src/llm.ts` — `MODEL_REQUEST_TIMEOUT_MS`
- `packages/shared/src/schemas.ts` — `PROVIDERS` / `ProviderId`
- `apps/server/src/modules/meeting-debrief/extraction.ts` — `buildDebriefMessages` signature, pure-function evidence
- `package.json` — `eval:debrief`, `eval:score`, `eval:lint` wiring
- `docs/agents/verification.md` — prompt eval gate, gate-model policy, API-budget notes
- `promptfoo/promptfoo` (MIT, github.com/promptfoo/promptfoo) — bounded-pool evaluator (`src/evaluator.ts` `async.forEachOfLimit`), `-j/--max-concurrency` CLI flag, `cli-progress` progress bars, AIMD adaptive concurrency (`src/scheduler/`), `streamProcess` default concurrency 5 (`src/commands/mcp/lib/performance.ts`); discovered via context-awesome (`promptslab/awesome-prompt-engineering`), searched with gh-grep.
- promptfoo.dev/docs/usage/command-line/ — `-j, --max-concurrency <number>`: "Maximum number of concurrent API calls"; progress bar default-on (`--no-progress-bar` disables); `eval` exits `100` on test-case failure vs `1` on other errors.
