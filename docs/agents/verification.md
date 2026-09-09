# Verification gates

Run the narrowest gate that covers the change while working, then the whole-tree gate before
pushing. Production-bundle changes also have to prove the container, because Docker is the only
supported way to run the app.

## Gate topology

| Granularity | Gate | What it proves |
| --- | --- | --- |
| Prose only | nothing | Nothing: `*.md` is prettier-ignored (ADR-0026) and no gate reads it |
| One test file | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/<path>.test.ts` | The behavior at the seam currently being changed |
| TypeScript tree | `pnpm run typecheck` | Shared/server/relay builds plus web, tests, and scripts no-emit passes |
| Staged files | `.git/hooks/pre-commit` via `lint-staged` | Prettier on staged source/config/docs and Oxlint on staged TypeScript and JavaScript |
| Whole tree | `pnpm run check` | Typecheck, lint, formatting, knip, and all unit tests |
| Unit coverage | `pnpm run test:coverage` | Server unit tests with the same coverage floors used by CI |
| App behavior | `pnpm run check:all` | The whole-tree gate plus the Playwright suite |
| Prompt eval | `pnpm exec tsx scripts/run-debrief-eval-all.mts --models upstage/solar-pro4 --score` | Solar-pro4 debrief extractions on all 20 real fixture transcripts score clean against hand-written goldens |
| Production image | `docker compose build`, boot, then `GET /api/health` | The pruned runtime image contains a working server and web bundle |
| Clean checkout | GitHub Actions on pull requests and pushes to `main` | Clean installs, the gates above, coverage, and the production image boot |

### A prose-only change has no gate

A change touching only hand-wrapped Markdown — `CONTEXT.md`, an ADR, anything under `docs/` —
has nothing for the whole-tree gate to prove: `format:check` runs Prettier over a tree that ignores
`*.md`, and no test, typecheck or knip pass reads it. Running `pnpm run check` on one shows that
`main` was already green, which was not in question. Read the rendered diff instead, and confirm
the hand-wrapping survived: the pre-commit hook passes staged `*.md` to Prettier, which skips them
per `.prettierignore`, so a reflow is a sign the ignore stopped matching.

### The `--` trap

`pnpm --filter <pkg> test -- <arg>` hands `<arg>` to `vitest run` after a `--`, where vitest reads
it as a filename filter rather than a flag. A path works. A flag is swallowed in silence:
`pnpm --filter @chief-of-staff-demo/tests test -- --coverage` produced no report and still exited
0, which is how the coverage floors sat unenforced in CI until 2026-09-05. Reach for
`exec vitest run` whenever a real flag is involved.

### Tests need the shared package built

`test` and `test:coverage` build `@chief-of-staff-demo/shared` first, and that is not a
convenience. `packages/shared` resolves through its `dist`, and the benchmark CLI tests spawn the
real script as a subprocess, so an unbuilt `dist` fails them with `ERR_MODULE_NOT_FOUND` rather
than with anything about the behaviour under test. It passed locally only because an earlier
typecheck had left a `dist` behind; on a clean checkout CI failed 17 tests this way, and `check`
was racing its own typecheck for the same file. Verified both directions: 17 failures with `dist`
removed and no build step, 2,136 passing with it.

The unit coverage gate measures `apps/server/src`, excluding the process bootstrap and the
test-only e2e seed seam. CI reports the result in its job summary and enforces the lines,
statements, functions, and branches floors in `tests/vitest.config.ts`. A run that produces no
coverage report fails the job rather than passing quietly.

### Console output from a probe test

The default reporter swallows `console.log` from a **passing** test, so a throwaway test written to
print what the current code actually does prints nothing and reads as a clean run.
`--reporter=verbose` or `--disableConsoleIntercept` surfaces it:

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run \
  tests/src/<probe>.test.ts --reporter=verbose
```

`--reporter=basic` is not the flag. Vitest reads the name as a custom reporter module and fails
with `Failed to load custom Reporter from basic` before a single test runs.

## Lint and audit evidence

Full-tree lint uses Oxlint and its TypeScript 7 type-aware engine. The gate runs without a
result cache: an imported type can change a caller's lint result without changing that caller's
bytes. `.oxlintrc.json` retains the typed rules, React rules, and ADR import boundaries. The
Google-auth syntax restriction uses `oxlint-plugin-eslint` because Oxlint has no native equivalent.

`pnpm run lint:verify` probes both accepted code and deliberate policy violations in an isolated
temporary tree. It proves the Google auth boundary, web/server imports, React rules, dropped
promises, unnecessary conditions, and scoped suppressions. It runs within the full lint gate.

The pre-commit hook covers staged TS/TSX/MTS/CTS and JS/MJS/CJS. Its narrow check does not replace
full-tree lint before pushing. Markdown and YAML remain hand-formatted per the existing policy.

When changing gate configuration, verify both a clean pass and an intentional failure at the
changed seam. The [2026-09-05 audit](../research/verification-check-audit-2026-09-05.md) records
runtime measurements, fault probes, and the scope of each gate.

## Prompt eval gate

Goldens live in `tests/fixtures/debrief-golden/` (expectations plus the input
transcripts). `upstage/solar-pro4` is the gate model; cheaper models (e.g.
`inception/mercury-2.5-preview`) run as data points only, never as the gate.
The gate needs `OPENROUTER_API_KEY` and spends real API budget, so it is not
part of `check` — run it before commits that touch the debrief prompt and any
time eval outputs are refreshed. Goldens are hand-written from the transcripts,
never copied from model output; keyword matching is by intent (`any` groups in
each golden). A golden that the gate model honestly cannot meet means the prompt
needs work, not the golden — fix the prompt and re-run.

`pnpm run eval:score` re-scores the legacy `/tmp/debrief-gate/solar` dir and spends nothing; `pnpm run eval:lint` checks
the goldens themselves and is what to run after editing one. The format and the authoring method
are `tests/fixtures/debrief-golden/GOLDEN_FORMAT.md`.

### Running the eval

`scripts/run-debrief-eval-all.mts` fans the extraction out over models — every
transcript, every run, overwriting previous results
(`docs/research/debrief-eval-cli.md` holds the design rationale):

```sh
pnpm exec tsx scripts/run-debrief-eval-all.mts \
  --models upstage/solar-pro4,openai/gpt-oss-20b,mistralai/mistral-nemo --score
```

The run is done when it prints `done: N/N runs`, each model's score block has
run, and no `failed:` list follows. Results land in
`/tmp/debrief-gate/<author-slug>/`; `--score` chains the per-model scoring, so
a separate score pass is only needed when you skip it.
Every run lands exactly one file in the model dir: `<transcript>.debrief.json`
when the model answered (even schema-invalid), `<transcript>.error.json` when
every attempt failed — the scorer fails that golden with the recorded error.
The outcome a run did not produce is removed, so a re-run whose calls fail can
never be scored against the debrief output of an earlier run; should both files
turn up anyway, the scorer reads the error and ignores the debrief.

- Only `upstage/solar-pro4` gates a commit; every other model in `--models`
  is a data point.
- Calls stream, under three ceilings that answer different questions. A
  connection that sends nothing at all for 30 seconds is dead and ends there.
  One that stays connected but produces no answer for 90 seconds ends at the
  silent ceiling — some upstreams buffer a whole tool call behind keepalives,
  so traffic counts as alive even when no token has arrived. A call that is
  actively generating is bounded at 300 seconds.
  A failed or timed-out run retries within a 60-second cumulative budget (max
  10 attempts) before printing the full model-boundary diagnostic. `HTTP 429`
  clusters mean back off with `--concurrency` (default 20).
- Free re-scoring of CLI output targets the per-model dir:
  `tsx scripts/score-debrief-eval.mts --all /tmp/debrief-gate/<model-slug>`.
  Bare `pnpm run eval:score` re-scores only the legacy `/tmp/debrief-gate/solar`
  dir from the old single-model runner — not CLI output.
- Flags and defaults: `--help` is authoritative.

## Pre-commit hook

The hook deliberately sees staged files only. Whole-tree typechecking, knip, unit tests, and
Playwright do not belong in it. After a fresh clone, install the configured hook explicitly:

```sh
pnpm exec simple-git-hooks
```

If the hook changes formatting, review the re-staged result and commit again. If it reports a lint
error, fix the staged file. `--no-verify` is not the escape hatch for a failing gate.

## Container check

Changes to the Dockerfile, runtime dependencies, server build, or web production bundle need this
additional check after `pnpm run check:all`:

```sh
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:4317/api/health
docker compose down
```

The response must be `{"ok":true}`. Always bring the Compose project down, including after a
failed health check.
