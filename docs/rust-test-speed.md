# Making this Rust test suite faster without losing fidelity

_Researched 2026-10-18. Question: every credible way to make a Rust test suite like this one
(axum + SQLite + Tokio, `tower::ServiceExt`/`axum_test` + `wiremock` integration tests) faster,
without weakening what the tests actually prove. Repo commit: `cf80145`._

_Path note: this repo keeps long research notes directly under `docs/` (see
`docs/omp-jev-integrations.md`), so this file lives at `docs/rust-test-speed.md` rather than in a
`docs/research/` subdirectory that does not exist here._

Toolchain measured on: macOS 25.6.0 arm64, 18 cores, rustc 1.99.0, cargo 1.99.0,
cargo-nextest 0.9.148.

## Bottom line

- **cargo-nextest is the single biggest win: 98.0 s → 20.4 s (4.8×) on a fresh target dir.**
  `tests/terminal.rs` drops 90.2 s → 20.0 s because process-per-test gives each test its own copy
  of a process-global pacing map.
- **The "nextest made `terminal_automatic` 17× slower" result was an artifact of this checkout.**
  Its `target/debug/deps` holds 432,506 entries; exec from there costs ~1 s instead of ~0.02 s,
  so 33 spawns cost 22 s. With a fresh target dir the same 33 tests take 0.60 s under nextest —
  *faster* than the 1.29 s single process. Fix: prune `target/` (see §1(c), §14).
- **The single largest remaining cost is wall-clock `sleep` inside the code under test.** The
  GDELT test was 20.01 s of pure sleeping and the *entire* floor of `terminal.rs` under nextest.
  The clock injection landed, taking it to 0.019 s and `terminal.rs` to 3.74 s. No runner flag
  could have done that; a `sleep` needs a source change.
- **The highest-value fidelity-preserving source change is making `collect.rs`'s pacing
  injectable.** That converts the 20 s sleep and the per-host pacing waits to ~0 s while still
  asserting the pacing *decision*, and it also removes the cross-test contention that makes
  `cargo test`'s `terminal.rs` 90 s instead of 20 s.
- **`start_paused = true` is a trap for this codebase in its current shape.** It virtualises
  `tokio::time::sleep` but not `std::time::Instant`, and it virtualises `reqwest`'s timeout, so
  real `wiremock` I/O can time out instantly against a virtual clock. Both effects were measured
  here; see §5.
- **More workers do not help.** The suite is 20.4 s of which 20.0 s is one `sleep`; with pacing
  removed the entire 236-test suite runs in 2.3–3.3 s. `-j 8/18/32` gives 59.5/61.1/69.2 s on the
  bloated dir; two concurrent shards measured 66 s against 60 s for one process. See §13.
- **The pre-existing `.config/nextest.toml` override was mis-targeted and is now removed.**
  `filter = "test(integration)"` matched 7 `integrations::*` unit tests (substring match), none of
  them the heavy SQLite/HTTP tests the comment described, and `threads-required = 2` reserves
  threads rather than serialising as the comment claimed. The config now carries a calibrated
  `slow-timeout` and a `ci` profile instead; see §8.

## Baseline, measured here

Measured on this machine on 2026-10-18, warm build, `--locked`, no other jobs running. "cargo
test" is libtest's process-per-binary model; "nextest" is process-per-test.

Two target directories matter, and they change the conclusion. The checkout's own
`target/debug/deps` holds **432,506 entries / 66 GB**; a fresh one holds 939. Every `exec` from
the bloated directory costs ~1 s instead of ~0.02 s (mechanism and scaling table in §1(c)).

| Measurement | cargo test | nextest | Note |
| --- | --- | --- | --- |
| Whole workspace, **fresh target dir** | **98.0 s** | **20.4 s** | the honest comparison: nextest 4.8× |
| Whole workspace, bloated `./target` | 110.9 s | 60.1–64.9 s | local deps bloat costs ~40 s, nextest only |
| `--lib` inline unit tests (72 pass) | **0.26 s** | n/a | negligible either way |
| `tests/terminal.rs`, fresh | 90.03 s | **20.0 s** (now **0.37 s** after the clock injection, §5) | it was `sleep` |
| `tests/terminal_automatic.rs`, fresh | 1.29 s | **0.60 s** | **no regression** with a fresh `deps` |
| `tests/terminal_automatic.rs`, bloated | 1.29 s | 22.1 s | the 17× was directory bloat, not nextest |
| `tests/public_research.rs`, fresh | 6.9 s | **2.0 s** | |
| `tests/providers.rs` (8 pass, 6 ignored) | **2.4 s** | n/a | |
| `tests/meetings.rs` (19 tests) | **1.9 s** | n/a | |
| `tests/meeting_debrief.rs` (10 tests) | **1.0 s** | n/a | |
| `tests/settings_providers.rs` (9 pass, 1 ignored) | **1.1 s** | n/a | |
| `tests/runtime.rs` (13 tests) | **1.0 s** | n/a | |
| `tests/pdf_worker.rs` (4 tests) | **0.9 s** | n/a | |
| Slowest single test, `gdelt_rate_limits_retry_once_and_respect_a_long_provider_delay` | **20.01 s** (before the clock injection; **0.019 s** after) | same | it was `sleep`, not runner overhead |

Corrections to earlier drafts of this note, kept so the reasoning is auditable:

- The "`terminal_automatic` is 17× slower under nextest / XProtect" finding was **wrong**. Same
  source, same binary bytes: `/tmp` 0.02 s per exec, `./target/debug/deps` 0.93 s. A fresh
  `CARGO_TARGET_DIR` removes it entirely (0.60 s). It is directory-entry-count-dependent exec
  cost, not code-signing scanning. §1(c) has the A/B and the 0 / 20k / 100k / 300k scaling.
- The whole-suite 60.1 s nextest figure is **inflated by this checkout's target dir**. On a fresh
  target dir the same suite is 20.4 s and `cargo test` is 98.0 s.
- `tests/public_research.rs` is 6.9 s under `cargo test` and 2.0 s under nextest on a fresh dir.

Per-binary times on this suite are sensitive to concurrency and to `deps` size. I first measured
8.3 s for `terminal_automatic` and 109.5 s for the whole suite while another build was running.
**Re-measure with nothing else running and a maintained target dir**, and treat any single figure
as ±20 %.

Anything below marked **estimate** was not measured on this machine. Everything marked
**measured** was.

## Prioritized: technique → effect → fidelity risk → effort

Effect is against the measured `cargo test` baseline on a fresh target dir (**98.0 s**) unless a
row says otherwise; the earlier 110.9 s figure was inflated by local `deps` bloat (§1(c)).
"measured" means I ran it here; "estimate" means I did not. Rows 1–4 are **not additive** — they
attack the same 90 s in `terminal.rs` from different angles, and row 4 is the source fix that makes
row 1 unnecessary. Rows 5–12 are independent. Two rows are negative and are called out rather
than hidden.

| # | Technique | Expected effect on the 98.0 s baseline | Fidelity risk | Effort |
| --- | --- | --- | --- | --- |
| 1 | Adopt `cargo nextest run` (already in CI) | **−77.6 s measured** → 20.4 s | None; doctests must stay a separate `--doc` step (already are) | done |
| 2 | Inject a clock into `collect.rs` pacing (**landed**: `static PACING` → `Pacer` + `Clock`, `App.pacer`, `*_with` entry points, recording clock in tests) | **−20 s measured** on the GDELT test (20.01 s → 0.019 s) and **−89.8 s** on `terminal.rs` under `cargo test` (90.2 s → 0.37 s) | None; the test asserts the recorded sleep sequence, see §5 | done |
| 3 | Prune `target/debug/deps` (432k entries → 939) | **−40 s measured** on the bloated checkout (64.9 s → 20.6 s); 0 on a fresh one | None | `cargo clean` |
| 4 | ~~Give each test its own pacing state~~ — **folded into row 2** | superseded: `App.pacer` + origin keying is part of the landed clock injection, which is what nextest's process isolation was only proxying | None | done |
| 5 | `[profile.dev.package."*"] opt-level = 1` (currently `2`) | **estimate −10 to −20 s cold**, ~0 warm | None; Cargo recommends `1` to keep monomorphisation sharing | 1 line |
| 6 | `[profile.test] debug = false` | **estimate −15 to −40 s cold** (Perf Book: 20–40 % of build time) | Loses backtrace line numbers in failures | 1 line |
| 7 | Fix `.config/nextest.toml` (drop the mis-targeted `test(integration)` override, calibrate `slow-timeout`, add a `ci` profile with JUnit) | **~0 s**; correctness and CI reporting only | None | done |
| 8 | CI: `--archive-file` build-once-test-many + `--partition slice:1/N` | **estimate −40 to −60 s per shard**, and −70 s wall at N=2 | None | CI only |
| 9 | SQLite: `temp_store=MEMORY`, WAL already on | **estimate −0 to −1 s** | None | 1 line |
| 10 | SQLite: `:memory:` or `synchronous=OFF` | **estimate −1 to −5 s** | **Real**: stops exercising WAL/durability, which `runtime.rs` and the smoke gate exist to prove | ~10 lines |
| 11 | `sccache` / `RUSTC_WRAPPER` in CI | **estimate −60 to −90 s cold CI**, ~0 local warm | None | CI only |
| 12 | Split `tests/terminal.rs` into fast + slow binaries | **~0 under nextest**; **estimate −20 s under `cargo test`** | None | file moves |
| 13 | `OnceLock`/`LazyLock` shared `MockServer` | **0 to negative** — nextest already isolates processes for free | Reintroduces global-state coupling between tests | — |
| 14 | Lower `retries`, `#[ignore]` slow tests, loosen timeouts | Looks like a win; **deletes evidence** | **Unacceptable** | — |
| 15 | `cargo test --release` | **estimate −30 to −50 s** because the code under test speeds up | **Unacceptable**: `debug-assertions` and `overflow-checks` default to `false`, so those paths stop being tested | 1 flag |

## 1. Where the time actually goes

Three separate cost centres, and they need three different fixes.

**(a) Wall-clock sleep inside the code under test.** `crates/app/src/collect.rs:250` has

```rust
async fn pace(host: &str, delay: Duration) {
    let wait = {
        let mut pacing = PACING.lock().await;
        let now = Instant::now();
        let wait = pacing
            .get(host)
            .and_then(|last| delay.checked_sub(now.duration_since(*last)))
            .unwrap_or_default();
        pacing.insert(host.to_owned(), now + wait);
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}
```

with `static PACING: LazyLock<tokio::sync::Mutex<HashMap<String, Instant>>>` at
`crates/app/src/collect.rs:247`. Every collector passes `standard_delay = 1 s`
(`crates/app/src/collect.rs:775`) and GDELT passes `5 s`
(`crates/app/src/collect.rs:1082`), and GDELT additionally retries after
`retry_after_secs` (`crates/app/src/collect.rs:1088`). This is deliberate, correct production
behaviour: it honours per-host rate limits.

It was also, by arithmetic, the whole 20.01 s of
`gdelt_rate_limits_retry_once_and_respect_a_long_provider_delay`. That test
(`crates/app/tests/terminal.rs:12`) loops three times over `[("0", true, 2), ("0", false, 2),
("60", false, 1)]` against three fresh `MockServer`s. The `Retry-After: 0` cases make two requests
each; the `Retry-After: 60` case makes one and is rejected by the `wait <= 30.0` guard. Four
requests reach the pacing gate: the first is free, the next three each wait ~5 s. The measured
20.01 s was the real cost of those waits.

**This is now fixed, and the section below describes the design that landed.** `PACING` and the
module-level `pace()` are gone. `collect.rs` now has a `Clock` trait (`now`, `sleep`), a
`SystemClock`, and a `Pacer` that owns the per-origin map and the clock. `Pacer::pace()` keeps the
original deadline arithmetic; `Pacer::sleep()` is the explicit retry wait. Every collector entry
point has a `*_with(&Pacer, ...)` form, and `App` carries `pacer: Arc<Pacer>`, which the research
runner passes down. The public `run_collector` / `collector_get` / `json_action` keep their
signatures and delegate to the process-wide `SYSTEM_PACER`, so no product caller changed.

Two defects fell out of the change:

- The map is now keyed by **origin** (`scheme://host:port`, `pace_key`) instead of `host_str()`.
  Every `wiremock` server listens on `127.0.0.1` with a random port, so the old key made every
  mock share one gate — that is why `terminal.rs` needed 90.2 s under `cargo test`.
- Tests inject a `RecordingClock` (`crates/app/tests/common/mod.rs`). It records every requested
  wait and advances virtual time instead of sleeping, so the test asserts the pacing decision at
  no wall-time cost.

Measured after the change: the GDELT test is **0.019 s** (from 20.01 s) and `tests/terminal.rs`
is **0.37 s** (from 20.0 s under nextest, 90.03 s under `cargo test`). The last step was routing
the research runner's `run_single` through `App.pacer`; until that, the four long research tests
still used the process-wide system pacer and `terminal.rs` sat at 17.0 s.

**(b) A process-global pacing map shared by every test in a binary — removed.** The old `PACING`
was keyed by `host` only — `parsed.host_str()`, which excludes the port
([`Url::host_str`](https://docs.rs/url/latest/url/struct.Url.html#method.host_str)). Every
`wiremock::MockServer` in these tests listens on `127.0.0.1` on a random port, so **all tests in
one binary shared one pacing slot**. Under `cargo test`, 18 threads all queued behind a single 1 s
or 5 s gate for the literal host `127.0.0.1`. That single difference is the measured
90.2 s → 20.0 s on `tests/terminal.rs`. With the `Pacer` owned by `App`, tests that need isolation
get it by construction, and `COLLECTOR_ENV_LOCK` (`crates/app/tests/terminal.rs:9`) still guards
the `set_var` windows.

**(c) Per-test process spawn, amplified by a bloated `target/debug/deps`.**
`tests/terminal_automatic.rs` uses in-process `axum_test::TestServer` and `llm_provider = "mock"`, so collectors are skipped
(`crates/app/src/terminal/automatic/research.rs:362`) and pacing never runs. Its 33 tests cost
1.29 s in one process but 22.1 s as 33 processes **in this checkout**. That gap is not XProtect
and not the 44 MB binary size: it is the size of the directory the binary is spawned from.

Measured on 2026-10-18: `target/debug/deps` here holds **432,506 entries / 66 GB** (128k
`chief_of_rust-*` artifacts, 428k `.rcgu.o` objects). Executing the *same bytes* costs 0.93 s
there and 0.02 s from `/tmp` (identical MD5, same adhoc linker signature, `xattrs` identical).
Synthetic scaling on this filesystem, one 44 MB binary, `--exact` one test:

| entries in the directory | exec time |
| --- | --- |
| 0 | 0.02 s |
| 20,000 | 0.03 s |
| 100,000 | 0.17 s |
| 300,000 | 0.47 s |

So the cost is per-`exec` directory work, linear in entry count, and 432k entries lands near 1 s
per spawn — 33 spawns ≈ 22 s. The whole-suite A/B proves the mechanism end to end, same source,
same commit, only the target dir differs:

| target dir | `deps` entries | whole suite | `terminal_automatic` |
| --- | --- | --- | --- |
| `./target` (this checkout) | 432,506 | **64.9 s** | **22.1 s** |
| `/tmp/chief-target-repo` (fresh) | 939 | **20.6 s** | **0.60 s** |

nextest's macOS docs do warn about XProtect ("even the simplest of tests … taking more than
0.2 seconds", [nextest macOS notes](https://nexte.st/docs/installation/macos/)), and the symptom
matched; the measurement disproves it as the cause here. The fix is `cargo clean`-scale, not an
OS setting — see §14. Note this also means **the 60.1 s nextest figure reported earlier is inflated
by the local target dir**; on a fresh `deps` the same suite is 20.4–20.6 s.

## 2. cargo-nextest

Primary sources: the [configuration reference](https://nexte.st/docs/configuration/reference/),
[repository configuration](https://nexte.st/docs/configuration/), [filtersets](https://nexte.st/docs/filtersets/),
[running tests](https://nexte.st/docs/running/), [how it works](https://nexte.st/docs/design/how-it-works/),
[why process-per-test](https://nexte.st/docs/design/why-process-per-test/),
[partitioning](https://nexte.st/docs/ci-features/partitioning/),
[archiving](https://nexte.st/docs/ci-features/archiving/),
[JUnit](https://nexte.st/docs/machine-readable/junit/),
[retries](https://nexte.st/docs/features/retries/),
[slow tests](https://nexte.st/docs/features/slow-tests/),
[threads-required](https://nexte.st/docs/configuration/threads-required/),
[test groups](https://nexte.st/docs/configuration/test-groups/),
[per-test overrides](https://nexte.st/docs/configuration/per-test-overrides/).

**Execution model.** nextest builds with `cargo test --no-run`, then lists tests from every binary,
then runs *each test in its own process* in parallel; contrast `cargo test`, which runs binaries
serially and lets libtest parallelise threads within a binary. The documented consequence is that
"if a binary has 20 tests and 19 of them take less than 5s, while one of them takes 60s … `cargo
test` has no way to start running other test binaries in those last 55 seconds"
([how it works](https://nexte.st/docs/design/how-it-works/)). This is the mechanism that helps
`terminal.rs` here and the mechanism that hurts `terminal_automatic.rs`. For this repo the two
effects do not cancel: measured nextest is 20.4 s against 98.0 s for `cargo test` on a fresh target
dir (60.1 s against 110.9 s on this checkout's bloated one).

**Parallelism.** Default `test-threads = "num-cpus"`; accepts a positive integer, a negative
integer relative to the CPU count, or `"num-cpus"`
([reference](https://nexte.st/docs/configuration/reference/)). This is separate from
`--build-jobs`. Measured here on the bloated target dir: `terminal_automatic` took 22.1 s at the
default `num-cpus` (18) and
26.6 s at `-j 2`. Lowering `-j` does **not** help this suite: the cost is process spawn, which
`-j` cannot remove, and the default already lets nextest overlap tests that block on sleep. Do not
tune `-j` here expecting a win.

**`threads-required`.** Reserves *n* slots out of the global pool for a test; valid values are a
positive integer, `"num-cpus"`, or `"num-test-threads"`. It is explicitly **not** mutual exclusion:
"`threads-required` is not meant to ensure mutual exclusion across subsets of tests"
([threads-required](https://nexte.st/docs/configuration/threads-required/)). The existing
`.config/nextest.toml` comment says "Heavy SQLite/HTTP integration tests run one at a time" and
then sets `threads-required = 2` — those two statements disagree. To run a subset one at a time
you need `[test-groups]` with `max-threads = 1` plus a `test-group` override
([test groups](https://nexte.st/docs/configuration/test-groups/)).

**The pre-existing override was mis-targeted.** `.config/nextest.toml` had
`filter = "test(integration)"`. `test()` is a *substring* matcher on the test name
([filtersets](https://nexte.st/docs/filtersets/), and `nextest-filtering/src/parsing.rs:684` /
`expression.rs:329` at `6c2ab7e`), and `cargo nextest list --workspace -E 'test(integration)'`
(measured) returned **7** tests, all `chief-of-rust integrations::*` unit tests — none of them the
SQLite/HTTP integration tests the comment intended. No function named `*integration*` exists in
`crates/app/tests/`. The mechanism it reached for, `threads-required`, is also the wrong one: it
reserves pool slots and does not enforce mutual exclusion. Both are gone in the current config.

**Filtersets (`-E`).** A Bazel-query-inspired DSL with `test()`, `package()`, `binary()`,
`deps()`, `rdeps()`, `platform()`, `group()`, `default()`, plus `and`/`or`/`not`/`+`/`-` and
`/regex/` forms. Filtersets intersect with substring filters and are intersected with
`default-filter` unless `--ignore-default-filter` is passed
([filtersets](https://nexte.st/docs/filtersets/)). Useful locally:
`cargo nextest run -E 'binary(terminal) and not test(gdelt)'`.

**`slow-timeout` / `leak-timeout` / `retries`.** `slow-timeout` defaults to `60s` with no
termination; `{ period, terminate-after, grace-period, on-timeout }` controls marking and
termination. `leak-timeout` waits for orphaned children after a test finishes — relevant because
`tests/pdf_worker.rs` spawns a real child process. `retries` defaults to `0`; backoff and jitter
are configurable ([slow tests](https://nexte.st/docs/features/slow-tests/),
[retries](https://nexte.st/docs/features/retries/)). With `retries > 0` and the default
`flaky-result = "pass"`, a test that fails then passes is reported as *flaky* and the run exits 0
— see §9.

**`--profile`.** `-P/--profile` selects a profile; custom profiles inherit from `default` and can
chain via `inherits`; `fail-fast`, `retries`, `slow-timeout`, `test-threads`, reporter levels and
JUnit paths are all per-profile
([repository configuration](https://nexte.st/docs/configuration/)). CI should use a profile with
`fail-fast = false`; local should keep the default `fail-fast = true` (nextest's
[documented recommendation](https://nexte.st/docs/configuration/)).

**`--partition`.** `slice:m/n` assigns tests round-robin across buckets after all other filters;
`hash:m/n` is deterministic on binary ID + test name and stable as tests are added or removed;
`count:m/n` is deprecated as "neither the even nature of sliced partitioning nor the stability of
hashed sharding" ([partitioning](https://nexte.st/docs/ci-features/partitioning/)). Use
`slice:` or `hash:`, not `count:`.

**`--archive-file`.** `cargo nextest archive --archive-file x.tar.zst` bundles cargo metadata,
binaries metadata, test binaries, dynamic libraries, non-test binaries used by integration tests,
and build-script `OUT_DIR`s one level deep. `cargo nextest run --archive-file x.tar.zst` on another
machine needs the same source revision checked out but **not** cargo. Only `.tar.zst` is supported
([archiving](https://nexte.st/docs/ci-features/archiving/)). This is the cheapest way to stop
paying build cost per shard in CI.

**JUnit.** `[profile.<name>.junit] path = "junit.xml"`; one `<testsuite>` per binary, one
`<testcase>` per test; failed and retried output is included by default, successful output is not
([JUnit](https://nexte.st/docs/machine-readable/junit/)).

**`--status-level` / `--final-status-level`.** Incremental levels; the defaults are `pass` and
`flaky` respectively. Setting `--status-level fail --final-status-level fail` cuts reporter I/O on
a fast suite ([reference](https://nexte.st/docs/configuration/reference/)). This is a real but
small effect — measured here, the whole suite's `user` time was 18.4 s against 64.9 s wall, so
the reporter is not the bottleneck.

**`--no-fail-fast` / `--max-fail`.** `--no-fail-fast` is equivalent to `--max-fail=all`; `--ff` is
the default. `--max-fail=N:immediate` terminates running tests rather than draining them
([running](https://nexte.st/docs/running/)). Note this is a *reporting* choice, not a speedup.

**`--no-tests=fail|warn|pass`.** Default is now `fail`; set `warn`/`pass` when a filterset
legitimately matches nothing (as with `cargo-hack` powersets)
([running](https://nexte.st/docs/running/)).

**nextest does not run doctests.** "Doctests are currently not supported because of limitations in
stable Rust. For now, run doctests in a separate step with `cargo test --doc`"
([running tests, footnote 1](https://nexte.st/docs/running/)). This repo already does exactly
that in `.github/workflows/ci.yml`, so nothing to change — but any plan that replaces
`cargo test` with `cargo nextest` must keep the `--doc` step or doctests silently stop running.

## 3. Harness-level knobs under `cargo test`

**What `cargo test` already gives you, so do not claim it as a win.** libtest runs a binary's
tests on N threads where N defaults to `available_parallelism`
([rustc book, test harness](https://doc.rust-lang.org/rustc/tests/index.html)). Binaries themselves
run serially, and cargo stops after the first failing binary unless `--no-fail-fast`
([cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html)). So on this 18-core
machine you already have intra-binary parallelism; the uncovered win is inter-binary overlap,
which is nextest's contribution and which is exactly a wash here (§2).

**`--test-threads` / `RUST_TEST_THREADS`.** Sets the thread count; the env var is documented as
deprecated in favour of the flag
([rustc book](https://doc.rust-lang.org/rustc/tests/index.html)). Measured on
`tests/terminal_automatic.rs`: `--test-threads 1` = 7.3 s, `4` = 5.7 s, `18` = 8.7 s. More
threads is *worse* here — these tests are memory- and spawn-bound, not CPU-bound. Measured on
`tests/terminal.rs`, the pacing gate means thread count barely matters.

**`--nocapture` / `--no-capture` costs what you think.** It stops libtest capturing stdout/stderr
and lets tests print directly, which interleaves output from parallel tests; `--show-output` is
the contiguous alternative that waits for completion
([rustc book](https://doc.rust-lang.org/rustc/tests/index.html)). It does not meaningfully change
speed; it changes readability. Do not use it in CI.

**`--report-time` is nightly-only.** "⚠️ 🚧 This option is unstable, and requires the
`-Z unstable-options` flag" ([rustc book](https://doc.rust-lang.org/rustc/tests/index.html)). If
you want per-test timings on stable, use `cargo nextest run`, which prints them unconditionally
([running](https://nexte.st/docs/running/)).

**`RUST_TEST_SHUFFLE`** randomises order; the flag is `--shuffle`. Useful for finding the
order-dependence that `COLLECTOR_ENV_LOCK` is papering over, not for speed.

## 4. Compilation-time wins

These matter for the cold run (reported as 180 s cold vs 105 s warm). Cite the
[Cargo profiles reference](https://doc.rust-lang.org/cargo/reference/profiles.html), the
[Rust Performance Book](https://nnethercote.github.io/perf-book/build-configuration.html), and the
[rustc codegen options](https://doc.rust-lang.org/rustc/codegen-options/index.html).

**`[profile.test]` inherits `dev`.** Cargo documents `[profile.test] inherits = "dev"` as the
default, so every `[profile.dev]` setting applies to tests
([profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)). This repo already exploits
that: `Cargo.toml:24`-`25` sets `[profile.test] inherits = "dev"`, and `[profile.dev]` sets
`opt-level = 1`, `debug = "line-tables-only"`, `split-debuginfo = "packed"`,
`incremental = true`, `codegen-units = 256`, with `[profile.dev.package."*"] opt-level = 2` and
`[profile.dev.build-override] opt-level = 3`.

**`opt-level` for deps vs the local crate.** `opt-level = 2` on all dependencies is the expensive
part of the current config. Cargo warns that at `opt-level` 2 or 3 "a crate will not use
monomorphized generics from other crates, nor will it export locally defined monomorphized items
to be shared"; it explicitly suggests "trying opt-level 1, which will apply some optimizations
while still allowing monomorphized items to be shared"
([profiles, overrides and generics](https://doc.rust-lang.org/cargo/reference/profiles.html)).
Dropping `[profile.dev.package."*"]` to `1` is a one-line **estimate −10 to −20 s cold** change
with no behavioural risk.

**`debug` / `split-debuginfo`.** Disabling debuginfo "can improve dev build times significantly,
by as much as 20-40 %"; `debug = "line-tables-only"` "still gives most of the compile time
benefits" ([Perf Book](https://nnethercote.github.io/perf-book/build-configuration.html)). This
repo is already at `line-tables-only`, so the remaining 20–40 % is only available by going to
`debug = false`, at the cost of line numbers in failure backtraces — a real fidelity loss for
debugging, not for correctness. `split-debuginfo = "packed"` is already set; on macOS `packed`
means a separate `.dSYM` and is the platform default
([rustc codegen options](https://doc.rust-lang.org/rustc/codegen-options/index.html)).

**`codegen-units`.** Defaults are 256 for incremental and 16 for non-incremental builds; more units
means more parallelism and slower code ([rustc codegen options](https://doc.rust-lang.org/rustc/codegen-options/index.html)).
Already at 256, which is the compile-time-favouring end. Nothing to win.

**`incremental`.** `.cargo/config.toml` sets `[build] incremental = true`. This helps warm
rebuilds and cannot be combined with `sccache` (the repo comment already says so, and sccache
documents that incremental output is not cacheable). Keep incremental locally; turn it off in CI
where `sccache`/`rust-cache` is doing the caching.

**`sccache` / `RUSTC_WRAPPER`.** sccache is "a ccache-like compiler caching tool … used as a
compiler wrapper and avoids compilation when possible, storing cached results either on local disk
or in one of several cloud storage backends"
([sccache README](https://github.com/mozilla/sccache)). Set `RUSTC_WRAPPER=sccache` with
`CARGO_INCREMENTAL=0`. **Estimate −60 to −90 s cold CI**, ~0 local warm. Note nextest's own
benchmark page points out that "speeding up the build by using sccache … will make test run times
be a proportionally greater part of overall times"
([nextest benchmarks](https://nexte.st/docs/benchmarks/)).

**`rust-lld` / `mold`.** lld "has been the default linker on Linux since Rust 1.90"; mold "is
often faster than lld"; on macOS "an alternative linker isn't necessary because the system linker
is fast" ([Perf Book](https://nnethercote.github.io/perf-book/build-configuration.html)). The repo's
`.cargo/config.toml` already documents mold as an opt-in for Linux and leaves macOS alone — that
is the right call. mold's own README claims it is "faster than LLVM lld"
([mold](https://github.com/rui314/mold)). **Estimated effect here: ~0 on macOS, −5 to −15 s per
link on Linux CI.** Configure via `[target.<triple>] linker` / `rustflags`
([Cargo config](https://doc.rust-lang.org/cargo/reference/config.html)).

**`cargo build --timings`.** Writes `target/cargo-timings/cargo-timing.html` with a unit graph
showing duration, concurrency and the critical path; "these reports are suitable for human
consumption only, and do not provide machine-readable timing data"
([Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html),
[cargo test --timings](https://doc.rust-lang.org/cargo/commands/cargo-test.html)). Use it before
and after any profile change — it is the only way to know whether a profile tweak helped, since
`opt-level` effects are workload-specific ("there may be surprising results, such as level 3 being
slower than 2" — [profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)).

**Feature unification.** Resolver v2 "avoids unifying features in a few situations where that
unification can be unwanted", but "one drawback is that this can increase build times because the
dependency is built multiple times"
([features](https://doc.rust-lang.org/cargo/reference/features.html)). This workspace has one
crate plus a small dep set, so there is nothing meaningful to win. `cargo hack --each-feature` /
`--feature-powerset` ([cargo-hack](https://github.com/taiki-e/cargo-hack)) is the tool for that
audit, and `--no-tests=warn` is why nextest has that flag.

**Workspace splitting** is the standard remedy for a large single crate: more crates means more
parallel codegen units across crates. With `crates/app` as the only substantive crate, **there is
nothing to split** — the cost is inside one crate. Do not do this.

## 5. Timer and clock fidelity: the highest-value section for this repo

This is where the 20 s and most of `terminal.rs`'s remaining cost live. Get it wrong and the tests
stop proving anything.

### What `tokio::time::pause()` actually virtualises

`pause()` "saves" the current value of Tokio's `Instant::now()` and all subsequent calls return
it; auto-advance moves the clock to the next pending timer whenever the runtime has no other work
([`tokio::time::pause`](https://docs.rs/tokio/latest/tokio/time/fn.pause.html)). It "only affects
the `Instant` type in Tokio, and the `Instant` in std continues to work as normal" — same page.
`#[tokio::test(start_paused = true)]` is sugar for
`Builder::new_current_thread().enable_all().start_paused(true)`, and **requires the `test-util`
feature** ([`tokio::test`](https://docs.rs/tokio/latest/tokio/attr.test.html)). This repo does
**not** currently enable `test-util`: `crates/app/Cargo.toml:22` lists
`["rt-multi-thread", "macros", "time", "signal", "fs", "net", "sync", "process", "io-std", "io-util"]`.

Virtualised: `tokio::time::sleep`, `sleep_until`, `timeout`, `timeout_at`, `interval`, `Interval`,
and `tokio::time::Instant`. Not virtualised: `std::time::Instant`, `std::time::SystemTime`,
`std::thread::sleep`, blocking syscalls, and any timer inside a library that uses `std` time.

`spawn_blocking` is the documented way to keep the clock paused during real I/O: "when a blocking
task is running, the clock's auto-advance is temporarily inhibited"
([`pause`](https://docs.rs/tokio/latest/tokio/time/fn.pause.html)). **Measured**: a
`spawn_blocking` that sleeps 300 ms real advanced the virtual clock by exactly `0ns`.

`advance()` is the wrong tool for triggering timeouts: "if you want to reliably trigger a timeout,
prefer using `sleep` with auto-advance rather than `advance`", because `advance` jumps time and
does not guarantee all timers are processed first
([`advance`](https://docs.rs/tokio/latest/tokio/time/fn.advance.html)).

### Two traps, both measured here

**Trap 1 — `std::time::Instant` is not virtualised, so `pace()`'s *decisions* survive but its
*waits* become free.** `crates/app/src/collect.rs:253` uses `std::time::Instant` (imported at
`crates/app/src/collect.rs:21`) while the sleep is `tokio::time::sleep`. I reproduced `pace()`
verbatim under `#[tokio::test(start_paused = true)]` and measured four 5 s calls:

```
call 0: wait=0ns          call 1: wait=4.999983625s
call 2: wait=5s           call 3: wait=5s
sum of waits = 14.999983625s, REAL wall = 371.25µs
```

Identical under a real clock, except the real wall time is 15.002 s. The wait *sequence* is
preserved — because `pace` stores `now + wait` in the future, `duration_since` saturates to zero
and the next wait is the full delay again
([`Instant::duration_since` saturates](https://doc.rust-lang.org/std/time/struct.Instant.html)).
So `start_paused` alone would take the 20 s GDELT test to ~0 s while still exercising every pacing
branch. That is a real, cheap win — **but see Trap 2 before doing it.**

**Trap 2 — `reqwest`'s timeout is a `tokio::time::Sleep`, so it gets virtualised and real I/O
times out instantly.** `reqwest` builds its per-request timeout from
`tokio::time::Sleep` (`use tokio::time::Sleep;` in
[`reqwest`'s client](https://github.com/seanmonstar/reqwest/blob/master/src/async_impl/client.rs)),
and this repo sets `.timeout(Duration::from_secs(TIMEOUT_SECS))` at
`crates/app/src/collect.rs` in `collector_get`. Under a paused clock, the runtime auto-advances
18 virtual seconds while the socket read is still in flight. **Measured**: with
`start_paused = true`, a `tokio::time::timeout(18 s, …)` wrapped around a connect plus read from a
real `TcpListener` that replied after 200 ms real returned `Err` immediately, reporting
`virtual_elapsed = 18s`. Every one of these collector tests talks to a real `wiremock` socket, so
blanket `start_paused` would convert passing tests into timeouts — or, worse, into tests that
assert the *timeout* path and pass for the wrong reason.

`wiremock`'s own `set_delay` is also a `tokio::time::Sleep`
(`use tokio::time::{Sleep, sleep};` in
[`wiremock`'s mock set](https://github.com/LukeMathWalker/wiremock-rs/blob/main/src/mock_set.rs),
applied in [`hyper.rs`](https://github.com/LukeMathWalker/wiremock-rs/blob/main/src/mock_server/hyper.rs)),
so it *is* virtualised — meaning a `set_delay`-based test behaves correctly under `start_paused`
while a real-socket latency test does not. Do not conflate the two.

### The fix that preserves fidelity: inject the clock

Replace the process-global `static` and the two ambient time sources with an explicit,
injectable seam. Concretely, in `crates/app/src/collect.rs`:

1. Delete `static PACING` (`:247`) and `fn pace` (`:250`) as ambient state. Introduce
   `trait Clock: Send + Sync { fn now(&self) -> Instant; async fn sleep(&self, d: Duration); }`
   with a `SystemClock` (production) and a `TestClock` (tests) implementation.
2. Hold pacing state in a `Pacer` owned by `App` (or passed into `run_collector`), not in a
   `static`. Key it by `(host, port)` or by the full origin, not `host_str()` alone, so two
   `wiremock` servers on `127.0.0.1` no longer share one slot. Same for
   `crates/app/src/collect.rs:2443`, the USAspending `pace(&host, 1s)` call.
3. Route the GDELT retry sleep at `crates/app/src/collect.rs:1086`
   (`tokio::time::sleep(Duration::from_secs_f64(wait))`) through the same `Clock`.
4. In tests, install a `TestClock` whose `sleep` records the requested duration and returns
   immediately.

That turns 20.01 s into ~0 s **and** removes the cross-test pacing contention that makes
`tests/terminal.rs` 90.2 s.

**The assertion that keeps it honest — landed.** `RecordingClock` records every requested wait and
advances virtual time, so the test asserts the pacing *decision* at no wall cost. The GDELT test
now asserts, per iteration:

- **no** recorded wait for the `Retry-After: 60` case — the 30 s bound must refuse the retry and
  must not sleep;
- `[ZERO, 5 s]` for the two `Retry-After: 0` cases — the first request has no prior request, then
  the retried request waits the full GDELT interval;
- the request count, envelope status and the `"exceeds the bounded"` note, as before.

That first bullet is the whole point: a regression that ignored `Retry-After` entirely would still
pass the request-count and status assertions, but not this one. The same property is available for
the origin map: two requests to one origin must record a wait of the full delay, and two requests
to different origins must record none — `Pacer` keys on `scheme://host:port`, so a second mock on
a new port is a new provider. `tests/common/mod.rs` carries the clock; `collect.rs` unit-tests `Pacer`
itself (`pacing_waits_are_per_origin_and_serialized`,
`explicit_retry_wait_is_recorded_even_when_zero`).

## 6. I/O and database wins

**This repo's SQLite crate.** `Cargo.lock` pins `rusqlite 0.40.2` with `libsqlite3-sys 0.38.2`,
and `crates/app/Cargo.toml:12` enables the `bundled` feature. Cite
[`rusqlite::Connection`](https://docs.rs/rusqlite/0.40.2/rusqlite/struct.Connection.html) for the
APIs — do **not** cite `sqlx`, which this repo does not use.

**What `Db::open` already does** (`crates/app/src/db.rs:37`): `Connection::open(path)`,
`PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, then `CREATE TABLE IF NOT EXISTS`
migrations. Tests call `Db::open(&cfg.db_path())` against a fresh `tempfile::tempdir()`
(e.g. `crates/app/tests/terminal.rs:165`).

**`tempfile` on a RAM disk / tmpfs.** `tempdir()` creates a directory under the system temp dir
([`tempfile::tempdir`](https://docs.rs/tempfile/latest/tempfile/fn.tempdir.html)); on macOS that
is on the boot volume unless `TMPDIR` points elsewhere. Creating a RAM disk and exporting `TMPDIR`
is a **system-level** change, not a portability win, and it is not measurable here. **Estimate
−1 to −3 s** for this suite — SQLite in WAL on an SSD is already fast, and §1 shows the time
is elsewhere. Low priority.

**SQLite `:memory:` vs a file.** `:memory:` creates a private database that "ceases to exist as
soon as the database connection is closed", and *each* `:memory:` connection is a distinct
database ([in-memory databases](https://www.sqlite.org/inmemorydb.html)). Two consequences:
(a) it is a genuine speedup for setup, and (b) `journal_mode = WAL` is meaningless/impossible for
a private in-memory database, so **switching to `:memory:` stops exercising the WAL configuration
that production uses** — a real fidelity loss for `tests/runtime.rs`, which asserts persistence
across reopen, and for the smoke script's `--verify-persistence` gate. Do not do it broadly. If
you want it, add a test-only `Db::open_in_memory()` and keep at least one WAL-backed file test.

**`synchronous`.** "With synchronous OFF (0), SQLite continues without syncing as soon as it has
handed data off to the operating system … commits can be much faster with synchronous OFF." But
the durability matrix shows WAL + OFF is "Not consistent"
([PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)). Setting it to
`OFF` in tests would stop exercising crash-consistency, which is precisely what this app's
persistence guarantees are about. `NORMAL` in WAL mode is "safe from corruption" and "always
consistent with synchronous=NORMAL, but WAL mode does lose durability" — a defensible test-only
choice, but it still changes what is proven. **Recommendation: leave `synchronous` alone.** The
measured gain would be small (§1) and the fidelity cost is real.

**`journal_mode`.** `MEMORY` "stores the rollback journal in volatile RAM. This saves disk I/O but
at the expense of database safety and integrity … the database file will very likely go corrupt"
if the app crashes mid-transaction ([PRAGMA journal_mode](https://www.sqlite.org/pragma.html#pragma_journal_mode)).
Never use it in a test that also asserts durability. `WAL` is already the right choice and is
documented as "significantly faster in most scenarios" with more concurrency
([WAL](https://www.sqlite.org/wal.html)).

**`busy_timeout`.** Already `5000`. The PRAGMA "sets the busy handler for the process"
([PRAGMA busy_timeout](https://www.sqlite.org/pragma.html#pragma_busy_timeout)); since `Db` holds
one `Connection` behind a `Mutex` (`crates/app/src/db.rs:13`), contention should be nil, and the
5 s timeout is a hang-detector rather than a cost. Leave it.

**Connection pooling.** Not applicable: `Db` is deliberately a single connection behind a mutex,
and the doc comment says so. Adding a pool would *increase* concurrency on one SQLite file and
invite `SQLITE_BUSY`; it is not a speedup for a single-user app. Skip.

**Transaction per test.** `Db::transaction` already wraps related mutations
(`crates/app/src/db.rs:66`). The remaining win would be wrapping *whole tests* in one transaction
and rolling back, but tests here go through axum handlers that open their own transactions, so it
is not expressible without changing the `Db` API. Skip.

**`temp_store = MEMORY`** keeps temporary tables and indices in memory
([PRAGMA temp_store](https://www.sqlite.org/pragma.html#pragma_temp_store)). Harmless and
plausibly a small win if any query spills to a temp b-tree. **Estimate −0 to −1 s**; only worth
doing alongside other `Db` changes.

## 7. Test-shape wins

**Split `tests/terminal.rs`.** Under `cargo test` this is worth doing: the file's long pole is a
20 s test and cargo cannot overlap binaries, so 90.2 s is a serial sum. Splitting the four
slow tests (`gdelt_rate_limits_…`, `company_continue_…`, `company_full_research_…`,
`person_continue_…`) into a separate `tests/terminal_slow.rs` lets cargo run the fast remainder
concurrently with the slow file and **estimate −20 to −40 s**. Under nextest this is already
handled — measured 20.0 s for the whole binary — so the split is a `cargo test`-only win. Note
the
split also splits `COLLECTOR_ENV_LOCK`, which currently serialises all 16 tests in the file; per
file, locks are per binary, so the two files no longer block each other.

**`#[ignore]` discipline.** Already correct: `live_generation.rs` (4), `meeting_corpus.rs` (3),
`providers.rs` (6), `settings_providers.rs` (1) = 14 of the 23 ignored, and `--lib` has 9 ignored,
for 23 total. These are genuinely live-provider tests. Keep them ignored by default and run them
with `cargo nextest run --run-ignored=only` ([running](https://nexte.st/docs/running/)).

**Fixture reuse: `OnceLock` / `LazyLock`.** A shared `MockServer` per binary instead of
`MockServer::start().await` per test is the *most tempting* and *least safe* optimisation here.
`tokio::test` needs a runtime to start a server, `OnceLock` cannot hold an async initialiser
without blocking, and sharing one server across tests re-introduces exactly the global-state
coupling that nextest's process model removes. Measured evidence: `terminal.rs` already pays this
cost (9 `MockServer::start()` calls, 90.2 s) and nextest fixes it for free by isolating processes.
**Do not add `OnceLock` servers**; if you must reduce servers, reduce them to one per *test* by
having a single mock answer all provider paths — `company_full_research_…` already does exactly
this (`crates/app/tests/terminal.rs`, one `MockServer` for ten `CHIEF_COLLECT_*_BASE` keys).

**Reducing `wiremock` servers per test.** Measured counts: `runtime.rs` 2, `public_research.rs` 5,
`providers.rs` 9, `settings_providers.rs` 9, `terminal.rs` 9, `llm_wiremock.rs` 5. Each server is
a real listener plus a task; consolidation within a test is free fidelity-wise (one server can
route on `path()`), and is the right version of the `OnceLock` idea.

**`insta` snapshots.** Not a speedup. Snapshot assertions are typically *faster* than
hand-written field-by-field assertions and, more importantly, they fail with a diff instead of a
`panic`. `insta` is not a current dependency; adding it is a fidelity *improvement* with neutral
speed. Out of scope for speed.

**`proptest` shrinking cost.** Not used in this repo. Shrinking is the expensive half of a
property test — it re-runs the property repeatedly to minimise a failing input
([`proptest` README](https://github.com/proptest-rs/proptest)). If it is ever added, keep
`PROPTEST_CASES` low in the default profile and let CI raise it; do not lower it to make failures
cheaper, which trades away coverage for time.

**Adjacent tooling, explicitly not speedups for this suite.**
- `cargo-mutants` finds "places where bugs could be inserted without causing any tests to fail"
  ([cargo-mutants](https://github.com/sourcefrog/cargo-mutants)) — it measures test *strength* and
  is far slower than the suite by construction. Run it out-of-band.
- `cargo-llvm-cov` is "a wrapper around rustc `-C instrument-coverage`" and supports `cargo
  nextest` ([cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov)) — instrumentation makes
  the suite slower. Run it in a separate job.
- `criterion` is statistics-driven microbenchmarking and is unrelated to functional test wall time.

## 8. CI topology

Current `.github/workflows/ci.yml` already has the important pieces: `Swatinem/rust-cache@v2`,
`taiki-e/install-action@nextest`, `cargo nextest run --workspace --locked`, and a separate
`cargo test --workspace --locked --doc`. Nothing there is wrong.

**Sharding.** `cargo nextest run --partition slice:1/4` across four jobs. Sliced partitioning is
round-robin after filtering and is more even than the deprecated `count:`; `hash:` is stable as
tests are added ([partitioning](https://nexte.st/docs/ci-features/partitioning/)). **Estimate −70 s
wall at N=2**, at the cost of runner minutes. Combine with archiving (below) or each shard rebuilds.

**Build once, test many.** `cargo nextest archive --archive-file tests.tar.zst` in a build job,
upload as an artifact, then `cargo nextest run --archive-file tests.tar.zst --partition slice:i/N`
in each test job — the source must be checked out at the same revision, but cargo is not needed
([archiving](https://nexte.st/docs/ci-features/archiving/)). **Estimate −40 to −60 s per extra
shard.** This is the single highest-leverage CI change.

**Cache strategy.** `Swatinem/rust-cache` keys on the workspace `Cargo.lock`, `rust-toolchain`,
`.cargo/config.toml` and the rustc version, and is not a compiler-level cache, so it does not help
when only a non-dependency file changes. `sccache` (with `CARGO_INCREMENTAL=0`) is the
compiler-level complement
([rust-cache](https://github.com/Swatinem/rust-cache), [sccache](https://github.com/mozilla/sccache)).
`taiki-e/install-action` installs prebuilt tool binaries from GitHub Releases with checksums by
default ([install-action](https://github.com/taiki-e/install-action)), so `nextest` costs seconds,
not minutes, to install — keep it.

**Linux vs macOS runners.** Two concrete differences for this suite:
1. Process spawn is much cheaper on Linux, so nextest's process-per-test model does not pay the
   XProtect/macOS penalty — but the local 22 s was directory bloat, not XProtect (§1(c) has the
   A/B). On a fresh `deps` the file is 0.60 s locally too, so Linux CI needs no allowance for it.
2. `split-debuginfo` defaults differ: `packed` on macOS and Windows-MSVC, `off` on ELF platforms
   ([rustc codegen options](https://doc.rust-lang.org/rustc/codegen-options/index.html)), so the
   current explicit `packed` is only meaningful on macOS.
Neither changes test *results*, only wall time — so CI timings will not predict local timings.
Do not set a `slow-timeout` tuned to local numbers.

**Fix the nextest config.** A `test-group` override was considered and rejected: bounding
`binary(terminal)`'s concurrency is exactly what nextest is winning there (20.0 s from 90.2 s
comes from running those tests concurrently), and the two tests that share the process-global
`PACING` map are isolated by the process model anyway. The applied fix is in the repository now:

```toml
[profile.default]
retries = 0
fail-fast = false
slow-timeout = { period = "60s", terminate-after = 2 }

[profile.ci]
fail-fast = false
junit = { path = "junit.xml" }
```

The 60 s `slow-timeout` is 3× the slowest legitimate test (the 20 s GDELT bound), so a hang still
fails fast while normal variance is not reported. Verified: `cargo nextest run --workspace
--locked --profile ci` completes in ~20–60 s (target-dir dependent, §1(c)) and writes
`target/nextest/ci/junit.xml` (46 KB, one
`<testsuite>` per binary). Note `junit` must be an inline table (`junit = { path = ... }`); the
dotted `junit.path = ...` form parses but writes nothing.

## 9. Anti-patterns that look like speedups but lose fidelity

- **Lowering `retries` to hide flakiness.** With `retries = 0` (current) a flaky test fails the
  run, which is correct. Raising `retries` and leaving `flaky-result = "pass"` means a test that
  fails then passes exits 0 and is reported `FLAKY`
  ([retries](https://nexte.st/docs/features/retries/)). That is a *slower, greener* suite that
  proves less. If retries are ever added, set `flaky-result = "fail"`.
- **`fail-fast` masking later failures.** nextest's default is `fail-fast = true`; the repo
  already sets `fail-fast = false`, which is right for CI. Do not "speed up" CI by turning it
  back on — it makes runs shorter by not running tests.
- **`--no-fail-fast` read as a speedup.** It is the opposite: it keeps running tests after a
  failure. It is a *reporting* improvement ("if that argument is passed in in CI scenarios, then
  failing test output is not printed at the end" under `cargo test`) and is the default under
  nextest via `fail-fast = false`.
- **`#[ignore]`ing slow-but-real tests.** The 20 s GDELT test is the only test that proves the
  `Retry-After <= 30` bound is enforced. Ignoring it to save 20 s deletes that guarantee.
  The 23 already-ignored tests are all live-provider tests or the live suite's own configuration
  checks, which is a legitimate reason — do not extend the practice to deterministic tests.
- **Replacing SQLite with mocks.** `Db` is the persistence boundary; mocking it would stop testing
  the WAL + migration + transaction behaviour that `tests/runtime.rs` and the smoke script's
  `--verify-persistence` gate exist to prove. `:memory:` is the softer version of the same mistake
  (§6).
- **Loosening timeouts.** `TIMEOUT_SECS = 18` (`crates/app/src/collect.rs:24`) is a production
  constant; raising it for tests hides hangs. Raising the nextest `slow-timeout` is fine (it is
  only a reporter), but raising `terminate-after` past the point where a genuinely hung test
  finishes turns a fast failure into a slow one.
- **`opt-level = 0` for the crate under test.** Already avoided: `[profile.dev] opt-level = 1`.
  Going to `0` would make the suite's actual code slower, which is backwards.
- **`cargo test --release`.** Looks like a 2–5× win on the code under test and costs correctness
  coverage: release sets `debug-assertions = false` and `overflow-checks = false` by default
  ([profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)). Every `debug_assert!`
  and every overflow panic stops being exercised, and `cfg(debug_assertions)` branches flip. If
  you want optimised tests, define a custom profile that inherits `test` and bumps `opt-level`
  while keeping `debug-assertions = true` and `overflow-checks = true` —
  `[profile.test-fast] inherits = "test"` + `opt-level = 2` — and verify the debug-assert paths
  still run.
- **Blanket `start_paused`.** §5, Trap 2: turns real-socket collector tests into instant virtual
  timeouts. It makes the suite fast and wrong.

## 10. Code verification of the cited tools

Every speed claim above that came from a README was checked against the tool's own source at the
pinned commit below. "verified" means the cited lines are the mechanism; "README-only" means the
claim exists only in prose.

| Tool | Pinned commit | Decisive code | Claim status |
| --- | --- | --- | --- |
| cargo-nextest | `6c2ab7e` | `runner/imp.rs:780,808` spawns per test; `runner/executor.rs` drives them through a weighted future queue | verified: concurrency unit is the test |
| cargo-nextest | `6c2ab7e` | `config/elements/threads_required.rs:23-28` + `future-queue/src/global_weight.rs:26-29` (`weight.min(self.max)`) | verified: `threads-required = 2` takes 2 slots and clamps, never errors, on a 2-core box |
| cargo-nextest | `6c2ab7e` | `nextest-filtering/src/parsing.rs:684` (`Contains`), `expression.rs:329` (`query.test_name`) | verified: `test(x)` is a substring match on the test name |
| cargo-nextest | `6c2ab7e` | `list/binary_list.rs:326` (`if artifact.profile.test`) | verified: doctests are excluded structurally; there is no `--doc` path |
| cargo-nextest | `6c2ab7e` | `list/test_list.rs:995` (`list.sort_unstable()`) before insertion; `partition.rs:213-219` (round-robin), `:264-265` (`xxh64`) | verified: both shardings are deterministic over sorted names |
| tokio | `cdd9dae` | `time/clock.rs:354-378`; `runtime/builder.rs:1196-1200` (`CurrentThread => true`) | verified: pause is current-thread-only; `start_paused` + `flavor = "multi_thread"` is a compile error |
| tokio | `cdd9dae` | `time/instant.rs:208-214` | verified: only `tokio::time::Instant` is virtual; `std` time is not |
| sccache | `1bd7432` | `compiler/rust.rs:1465` (`("incremental", _) => cannot_cache!`) | verified: incremental builds are never cached |
| cargo-chef | `dd01a86` | `skeleton/read.rs:46,74,79`; `recipe.rs:59-72` | verified: manifest round-trip that keeps `[profile.*]`; dependency-layer caching only |
| rust-cache | `f0d9c38` | `src/config.ts:73-130,156-260`; `src/cleanup.ts:62-79` | verified: tar cache of registry + `target/`, local crates purged |
| proptest | `70cf37d` | `src/test_runner/config.rs:157-177` | verified: 256 cases per test by default |
| cargo-mutants | `5c06912` | `src/lab.rs:179-193`, `src/cargo.rs:97-124` | verified: a full build + test run per mutant |
| insta | `4b270ba` | `src/runtime.rs:936-957`, `:502-515`, `:536-545` | verified: pass costs read+compare plus a `read_dir` and a `remove_file`, no write |
| wiremock | `6b19304` | `src/mock_server/pool.rs:21-32`; `exposed_server.rs:114` | verified: a pool exists and is "marginally faster"; a fresh server pays a connect probe |
| httpmock | `7014f7f` | `src/api/server.rs:90-95,1332-1349` | verified: one OS thread + one tokio runtime per server, pool capped at 25 |

Nothing here changes a recommendation: the three claims that would have flipped one — that
`test()` matches binaries, that `threads-required` serialises, and that sccache helps a warm
incremental loop — are all refuted by the code.

## 11. What the awesome lists actually contribute

Both Rust awesome lists were fetched at a pinned commit and every testing entry was checked against
the GitHub API for `archived` plus `pushed_at`.

| List | Commit | Testing entries | Verdict for speed work |
| --- | --- | --- | --- |
| [rust-unofficial/awesome-rust](https://github.com/rust-unofficial/awesome-rust) | `f778a80` | 38 under `### Testing` | Only `cargo-nextest` is a runner-speed entry. The rest are assertion, mock, property, snapshot, coverage, mutation or fuzz tooling. |
| [hoodie/awesome-rust-testing](https://github.com/hoodie/awesome-rust-testing) | `b95a8b8` | technique- and crate-oriented | Nothing new for wall time beyond nextest and `tokio`'s test clock. |
| [BurtonQin/Awesome-Rust-Checker](https://github.com/BurtonQin/Awesome-Rust-Checker) | `ec9675e` | static checkers, sanitizers, fuzzers | Diagnosis only. |
| [psFried/testing-rust](https://github.com/psFried/testing-rust) | `1be76a5` | example repo, last push 2019 | Reference material; no tooling. |

Findings that change nothing but are worth knowing before you follow a list:

- **`cargo-check` is misdescribed.** awesome-rust still lists it as a faster correctness check
  because it passes `-Zno-trans` (`cargo-check/src/main.rs:82`). That flag is a 2016-era nightly
  option; the crate was last published 2016-11-20. Use `cargo check`; the entry points at a dead
  mechanism.
- **`mockiato` is archived** (`mockiato/mockiato`, `archived: true`, last push 2024-05-31). It is
  still listed under Testing. Nothing here uses it.
- **`cargo-hack` is a coverage tool, not a speed tool.** `--each-feature` and
  `--feature-powerset` multiply the number of cargo invocations
  (`cargo-hack/src/features.rs:229-238`, `src/main.rs:586-618`). It is the right audit for feature
  unification; it will make the gate slower.
- **`cargo-chef`, `rust-cache`, `sccache`, `install-action`, `cargo-binstall`** are all real and all
  compile/CI-axis only. `sccache` explicitly refuses incremental invocations
  (`sccache/src/compiler/rust.rs:1465`), so it does nothing for a warm local test loop; `cargo-chef`
  is a Docker layer trick; `rust-cache` is a tar cache of `target/` and the registry that drops
  workspace-crate artifacts (`rust-cache/src/cleanup.ts:62-79`).
- **`proptest` defaults to 256 cases per test** (`proptest/src/test_runner/config.rs:157-177`); if
  it is ever adopted here, count that before blaming the runner.
- **`insta` is a fidelity improvement at neutral speed** — a passing assert reads and compares, and
  writes only under `INSTA_UPDATE=force` (`insta/src/runtime.rs:936-957`).

The only two entries from either list that move wall time for *this* suite are `cargo-nextest`
(§2) and `tokio`'s `test-util` clock, and the second only safely behind an injected `Pacer` (§5).

## 12. A real flake the faster run exposed

Running the suite under nextest at `-j 4` failed once, and the failure is a genuine defect in a
test, not in the runner. Worth recording because faster execution makes it *more* likely.

```
FAIL [   0.014s] chief-of-rust::terminal comparison_request_scores_direction_and_regenerates_on_save
thread ... panicked at crates/app/tests/terminal.rs:505:5:
assertion failed: reports[0].superseded
```

The test fetches both `comparison_report` rows and orders them positionally:

```rust
reports.sort_by_key(|r| r.created_at);
assert_eq!(reports.len(), 2);
assert!(reports[0].superseded);
assert!(!reports[1].superseded);
```

`created_at` is `crate::now_ms()` (`crates/app/src/terminal/comparison.rs:387`), i.e. **millisecond
resolution**. `Db::list` returns rows ordered `updated_at DESC, id` (`crates/app/src/store.rs:28`),
and `updated_at` comes from the same millisecond clock (`crates/app/src/store.rs:34`). When both
reports are written inside one millisecond, both keys tie and `sort_by_key` preserves the database
order, which then breaks on a random UUID. Whether the superseded report lands at index 0 or 1 is
a coin flip.

Confirmed deterministically by freezing the clock: with `now_ms()` pinned to a constant, the test
failed **24 of 32** consecutive runs. With the real clock it failed once in a full-suite `-j 4` run
and passed 60/60 in isolation. It is the same shape of bug on a fast machine as on a slow one, only
scheduled differently.

**Fix (applied):** assert on the report's identity, not its position —

```rust
assert_eq!(reports.len(), 2);
let current = reports.iter().find(|r| !r.superseded).expect("current report");
assert_eq!(current.second_version, 2);
assert!(reports.iter().any(|r| r.superseded && r.second_version == 1));
```

Verified under the frozen clock that previously failed 24 of 32 runs: 18/18 now pass (10 in the
probe copy, 8 more after the `unused_mut` cleanup). The old
assertion is also why the file is order-sensitive — it asserted `reports[1].second_version`, which
is only meaningful if the sort key is unique.

This is the one place where the speed work changed a *finding*: nextest's parallelism surfaced an
ordering assumption that the serial `cargo test` schedule had been hiding.

## 13. More methods: parallelism, sharding and multiple workers

Pinned: nextest `6c2ab7e` (binary 0.9.148), cargo master `3022244`, repo `cf80145`; (M) measured,
(D) documented/source, (E) derived estimate.

| Method | Mechanism | Expected effect here | Fidelity risk | Effort |
| --- | --- | --- | --- | --- |
| Local `--partition slice:1/2`, two processes | cross-binary round-robin after filtering (`partition.rs:42-54`, `test_list.rs:966-987`) | ~0, and measured 66 s vs 60 s wall | none | flag |
| `hash:1/2`; deprecated `count:1/2` | `xxh64(name)%N` per binary (`partition.rs:229-233`); count "worse than both" (`partitioning.md:61-65`) | ~0; uneven at 16-33 tests/binary | none | flag |
| `archive` + `--archive-file` | reuse skips cargo (`base.rs:395-403`) | (E) −40-60 s per extra shard | same source rev (`archiving.md:23,54`) | CI |
| GH `strategy.matrix` | one job per combination, 256 cap | wall ≈ slowest shard (still 20 s); N× billed minutes | none | CI |
| `cargo test -j`, `CARGO_BUILD_JOBS`, jobserver | compiler processes and build scripts only | 0 on execution | none | — |
| `JoinSet` of `run_once`, `flavor="multi_thread"` | N claims, one queue (`work.rs:120-135`); real workers ([tokio](https://docs.rs/tokio/latest/tokio/attr.test.html)) | interleaves then serialises on `Db` (`db.rs:13,57`) | none if jobs independent | ~10 lines |
| `--no-capture` | forces `test_threads = 1` (`runner/imp.rs:281-282,355-356`) | **negative**: stacks both poles | none | — |
| `--max-fail=1:immediate`; `--shuffle` | kills in-flight tests (`run.rs:200-206`); nightly `-Zunstable-options` ([rustc](https://doc.rust-lang.org/rustc/tests/index.html)) | failures shorter; shuffle 0 (diagnosis) | drops evidence | flag |
| sccache-dist; mold, wild | compile cache ([webdav](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md), [dist](https://github.com/mozilla/sccache/blob/main/docs/Distributed.md)); Linux/ELF linkers ([mold](https://github.com/rui314/mold), [wild](https://github.com/wild-linker/wild)) | 0 on test execution | none | large |

**Local sharding parallelises processes, not CPUs.** `--partition` applies after the build and all
filters, as a post-filter over listed tests (`partitioning.md:33`; `test_list.rs:384,444,925`),
marking the rest skipped (`partitioning.md:51`). `slice:` is one round-robin across all binaries
(`PartitionerScope::CrossBinary`, `partition.rs:74-88`; 0.9.127+ per `partitioning.md:16`). Two
shards run more test processes than one `-j 18` run, but the longest binary is 20.0 s of 20.4 s on
a fresh target dir, so cores are spare. The shared `target/` binds first: a build-intent cargo run holds
`.cargo-build-lock` exclusively (`src/compiler/layout.rs:265-281`) and `.cargo-artifact-lock`
(`build_runner/mod.rs:410-436`), printing "Blocking waiting for file lock"
(`src/util/flock.rs:432-441`); only nightly `-Zfine-grain-locking` relaxes it
(`tests/testsuite/build_dir_fine_grain_locking.rs:36`). Local shards overlap in execution and
serialise on the build: a CI tool, not a laptop tool.

**Sharding cannot beat the longest test.** A partition assigns whole tests; `terminal.rs:12` holds
~15 s of `sleep` (`collect.rs:250-263,1088`), so whichever shard receives it still takes 20 s.
`terminal_automatic.rs` is 33 spawns and costs 0.60 s on a fresh `deps` but 22.1 s on a bloated
one (§1(c)); on a fresh dir it is not a pole at all. A shard floors at `max(longest test, work / threads)`, so with a
20 s indivisible test N≥2 floors at 20 s.

**Build once.** `archive` writes cargo + binaries metadata, test binaries, dylibs, non-test
binaries and one-level `OUT_DIR`s (`archiving.md:33-50`; `archiver.rs:168,361-374`, zstd
multithreaded at `:331`); extraction is `reuse_build/mod.rs:83-125`. Rules from the clone's arg
tests: `--workspace-remap` needs `--cargo-metadata`+`--binaries-metadata` or `--archive-file`
(`dispatch/core/tests.rs:95-97,262-266`); `--archive-file` conflicts with both metadata flags,
`--target-dir-remap` and `--build-dir-remap` (`tests.rs:311-328`), and `--extract-to` /
`--extract-overwrite` require it (`tests.rs:295-307`). Archive mode returns the archived
`BinaryList` without invoking cargo (`base.rs:395-403,413-418`) and takes the graph from the
archive (`base.rs:80-97`): shards never re-enter cargo, but need the same source revision
(`archiving.md:23`), since archives exclude it (`archiving.md:54`).

**CI matrix.** `strategy.matrix` makes one job per combination
([run-job-variations](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations));
256 jobs max and `max-parallel` defaults to maximize
([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)),
and `strategy.fail-fast` cancels the whole matrix — set it `false` to match this repo's
`fail-fast = false`. Artifacts are the documented cross-job transport
([store-and-share](https://docs.github.com/en/actions/tutorials/store-and-share-data)). Each shard
bills its full duration: $0.006/min Linux 2-core, $0.062/min macOS 3-4-core
([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). The
workflow's `concurrency: ci-${{ github.ref }}` + `cancel-in-progress`
(`.github/workflows/ci.yml:13-15`) is run-wide, so a push cancels all shards. Each shard's
`junit.xml` needs a distinct artifact name; `report-skipped = "all"` would duplicate skips across
merged partitions (`junit.md:46`).

**Cargo `-j` is build-only.** "`--jobs` affects the building of the test executable but does not
affect how many threads are used when running the tests"
([cargo-test](https://doc.rust-lang.org/cargo/commands/cargo-test.html)); `CARGO_BUILD_JOBS` is
`build.jobs`, the "maximum number of compiler processes"
([config](https://doc.rust-lang.org/cargo/reference/config.html#buildjobs)). Cargo and rustc "use
the jobserver protocol … essentially a semaphore", one slot per build script
([build-scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html#jobserver)), carried
to subprocesses by `CARGO_MAKEFLAGS`
([env](https://doc.rust-lang.org/cargo/reference/environment-variables.html)). None reaches
libtest or nextest execution; nextest's `-j/--test-threads` merely aliases `--jobs` (help:226-231).

**In-test concurrency.** `claim()` runs one `Immediate` transaction (`db.rs:76`), expires dead
leases, selects `ORDER BY created_at,id LIMIT 1`, marks the row `running`, bumps `attempt` and
writes a `job_attempt` (`work.rs:120-135`); `run_once()` claims one job, dispatches, heartbeats at
30 s and finalises conditionally on `attempt` (`work.rs:138-186`). N concurrent calls take N
distinct jobs. The limit is `Db`: "One `rusqlite::Connection` behind a mutex" (`db.rs:1-4`),
`conn: Arc<Mutex<Connection>>` (`db.rs:13`); `with_conn` locks inside `spawn_blocking`
(`db.rs:50-63`, lock at `:57`) and says "Writers and readers serialize on the mutex" (`db.rs:49`);
`transaction` takes the same lock (`db.rs:66-80`). So the DB phase serialises and fan-out buys
overlap only across LLM/HTTP work between claim and finish. The runtime makes even that
interleaving: "The default test runtime is single-threaded"
([tokio](https://docs.rs/tokio/latest/tokio/attr.test.html)), and no test here passes
`flavor = "multi_thread"`. True parallelism needs that attribute and accepts the mutex, not WAL,
as the serializer.

Loops that fan out mechanically (own fixture and job per iteration): `runtime.rs:631-699` (three
providers, own `tempdir`/`MockServer`, `run_once` at `:673`); `meetings.rs:940-1004` (five
concurrency modes, own `TempDir`/app, `run_once` at `:974`); `public_research.rs:62-71,77-96`,
whose `run_isolated` (`:100-116`) already spawns a child. Loops that cannot:
`terminal.rs:466→497` and `:1034→1071` are ordered save-then-regenerate; `runtime.rs:203-204`
asserts an empty queue after one job; `runtime.rs:154→172` is failure-then-retry;
`meetings.rs:543→552` fails then succeeds after re-brief; `google_connection.rs:105-140` rewrites
fixtures per iteration.

**New, including negatives.** `--no-capture` forces serial execution and would stack the two poles
(the 20 s `sleep` and whatever the spawn cost happens to be). `NEXTEST_TEST_THREADS` is just `-j` (help:226-230), already measured as no help;
`NEXTEST_STATUS_LEVEL` is neutral (user 18.4 s vs 64.9 s wall). `--max-fail` conflicts with
`--fail-fast`/`--no-fail-fast` (`dispatch/core/run.rs:200-206`) and `:immediate` trades evidence
for time. `--shuffle` is nightly-only and "does not affect whether the tests are run in parallel"
([rustc](https://doc.rust-lang.org/rustc/tests/index.html)). Remote sccache is a compile cache:
`SCCACHE_WEBDAV_ENDPOINT` is a WebDAV store
([webdav](https://github.com/mozilla/sccache/blob/main/docs/Webdav.md)); `sccache-dist` servers
must be Linux/FreeBSD ([dist](https://github.com/mozilla/sccache/blob/main/docs/Distributed.md)).
mold lists ELF targets only ([mold](https://github.com/rui314/mold)); wild supports Linux with
Mach-O as future work ([wild](https://github.com/wild-linker/wild)). Custom profiles inherit
`default` unless `inherits` overrides
([configuration](https://nexte.st/docs/configuration/)), so `ci` already has `slow-timeout`.
`--no-tests` defaults to failing (help:293-302): an empty shard fails.

**What the measurements say about worker counts.** More workers do not help, because there is
almost nothing to distribute. On a fresh target dir the suite is **20.4 s, of which 20.0 s is one
`sleep`**; with `pace()` short-circuited the whole 236-test suite runs in **2.3–3.3 s**. `-j`
scaling on the bloated dir: 59.5 s at `-j 8`, 61.1 s at `-j 18`, 69.2 s at `-j 32`; and
`terminal_automatic` is flat at 24.3 / 24.0 / 22.4 / 22.2 s across `-j 2 / 4 / 8 / 18`. Two
concurrent `--partition` shards measured **66 s wall** versus 60.1 s for a single process on that
same dir (31.3 s and 35.8 s run serially) — shards redistribute the same spawn cost and re-pay the
build lock. The machine's 18 cores are already more than the work can use.

**The honest ceiling (measured).** `terminal.rs` is 20.0 s, 19.7 s of it pacing (0.31 s without);
`public_research.rs` 2.0 s; `terminal_automatic.rs` 0.60 s. With pacing removed the **whole suite
is 2.3–3.3 s measured** (three runs: 2.525, 2.311, 2.283) against 20.4 s today, so after the clock
injection `public_research.rs`'s 2.0 s and the remaining binaries are all that is left. No shard,
flag or worker count removes the `sleep`: it lives in the code under test.

**The single dominant change is injecting the pacing clock into `collect.rs`**: the largest
measured removable block (19.7 s of 20.4 s), and the only one that deletes the hard 20 s floor
every sharding strategy inherits. Nothing else here is close — sharding, worker counts and CI
matrices all redistribute test *processes*, and the suite has only ~2–3 s of non-sleep work to
redistribute. Second is housekeeping, not code: pruning `target/debug/deps`, worth 40 s *once* on
this checkout and nothing on a healthy one (§14).

## 14. Target-directory hygiene (the measured 40 s)

This is not a test-runner feature; it is the artefact behind the number that looked like one.

The 22.1 s spawn cost and half the whole-suite figure came from this checkout's
`target/debug/deps`: 432,506 entries, 66 GB, 128k stale `chief_of_rust-*` artifacts and 428k
`.rcgu.o` objects accumulated across builds. Exec cost scales with directory entry count
(0 / 20k / 100k / 300k → 0.02 / 0.03 / 0.17 / 0.47 s), and 33 spawns multiply it.
`cargo clean -p chief-of-rust` removes only this crate's artifacts and is the surgical fix;
`cargo clean` is the blunt one; both are local-only and change no test behaviour. `cargo clean`
"remove[s] the target directory, or with `-p`, only the specified package's artifacts"
([cargo clean](https://doc.rust-lang.org/cargo/commands/cargo-clean.html)); the nightly `-Zgc` is
Cargo's only garbage-collection mechanism and is not on stable
([unstable](https://doc.rust-lang.org/nightly/cargo/reference/unstable.html)), so on stable the
`deps` directory is append-only for every fingerprint it has ever built. Re-measure after any
prune, because a fresh `deps` makes the whole-suite number ~3x smaller and would otherwise be
reported as a regression.

**Reproduce it.** `ls target/debug/deps | wc -l`; then compare the same binary from `./target` and
from `/tmp`. The A/B that proves the mechanism is in §1(c).

## Appendix: reproducing the measurements

```sh
# baseline, per binary, serial
cargo test --workspace --locked

# same suite under nextest
cargo nextest run --workspace --locked

# the two binaries that behave in opposite directions
cargo test -p chief-of-rust --test terminal --locked
cargo nextest run --workspace --locked -E 'binary(terminal)'
cargo test -p chief-of-rust --test terminal_automatic --locked
cargo nextest run --workspace --locked -E 'binary(terminal_automatic)'

# the 20 s test, both harnesses (identical: it is sleep)
cargo test -p chief-of-rust --test terminal --locked gdelt_rate_limits_retry_once
cargo nextest run --workspace --locked -E 'test(gdelt_rate_limits_retry_once)'

# prove the nextest override is mis-targeted (returns 7 integrations::* unit tests)
cargo nextest list --workspace --locked -E 'test(integration)'

# per-test timings on stable (no nightly --report-time needed)
cargo nextest run --workspace --locked --status-level slow

# build-time attribution before/after any profile change
cargo test --workspace --locked --no-run --timings
```
