# Verification gates match the change granularity

The app has three materially different verification boundaries. Treating them as one gate would
either make every commit slow or leave the only supported runtime untested.

**Staged files are checked at commit time.** The pre-commit hook runs Prettier on the staged file
types it knows how to format and ESLint on staged TypeScript. It does not run typechecking, knip,
unit tests, or Playwright: those tools analyze more than the staged diff, and putting them in the
hook would turn a small local guard into a whole-tree delay.

**The whole tree is checked before every commit.** `npm run check` is the local gate for
typechecking, linting, formatting, unused-code analysis, and unit tests. `npm run check:all` adds
Playwright when behavior across the Shell and Modules may have changed. Incremental TypeScript
state makes repeated local checks cheaper, but CI starts cold and claims no benefit from it.

**CI proves a clean install and the production image.** A push to `main` runs separate check,
unit-with-coverage, e2e, and image jobs on Node 22. The image job builds with Docker Compose, boots
the pruned runtime image, and waits for `/api/health`. A build alone is insufficient: a bad
`CMD`, a missing runtime-stage file, or an incorrectly pruned dependency fails only when the image
starts.

**There is deliberately no pull-request trigger and no dependency bot.** This repository works
directly on `main`; branches and pull requests are not part of its review model. A dependency bot
would manufacture pull requests the workflow forbids, and a pull-request CI trigger would describe
a path the repository does not use. Dependency upgrades remain deliberate sweeps, individually
verified at the boundary their risk reaches.

## Consequences

The same check may run locally and again in CI. The repetition buys a clean lockfile install; the
image job adds the separate proof that matters most. Developers and agents fix a failing
pre-commit hook rather than bypassing it with `--no-verify`.

Coverage is a server-tree regression ratchet, not a quality verdict: one global lines floor, with
no branch or per-file threshold. The floor records the measured baseline and missing adapter tests
remain visible work rather than being disguised by a broader denominator.
