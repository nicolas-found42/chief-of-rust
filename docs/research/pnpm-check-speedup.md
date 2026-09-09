# pnpm migration and check-speedup — 2026-09-02

Follow-up: the [2026-09-05 verification audit](verification-check-audit-2026-09-05.md) supersedes
the lint-cache recommendation and records the current parallel browser setup.

Question: switch the workspace from npm to pnpm, and speed up `check` (typecheck,
lint, format:check, knip, test) — can any of it run multiple workers?

Method: primary sources for every tool claim (ESLint CLI reference,
typescript-eslint#11677, TypeScript#30235, Vitest config docs, Playwright
parallelism docs, pnpm settings docs), plus cold/warm benchmarks run on the
repo itself (Apple M5, 10 cores, Node 26).

---

## TL;DR

| Verdict | Item |
|---|---|
| **Adopted** | pnpm 11 workspaces (`node-linker=hoisted`), `eslint --cache`, `prettier --check --cache`, `run-p` parallel `check` |
| **Already parallel** | Vitest (`pool: "threads"` uses all 10 cores) |
| **Cannot parallelize** | `tsc` (single-threaded by design), ESLint typed linting under `--concurrency` (stateful parser breaks worker model) |
| **Deferred** | Playwright multi-worker (single shared hermetic server blocks it) |

## Benchmarks (this repo, cold / warm)

| Command | Before | Cold | Warm |
|---|---|---|---|
| `eslint .` | 19.3s | 17.5s (`--cache`) | **0.8s** |
| `prettier --check .` | 2.7s | 2.9s (`--cache`) | **0.6s** |
| `npm run check` (serial) | ~34s | — | — |
| `pnpm run check` (parallel) | — | 31.7s | **11.9s** |

The warm `check` is bounded by the slowest parallel branch (typecheck + vitest
at ~9.5s each), not by the sum. `user` time (1m40s cold) confirms both branches
saturate the 10 cores concurrently.

## Why each tool behaves the way it does

### ESLint `--concurrency` hangs with typed linting (verified on this repo)

`eslint --concurrency auto` (ESLint 10.9) hung for minutes on this repo and was
abandoned. Root cause per typescript-eslint maintainers
([typescript-eslint#11677](https://github.com/typescript-eslint/typescript-eslint/issues/11677)):
ESLint's RFC-129 worker model treats parsers as stateless functions; the
typescript-eslint parser is stateful (one shared TS Program across files), so
"each worker spins up its own full program" and the run degrades. The maintainer
post is explicit that caching and concurrency are "broken or sub-par for typed
linting" until ESLint core grows project-aware parsers. Keep typed linting
single-process; `--cache` (content-addressed, `.eslintcache`) is the real win:
19.3s → 0.8s warm.

### `tsc` will not use multiple workers

[microsoft/TypeScript#30235](https://github.com/microsoft/TypeScript/issues/30235)
("Support multi-threaded compilation for --build") has been open since 2019 and
is still `Awaiting More Feedback`: the compiler API is synchronous, worker
threads cannot share the Program without serialization, and the maintainers
consider the sharing cost likely to erase the gain. `tsc -b` + incremental
`.tsbuildinfo` (already on here) is the supported path. The `typecheck` branch
(~4.8s) hides inside the parallel `check` regardless.

### Vitest already uses every core

`pool: "threads"` (tests/vitest.config.ts) with no `maxWorkers` override
defaults to `os.availableParallelism()` in run mode
([Vitest maxWorkers docs](https://vitest.dev/config/maxworkers)). The unit suite
logs ~50s of import CPU into ~8s wall — near 7× saturation on 10 cores. The
remaining lever, `isolate: false`
([isolate docs](https://vitest.dev/config/isolate)), trades module-state leaks
for speed; not adopted, since several suites mutate module-level singletons.

### Playwright stays at one worker

`workers: 1` is structural, not conservative: every journey drives one shared
hermetic server (`tests/e2e/start-server.mjs`, port 4319, one temp Workspace)
and each other's fixtures (set-now clock, fake Gmail). Playwright's isolation
recipe is per-worker backends via `testInfo.workerIndex`
([parallelism docs](https://playwright.dev/docs/test-parallel#worker-index-and-parallel-index)),
which would mean one server and Workspace per worker. Worth doing only if e2e
runtime becomes the bottleneck (~35s today).

## pnpm migration notes

- `pnpm-workspace.yaml` lists `apps/*`, `packages/*`, `tests`, and `relay`
  (relay was an npm workspace orphan: it had its own package.json but was
  missing from npm's `"workspaces"` — pnpm made the omission visible).
- `node-linker=hoisted` (`.npmrc`): the unit specs `vi.mock("googleapis")`
  while `apps/server` imports it. Under pnpm's default isolated linker the two
  workspaces resolved two different `googleapis` instances and the mock never
  bound (tests hit live Google endpoints). Hoisted linking restores npm's
  single-copy resolution. The `tests` workspace also declares
  `googleapis`/`googleapis-common` as devDependencies (knip
  `ignoreDependencies` documents why) so the vitest process resolves the same
  module the server code does.
- `workspace:*` protocol replaces npm's `"*"` for the shared package.
- `allowBuilds` (pnpm-workspace.yaml) replaces npm's `allowScripts` gate for
  esbuild and simple-git-hooks.
- Scripts use `pnpm --filter <name>` instead of
  `npm run --workspace <name>`; `check` is
  `run-p check:static test` (npm-run-all2), which fails if either parallel
  branch fails — a bare `a & b & wait` would mask the first branch's exit.
- `.eslintcache` and `.prettiercache` are gitignored; caches are content- and
  mtime-keyed, so CI stays correct cold.

## Sources

- [ESLint CLI — `--concurrency`, `--cache`](https://eslint.org/docs/latest/use/command-line-interface)
- [typescript-eslint#11677 — typed linting optimizations blocked by ESLint core](https://github.com/typescript-eslint/typescript-eslint/issues/11677)
- [microsoft/TypeScript#30235 — multi-threaded `--build`](https://github.com/microsoft/TypeScript/issues/30235)
- [Vitest — pool](https://vitest.dev/config/pool) · [maxWorkers](https://vitest.dev/config/maxworkers) · [isolate](https://vitest.dev/config/isolate)
- [Playwright — parallelism and worker index](https://playwright.dev/docs/test-parallel)
- [pnpm — settings](https://pnpm.io/settings) (`node-linker`, `allowBuilds`), workspace protocol
