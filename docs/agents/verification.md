# Verification gates

Run the narrowest gate that covers the change while working, then the whole-tree
gate before pushing. Container changes also have to prove the image boots,
because Docker is the only supported way to run the app.

## Gate topology

| Granularity | Gate | What it proves |
| --- | --- | --- |
| Prose only | nothing | Nothing: no gate reads hand-written Markdown; read the rendered diff instead |
| One test | `cargo test -p chief-of-rust <test_name>` | The behavior at the seam currently being changed |
| One crate | `cargo check -p <crate> --all-targets && cargo clippy -p <crate> --all-targets` | The crate compiles and is lint-clean |
| Whole tree | `cargo fmt --all -- --check && cargo check --workspace --all-targets --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace --locked` | Format, compile, lint, and tests across the workspace |
| Production image | `docker compose build app`, then `docker compose up -d --wait app` | The image builds and the binary boots |
| Clean checkout | GitHub Actions on pull requests and pushes to `main` | fmt, check, clippy, test, and the production image boot |

### A prose-only change has no gate

A change touching only hand-wrapped Markdown — `AGENTS.md`, `docs/agents/`, the
README — has nothing for a compile gate to prove. Read the rendered diff
instead, and confirm the hand-wrapping survived: prose is hand-wrapped (see
`CODING_STANDARDS.md`), so a reflow is a finding.

## The `--locked` trap

Every whole-tree gate runs `--locked`. A `Cargo.toml` edit without a matching
`Cargo.lock` update fails `--locked` — that is the point: dependency changes
must land as a reviewed lockfile diff, not as whatever the CI runner resolves
that day. Run plain `cargo check` once to regenerate the lockfile, review the
diff, and include it in the commit.

When changing gate configuration, verify both a clean pass and an intentional
failure at the changed seam.

## Container check

Changes to the Dockerfile, compose file, or dependency tree need this
additional check after the whole-tree gate:

```sh
docker compose build app
docker compose up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:5317
docker compose restart app
docker compose up -d --wait app
python3 scripts/smoke.py http://127.0.0.1:5317 --verify-persistence
docker compose down
```

Run this in an isolated verification Workspace: the smoke script creates one
named Task and verifies it survives a process restart. The health endpoint must
name the binary and the script must exercise all five product pages. Compose's
persistent Workspace volume survives `down`; retain or explicitly manage only
your own verification volume. Production account and model calls require their
own live evidence; ordinary CI uses an explicit mock posture.

## Local development flow

The whole-tree gate is the pre-push bar. While iterating, prefer the fast path:

- Format and lint: `.githooks/pre-commit` runs `cargo fmt --all -- --check` and
  `cargo clippy --workspace --all-targets --locked -- -D warnings`. Enable it with
  `git config core.hooksPath .githooks`.
- Tests: `cargo nextest run --workspace --locked` (install with
  `cargo binstall cargo-nextest --secure`; the prebuilt archive at
  `https://get.nexte.st/latest/mac` works without binstall) plus
  `cargo test --workspace --locked --doc` — nextest never runs doctests.
  Fall back to `cargo test -p chief-of-rust <name>` for a single seam.
  CI uses `--profile ci`, which writes `target/nextest/ci/junit.xml`; the
  profile and the calibrated `slow-timeout` live in `.config/nextest.toml`.
- Timings: measure one binary while iterating (`cargo nextest run --test
  terminal`), and take whole-suite numbers from `python3 scripts/test-times.py`.
  It prints per-binary seconds beside the commit, the core count and the
  `target/debug/deps` entry count, because a large `deps` directory inflates
  every process-per-test run; the script warns and names the prune before you
  quote a number.
- Debug builds use `[profile.dev]`/`[profile.test]` in `Cargo.toml`: `opt-level = 1`
  for the crate, `opt-level = 2` for dependencies, `debug = "line-tables-only"`,
  and `split-debuginfo = "packed"`. `incremental = true` stays on locally.
- Optional tooling: set `RUSTC_WRAPPER=sccache` in CI or shared environments, with
  incremental compilation disabled there. `mold` is a Linux-only opt-in; keep it
  in a local override rather than the committed config.

## Source limits and Terminal diagnostics

The query-Source selection bounds (8 minimum / 12 maximum per Source, 50 total
per search) are installation overrides: `CHIEF_SOURCE_MIN_PER_SOURCE`,
`CHIEF_SOURCE_MAX_PER_SOURCE` and `CHIEF_SOURCE_MAX_TOTAL` clamp to safe
bounds, unset variables keep the defaults, and every clamped or unparseable
override is recorded in the Run's saved limits and on the Settings page. When
verifying a Source-admin change, the narrow gate is the seam that owns the
behavior:

- `cargo test -p chief-of-rust --lib env_overrides` — override parsing,
  clamping and deviation recording on `SourceLimits`.
- `cargo test -p chief-of-rust --lib config_source_limits` — `Config` wiring:
  defaults when unset, clamped overrides with recorded deviations, and an
  isolated workspace that never inherits them.
- `cargo test -p chief-of-rust --test settings_providers source_limits` and
  `failing_configured_source` — the Settings page shows the effective limits
  and deviations, and search-test diagnostics list each Source's status,
  returned/selected counts and elapsed time, so a failing configured Source is
  identifiable.
- `cargo test -p chief-of-rust --test terminal_query_sources` — the Terminal
  HTTP seam applies the effective limits end to end and records the deviation
  notes in the Run's saved limitations.

Terminal research is mandatory: a configured Source failure fails the Run and
never silently skips the Source. Retention and selection are separate budgets
— a Run retains up to 80 source envelopes (`TERMINAL_MAX_SOURCES`) while
selection is bounded per Source and per search — so a change to one budget
must not be verified as a change to the other.
