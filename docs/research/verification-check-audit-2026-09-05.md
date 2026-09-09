# Verification check audit — 2026-09-05

Scope: unit tests and coverage, TypeScript, ESLint, formatting, Knip, pre-commit,
Playwright, GitHub Actions, production-image checks, and the scheduled canary.
Baseline: `main` at `583c7d2`, following candidate 3. This is an audit of the
verification machinery and sampled failure behavior, not a claim that every
assertion in the 1,894-test suite has been independently reviewed.

## Findings and implemented fixes

| Area | Finding | Fix |
| --- | --- | --- |
| Typed lint correctness | ESLint's per-file cache can reuse a clean caller after its imported type changes. A two-file probe reproduced the false pass. | Remove `--cache` from the authoritative full-tree lint gate. Keep all typed rules and zero warnings. |
| Lint time and memory | Automatic workers duplicate TypeScript programs. Conversely, one uncached `eslint .` process exhausted its 4 GB heap twice. | Keep serial workspace processes, disable automatic concurrency, and finish with a pass over everything outside those scopes. |
| Lint scope | The last scope named only `eslint.config.js`; new root files were not checked. | The remainder pass discovers them. A new root JS file with an undefined function now fails lint. |
| Typecheck scope | The root command omitted relay and scripts projects. Injected type errors into `relay/src/server.ts` and `scripts/golden.mts` passed the old gate. | Include relay in the build pass and add a scripts no-emit pass. Discover script TS/MTS/CTS files instead of maintaining a seven-file allowlist. |
| Unused-code scope | Root Knip configuration excluded scripts; its tests project omitted TSX. | Include both, declare the intentional manual CLI entry points, and remove the now-detected unused `toRegex` export. |
| Pre-commit scope | MTS and JavaScript did not receive the staged TypeScript lint gate. The hook invoked npm's `npx` in a pnpm repository. | Format and lint staged TS/TSX/MTS/CTS/JS/MJS/CJS; format JSONC as well as JSON; invoke `pnpm exec lint-staged`. |
| Browser scheduling | Nine read-only reflow sweeps ran serially in one file, leaving other workers idle near the end. | Mark only the reflow file parallel. Each worker still owns a hermetic Workspace; each test owns its browser context. Stateful journey files retain serial ordering. |
| Focused browser tests | Playwright did not reject `test.only` in CI. Vitest already rejected focused tests in CI. | Set Playwright `forbidOnly` in CI; verify both runners reject focused tests. |
| Browser diagnostics | The workflow passed a reporter override through a package-script argument separator, and uploaded only the HTML directory. | Configure list plus HTML reporters in CI, use `exec playwright test`, and upload both the report and `test-results` traces on failure. |
| Coverage entry point | Local coverage required remembering the full Vitest command that CI used. | Add `pnpm run test:coverage` and call it from CI. Preserve the four server floors and missing-report failure check. |
| Formatting inputs | Generated coverage and workspace backups were not explicitly excluded. | Exclude them, plus local agent worktrees; keep the formatting cache. Workspace backups are also excluded from lint. |
| Relay image accuracy | The relay ran an unlocked `npm install`, separate from the graph checked by pnpm and CI. | Install from the frozen workspace lockfile, build the relay, and deploy its production package into the runtime stage. Explicitly package `dist`. |
| Canary setup and signal | The scheduled job failed looking for an npm lockfile, but job-wide `continue-on-error` made the workflow appear successful. | Run the canary inside the production app image. Unexpected setup/runtime errors now fail this separate diagnostic workflow; external-source outcomes remain non-failing receipts. The four required PR checks are unchanged. |
| Canary clean-build accuracy | The CLI imported the old `modules/content-scout/adapters/browser.js` path. A stale local compiled file concealed the move to `source-adapters/browser.js`. | Correct the import. Add a `--check` mode that composes all nine adapters without external calls, and run it against the clean production image in the image gate. |

## Measurements

Local measurements use Apple Silicon, Node 26.8.1, pnpm 11.25.0, the installed
lockfile, and existing TypeScript/Prettier incremental caches. These are elapsed
wall times, not summed CPU time. They are observations on this checkout, not
portable performance guarantees. No coverage floor, test, assertion, viewport,
or test-file isolation setting was removed to obtain the improvements.

| Local observation | Elapsed | Result |
| --- | ---: | --- |
| Initial original lint command | 63.55 s | Passed; this initial observation overlapped part of a coverage run |
| Single uncached full-tree lint, first attempt | 20.47 s | Failed: 4 GB heap exhausted |
| Single uncached full-tree lint, second attempt | 20.18 s | Failed: 4 GB heap exhausted |
| Revised uncached workspace lint, first attempt | 22.08 s | Passed |
| Revised uncached workspace lint, second attempt | 22.05 s | Passed |
| Final sequential comparison: original lint / revised lint | 41.47 / 23.07 s | Both passed, no concurrent benchmark; revised lint is about 44% faster |
| Final full `pnpm run check` | 35.89 s | Typecheck, lint, format, Knip, and all 1,894 unit tests passed |
| Original typecheck, incremental | 5.00 s | Passed, but omitted projects |
| Expanded typecheck, incremental | 3.67 s | Passed; cache state differs, so this is not evidence of a compiler speedup |
| Formatting check, before / after | 3.81 / 3.69 s | Passed |
| Knip, before / after expanded scope | 0.84 / 0.77 s | Passed; difference is too small to call a speedup |
| Original local browser suite, preceding candidate-3 verification | About 84 s | 80 tests passed, four workers |
| Revised local browser suite | 57.6 s | Same 80 tests passed, four workers; image build also running |
| Baseline server coverage run | 23.87 s | All 1,894 tests passed; overlaps initial lint, not an isolated benchmark |

For a clean-runner comparison, the immediately preceding successful
[main CI run](https://github.com/nicolas-found42/chief-of-staff-demo/actions/runs/34002690663)
provides step timings from GitHub's jobs API:

| CI step, Node 22 / Ubuntu | Baseline |
| --- | ---: |
| Typecheck | 30 s |
| Lint | 90 s |
| Format | 13 s |
| Knip | 3 s |
| Unit tests with coverage | 64 s |
| Playwright suite, two workers | 124 s |
| Docker Compose build | 137 s |
| Compose boot / health wait / teardown | 12 / 2 / 20 s |

CI uses different CPUs, Node versions, caches, and browser-worker counts from
the local machine. Compare the implementation PR's CI timings to that run;
do not subtract a local measurement from a CI measurement. The required jobs
already run in parallel, so merge latency follows the slowest job rather than
the sum of their times.

## Failure probes and validation

Temporary fault files were removed after each probe. The gate commands and
failure categories were checked directly rather than adding tests that merely
assert strings in configuration files.

- **Omitted projects:** append `const auditTypeProbe: string = 42; void auditTypeProbe;`
  to the relay bootstrap and the script helper. The old `pnpm run typecheck`
  returned 0; the expanded gate returned nonzero. An entirely new `.mts` file
  with the same error also failed the scripts pass.
- **Cross-file lint:** a provider initially returns `boolean`; an unchanged
  caller branches on its result. After changing the return type to `true`,
  cached ESLint returned 0 while fresh ESLint reported
  `@typescript-eslint/no-unnecessary-condition`. This reproduces the reason to
  avoid per-file caching for typed lint, independently of timing results.
- **Remainder coverage:** a new root `.mjs` file calling an undefined function
  was rejected by the last lint scope.
- **Focused tests:** both `CI=1 ... exec playwright test <probe> --list` and
  `CI=1 ... exec vitest run <probe>` rejected `.only`.
- **Unused files:** separate unreferenced `.mts` script and test `.tsx` files
  were each rejected by Knip after expanding its project globs.
- **Formatting:** a temporary badly formatted server file made the cached
  full-tree format check fail. Generated artifacts stayed outside its scope.
- **Failure artifacts:** an intentional browser assertion failure exited
  nonzero and produced both `tests/playwright-report/index.html` and a
  `tests/test-results/.../trace.zip`. The new workflow uploads both directories.
- **Workflow syntax:** actionlint 1.7.12 accepted both edited workflows
  (`-shellcheck=`; ShellCheck was not installed locally).
- **Production runtime:** both images built. Fresh isolated containers returned
  the expected app and relay health JSON. The relay runtime resolved Fastify
  5.12.1 from the locked deployment. Containers and their temporary network
  were removed; the user's running app was not replaced.
- **Canary smoke:** the production image composed nine adapters successfully
  with Docker networking disabled. This proves import/dependency composition,
  not the availability of external sites. No live canary sweep was run during
  this audit.

The measured server coverage was statements **83.81%**, branches **73.60%**,
functions **86.31%**, and lines **86.13%**. The existing floors remain statements
83%, branches 73%, functions 85.5%, and lines 85.5%.

## Alternatives considered and remaining limits

1. **One ESLint process:** rejected by the repeated memory failures. Increasing
   the heap would transfer the cost to developer machines and CI runners.
2. **Separate per-scope ESLint caches:** could avoid cache churn but cannot fix
   cross-file type invalidation. A whole-graph cache key would require maintaining
   a reliable dependency/configuration fingerprint; fresh typed lint is simpler.
3. **Parallelize every browser test:** rejected because journey files contain
   ordered state changes. Only independent read-only reflow tests were changed.
4. **Remove `networkidle` waits from reflow:** deferred. They contribute at least
   a 500 ms quiet interval per page, but removing them without explicit page-ready
   assertions could measure a loading shell instead of the completed layout.
   Worker scheduling preserves the current readiness and layout assertions.
5. **Disable Vitest isolation, drop coverage, or add automatic retries:** rejected
   as speed shortcuts. Module-state tests depend on isolation; retries could
   convert flakes into green runs; coverage remains a regression floor.
6. **Parallelize all static CI steps or cache Docker layers remotely:** deferred
   until the simpler changes are measured on CI. More concurrent TypeScript
   programs increase peak memory; exporting the large browser/native image can
   cost more than the layers it saves. The four required check names and the
   already-settled non-strict branch rules were not changed.
7. **Coverage scope:** the floors deliberately cover server source, excluding
   process bootstrap and the e2e seed seam. They do not measure browser journeys,
   web/shared/relay coverage, or assertion quality. A global floor can hide
   weakly tested individual files. Future targeted tests should follow risk,
   not raise percentages by diluting the denominator.
8. **Existing strictness exceptions:** TypeScript's strict family is already on,
   with the documented test indexing exception and `skipLibCheck`. Some old test
   fixtures still use explicit unsafe-rule suppressions, including one broad
   file suppression. Cleaning those fixtures is separate from making the gates
   execute reliably. Hand-wrapped Markdown/YAML remains outside Prettier by
   existing policy; this audit did not silently broaden its formatting remit.
9. **Cold builds and stale artifacts:** incremental local builds do not remove
   obsolete output files. Clean CI images remain necessary, and now exercise the
   canary entry point as well as app startup. The scheduled canary's live source
   outcomes still need to be read from its subsequent receipts.

## Primary references

- [typescript-eslint: ESLint caching and cross-file type dependencies](https://typescript-eslint.io/troubleshooting/faqs/eslint/#can-i-use-eslints---cache-with-typescript-eslint)
- [typescript-eslint: typed-lint performance](https://typescript-eslint.io/troubleshooting/typed-linting/performance/)
- [Playwright: parallel tests and worker isolation](https://playwright.dev/docs/test-parallel)
- [Playwright: forbidOnly and reporter configuration](https://playwright.dev/docs/api/class-testconfig)
- [Playwright: CLI arguments](https://playwright.dev/docs/test-cli)

The installed pnpm 11.25.0 `deploy --help` documents the `--legacy --prod`
deployment mode used by the relay; its actual output was verified by building
and booting the runtime image.
