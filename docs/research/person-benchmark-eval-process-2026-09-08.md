# Standardizing the person-research benchmark loop

Research date: 2026-09-08. Question: the Person Research Benchmark loop (six
models × two modes × 30 Benchmark Persons, run and analyzed by hand) took two
days to reach a verdict. What established methods let us standardize the loop,
spend less, and still get the data needed to debug toward a result?

Method: five parallel research arms — awesome-list harvesting, harness
source-code deep dives, statistics from primary papers, CI/CD platform docs,
and community practice scans (HN/Reddit/Stack Overflow). Every load-bearing
claim below is cited to a primary source. Community threads are discovery
layer only; each tool they named was verified against its own docs.

## Decisions recorded (2026-09-08)

Grilled against this repo's constraints (manual tsx runs, artifacts kept
local, a hard OpenRouter ceiling), the five recommendations resolved as
follows. The benchmark program is ongoing: the next sweep runs when a
worthwhile model drops.

- **Adopted now:** the stats layer (§2 — per-person paired diffs, 95% CIs,
  auto-MDE, soft noise warnings), resume + cache (§4 — `--retry`,
  `--reuse-extraction`, judge-response cache keyed by judge version and
  repeat), and conditions by construction (§5 — git sha, seed,
  `system_fingerprint`, mode stamped into every report and artifact).
- **Adopted with parameters:** full-person K=2 on fixed-documents arms only
  (live arms stay K=1 — an 80-minute pass doubled is 2.7 hours); n stays 30
  and the printed MDE kills underpowered questions rather than a bigger
  corpus (§2.3).
- **Deferred:** the failure taxonomy + JUnit rendering (§6 — no CI consumer
  exists yet) and the baseline store (§7 — the storage home is undecided
  until arms accumulate; revisit at the next campaign).
- **Cost:** per-call token/cost rollup into the report plus a `--max-cost`
  abort (§8); OpenRouter reports cost automatically on every response, so
  the ledger is exact where it matters and `--max-cost` fails closed.
- **Deliberately not built:** extraction-response caching as always-on
  (a cached extraction is not a fresh sample — reuse is opt-in via
  `--reuse-extraction`, and only for persons a stamped, matching run
  recipe already completed).

Statistics before more runs (§2) remains the order of the day: the MDE at
n=30 is roughly 8–9 people, so any "fix" smaller than that is a coin flip
and the tooling now says so in plain words.

## Recommendation

Do not adopt a Python eval harness wholesale. Our driver is a 900-line
TypeScript script wired into this app's own LLM seam; the academic suites are
the wrong shape for a 30-person applied benchmark. Steal five mechanisms, in
this order — the first three need no new infrastructure and address the two
biggest time sinks (variance confusion and outage-contaminated re-runs):

1. **Statistics before more runs** (pain: variance swamps signal). Report
   paired per-person differences with a 95% CI, pre-register the minimum
   detectable effect in the acceptance issue, and repeat each person K=2 in
   fixed-documents arms. At n=30 a "fix" moving fewer than ~8 of 30 people is
   statistically undetectable — ship/verdict decisions on smaller deltas are
   coin flips, and re-running full arms hoping for a better number is the
   single largest waste in the current loop (§2).
2. **Resumability by manifest** (pain: outages contaminate arms). Keep the
   per-person JSONs as the sample buffer they already are, add a manifest with
   per-person status, and a `--retry` mode that runs only missing or failed
   persons and never overwrites successes. Add a content-keyed response cache
   (provider, model, request digest, judge version, repeat index) so judge
   re-scores after a judge fix cost pennies. This is inspect_ai's eval-retry +
   promptfoo's cache, both MIT (§4).
3. **Conditions by construction** (pain: silent condition drift). Extend the
   report header that now records routing and reasoning settings with: git
   sha, corpus hash (already present), judge id + prompt version, seed,
   `system_fingerprint` where the provider returns one, and document-set id
   for live arms. Rule: any change to these makes arms incomparable — the
   report should say so itself (§5).
4. **A typed failure taxonomy + JUnit rendering** (pain: ad-hoc Python
   triage). The reason codes and judge phases exist informally; make them a
   schema in `packages/shared`, and render one JUnit testcase per person per
   phase (classname = reason code) so any flaky-test/quarantine tooling works
   on evals unchanged (§6).
5. **Baseline store + record automation** (pain: /private/tmp + hand-written
   issue comments). Append per-arm summary JSON to a `bench-data` branch with
   an alert threshold and fail-on-alert gate (github-action-benchmark
   pattern), write the arm table to `$GITHUB_STEP_SUMMARY`, and publish one
   static HTML report per arm — GitHub artifacts with `if: always()` so
   interrupted runs still leave their partial report (§7).

Cost control falls out of 2 and 5: cache judge calls, smoke subsets (N
people) for pre-flight, full 30 only for verdicts, and a `--max-cost` flag
backed by per-call token/cost rows (§8).

## 1. What the loop looks like today (ground truth)

- Arm = 30 people × one model × one mode (`fixed-documents` ~11–15 min,
  `live-discovery` ~80 min). Driver: `scripts/person-research-benchmark.mts`;
  judge and report in `apps/server/src/person-benchmark/`.
- Observed over 2026-09-07/08: identical fixed documents and model gave
  12/25 vs 6/25 reference recovery across two runs; five arms were lost to
  provider 502/402 `http_error` in one day and had to be re-run at full
  price; interrupted runs leave no top-level report; acceptance was a manual
  comparison against a number recorded in a GitHub issue.
- Seven named pains, referenced below as (P1)–(P7): P1 variance swamps model
  differences; P2 no resume, outage contamination; P3 no baseline/regression
  store; P4 ad-hoc failure analysis; P5 results scattered, records manual;
  P6 cost untracked; P7 conditions drift silently.

## 2. Statistics for n=30 (P1, P3, P6)

Primary source for 2.1–2.5: Evan Miller, "Adding Error Bars to Evals"
(Anthropic), https://arxiv.org/abs/2411.00640.

### 2.1 Per-arm confidence intervals

Treat the 30 people as draws; SE = sqrt(sample variance / n), CI = mean ±
1.96·SE (for a binary rate, sqrt(p(1−p)/n)). Miller argues plain CLT beats
bootstrapping for means. Reported as `p (SE)` in every report, this alone
explains a 12/25-vs-6/25 swing as noise: at p=0.4, SE≈9pp, CI ≈ ±18pp.

### 2.2 Paired differences — free variance reduction

Same-30-people arms are correlated, so inference goes on per-person
differences `d_i = score_A,i − score_B,i`: SE_paired = std(d)/sqrt(30), and
any agreement on which people are hard shrinks the bar (variance drops by
2·Cov/n; −1/3 at corr 0.5). Recipe: never compare arm totals; z =
mean(d)/SE, |z| < 2 → noise. Store per-person diffs and corr(sA,sB) in the
baseline so any two arms are comparable post-hoc.

### 2.3 Minimum detectable effect — the pre-registered acceptance bar

δ_MDE = (z_{α/2}+z_β)·sqrt(var(d)/n) ≈ 2.8 × SD(d)/sqrt(30) at 80% power /
5% significance. With binary-ish diffs (SD≈0.6): δ_MDE ≈ 0.31, i.e. ~9–10 of
30 people. Rule: write "powered to detect ≥N-person swings" into the
acceptance issue before running (Card et al. show underpowered comparisons
are the NLP norm and exaggerate wins — https://arxiv.org/abs/2010.06595).
If the expected effect is smaller, widen n (more people) or shrink SD
(paired design, repeats) instead of re-running arms.

### 2.4 How many repeats K per person

Variance splits into question-sampling Var(x) + conditional noise E[σ²]/K.
K=1→2 cuts total variance ~1/3; K=4 ~1/2; ceiling 2/3. Per-person repeats
are naturally resumable (re-run missing cells). SE must be computed across
per-person means, never pooled across K·n correlated samples. Practical
default: K=2 for fixed-documents arms; K=4 only if repeat disagreement is
large relative to cross-person spread.

### 2.5 The thermostat cliff — do not "fix" variance with temperature 0

Miller §3.3: forcing T=0 rounds continuous difficulty into Bernoulli
outcomes — minimum variance triples and the expected score can shift. Both
Anthropic ("even with temperature set to 0, results will not be fully
deterministic", https://platform.claude.com/docs/en/about-claude/glossary)
and Microsoft/OpenAI (seed is best-effort; monitor `system_fingerprint`;
https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/reproducible-output)
confirm hosted inference is never deterministic. Recipe: pin one nonzero
temperature permanently as a recorded condition; reduce noise with repeats +
paired analysis; log (seed, system_fingerprint) per person and quarantine
cells whose fingerprint changed mid-arm.

### 2.6 Reusable SE code

lm-evaluation-harness ships closed-form `mean_stderr` (Bessel-corrected),
`bootstrap_stderr` for non-mean aggregates, and `pooled_sample_stderr` for
combining subset SEs — ~30 lines to port:
https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/metrics.py

## 3. Judge reliability (P1, P4, P7)

Primary source: Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and
Chatbot Arena", https://arxiv.org/abs/2306.05685.

- **Swap-twice rule (§3.4, Table 2):** GPT-4 was self-consistent across
  position-swapped pairs only 65–66% of the time (GPT-3.5 46%). Judge each
  comparison twice with order swapped; accept only agreement, else tie.
  Track the swap-inconsistency rate per arm as the judge-noise thermometer —
  if it exceeds the extraction effect size, fix the judge, not the model.
- **Noise floor and calibration (§4.2, Tables 5–7):** strong judges agree
  with human experts ~85% (≈ human–human 81%); agreement is ~70% on close
  pairs, ~100% on mismatched. **Reference-guided grading cut judge failure
  from 70% to 15%** — our judge already reads the reference dossier, which
  is the right design. Single-answer-vs-reference matches pairwise quality
  at 95–97%, so absolute per-person scoring stays.
- Recipe: pin one judge + prompt + version (already policy); keep a ~10-person
  human-labelled calibration set; on any judge change, report
  judge-vs-human agreement before accepting scores. Community corroboration
  and the "calibrate or drift" caution: https://news.ycombinator.com/item?id=47566753.
  Braintrust `autoevals` shows the wrapper pattern worth copying: scorers as
  importable functions returning `{score, metadata.rationale}`
  (https://github.com/braintrustdata/autoevals) — judge calls become
  unit-testable without a full arm.

## 4. Resumability and caching (P2, P6)

- **inspect_ai** (MIT, UK AI Security Institute) has the best resume design.
  `eval-retry` re-runs only failed samples and preserves completed ones;
  a sample-buffer DB plus `inspect log recover` recovers from crashes, with
  `--incomplete-action`/`--incomplete-max` to finalize hung samples instead
  of losing the arm; `fail_on_error` accepts bool/proportion/count so an arm
  tolerates bounded sample failure.
  https://inspect.aisi.org.uk/handling-errors.html
  Copy: per-person manifest `{person → status}`; `--retry` runs only
  missing/failed persons; a stalled-sample policy caps in-progress work
  before finalizing; arms get a `fail_on_error` proportion instead of
  all-or-nothing status.
- **promptfoo** (Apache-2.0, TS) defines the response-cache shape: disk cache
  keyed on provider + request digest + config, 14-day TTL, errors never
  cached, separate namespace per repeat index, `--no-cache` escape.
  https://www.promptfoo.dev/docs/configuration/caching/
  Copy for our judge (the cheap half of the bill) and later extraction:
  key = hash(provider, model, request digest, judge version, repeat index).
  lm-evaluation-harness has the same two layers (SQLite response cache +
  prompt cache): https://github.com/EleutherAI/lm-evaluation-harness.
- **Report split:** inspect_ai writes per-sample logs as the primary
  artifact and a header readable without samples
  (https://inspect.aisi.org.uk/eval-logs.html). Our per-person JSONs already
  are that buffer; the top-level report should be derived from them at any
  time — then an interrupted arm still reports its partial state (P2).

## 5. Conditions by construction (P7)

- What to record per arm (some already landed via PR #310/#311): git sha,
  corpus hash, judge id + prompt/judge version, model ids, temperature/seed,
  `system_fingerprint`, document-set id for live arms, and the retry/rest
  policy. lm-eval's results envelope (`configs`, `versions`, `n-samples`,
  `task_hashes`) is the reference shape:
  https://github.com/EleutherAI/lm-evaluation-harness.
- **Snapshot-before-compare** (Braintrust discipline): iteration configs are
  mutable; comparisons happen only against immutable, named snapshots.
  https://www.braintrust.dev/docs/evaluate
- **Live arms need hermetic snapshots:** persist the fetched-document set per
  live run so a re-run or judge-only re-score is hermetic; record the
  snapshot id in the report (BuildPulse flaky-evals playbook,
  https://buildpulse.io/blog/flaky-evals-non-deterministic-llm-tests).
  Fixed-documents arms already satisfy this; live arms are where drifted
  retrievals will silently masquerade as model differences.
- **Auto-stamping:** Langfuse's CI runner injects commit SHA/branch/job URL
  into every experiment by construction
  (https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd) —
  the pattern to copy locally: the driver stamps the report header itself,
  so conditions can never be forgotten.

## 6. Failure taxonomy as a schema + JUnit (P4)

- Codify the existing informal buckets (research conclusion codes, judge
  phase outcomes, boundary classifications) as a typed union in
  `packages/shared`, one failure record per person per phase with
  `{code, phase, detail, diagnostic}`.
- Render JUnit XML next to the markdown report: one `testcase` per person
  per phase, `classname` = reason code, failure message = diagnostic. Evals
  then flow through standard flaky-test tooling (quarantine, flip-flop
  detection, history) unchanged
  (https://buildpulse.io/blog/flaky-evals-non-deterministic-llm-tests;
  practitioner norm of treating evals as tests:
  https://news.ycombinator.com/item?id=48202658).
- **Quarantine + majority vote** for flaky persons: run flaky person-cases
  in a non-blocking job, vote over odd K, promote back when stable
  (same source). Deepeval encodes the same verdict semantics
  (flaky cases recorded, never blocking):
  https://deepeval.com/docs/evaluation-flags-and-configs.
- Giskard's detector-catalog shape (named, versioned checks emitting
  structured issue records) is the template for keeping the taxonomy
  versioned as the codes evolve: https://github.com/Giskard-AI/giskard-oss.

## 7. Baseline store, records, dashboard (P3, P5)

- **History branch:** benchmark-action/github-action-benchmark (MIT) is the
  minimal pattern: append each run's metrics to a JSON on a data branch,
  render a Chart.js trend page, comment on regressions past a threshold,
  fail the job on alert. Supports "bigger is better" custom metrics, which
  recovery rate is. https://github.com/benchmark-action/github-action-benchmark
- **Where the record lives:** GitHub Actions artifacts
  (`actions/upload-artifact` with `if: always()`) make interrupted runs
  leave their per-person files; `$GITHUB_STEP_SUMMARY` puts the arm table on
  the run page itself; one static HTML report per arm is publishable to
  Pages (inspect_ai's `view bundle` is the reference design,
  https://inspect.aisi.org.uk/eval-logs.html).
  https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow
- **Baseline aliases without a platform:** Weave's versioned objects with
  movable aliases (`production`) map onto plain files:
  `baselines/<mode>/production.json` + `<sha>.json` per arm; acceptance is a
  tag, not issue prose.
  https://docs.wandb.ai/weave/guides/core-types/evaluations
- **Gates:** Langfuse's `RegressionError(metric, value, threshold)` typed
  gate and PR-comment upsert is the merge-gate shape to copy if/when arms
  move into CI (https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd);
  promptfoo's CI guide shows the same contract with plain jq on a JSON
  report (https://www.promptfoo.dev/docs/integrations/ci-cd/).
- **Smoke vs full:** Braintrust runs `--sample N` on PRs and full suites on
  merge (https://www.braintrust.dev/docs/evaluate/run-in-ci). Our mapping:
  3-person smoke for driver/config changes, full 30 only for model
  verdicts; the 80-minute live arm stays scheduled/manual, never on PRs.

## 8. Cost accounting (P6)

- Record token in/out, estimated cost, and latency per extraction and judge
  call (plain structured rows or OTel-style spans; at our scale plain rows
  win — the OTel-vs-OpenInference semantic-conventions dispute adds nothing
  here: https://news.ycombinator.com/item?id=45398467). Roll up per arm;
  openai/evals shows the cheapest possible ledger (sum usage into report
  keys): https://github.com/openai/evals.
- Add `--max-cost`: inspect_ai has per-sample `--cost-limit` with a
  model-cost table (https://inspect.aisi.org.uk/options.html); the flag
  plus the cache from §4 turns "the outage ate another $5" into "resume
  cost $0.30".
- Stats protect budget too: §2.3's MDE says when another arm cannot answer
  the question at any price.

## 9. Tool landscape (verified against primary sources)

| Tool | License / model | Shape | Verdict for us |
|---|---|---|---|
| promptfoo | Apache-2.0, TS, ~25k★ | eval runner + cache + CI | Best TS-native harness; adopt its cache/CI patterns; our agentic pipeline does not fit its prompt-matrix model directly |
| inspect_ai | MIT, Python, ~2.7k★ | eval framework + logs | Copy resume/log design; do not port the driver to Python |
| lm-evaluation-harness | MIT, Python, ~14k★ | academic benchmark suite | Copy stderr code + results envelope only |
| deepeval | Apache-2.0, Python, ~18k★ | pytest-style evals | Copy verdict/flaky semantics; wrong runtime |
| openai/evals | MIT, Python, ~19k★ | registry + recorder | Copy event/ledger simplicity; archived-style |
| Agentrial | MIT, Python, ~19★ | agent evals + CIs | Copy the statistics (Wilson CIs, Fisher gates); too new to adopt |
| Langfuse | MIT core, self-host, ~34k★ | tracing + experiments + CI gates | Only if we want a hosted dashboard; static artifacts + data branch cover current scale |
| Opik | Apache-2.0, ~22k★ | observability + evals | Same as Langfuse |
| Phoenix | Elv2, ~11k★ | OTel tracing + evals | Span schema reference only |
| Braintrust / LangSmith / Weave | SaaS | experiments + gates | Stage discipline and gate contracts are the steal; no vendor dependency needed at current scale |
| autoevals | MIT, TS+Python | scorer library | Scorer-as-function wrapper pattern for our judge |
| github-action-benchmark | MIT, ~1.2k★ | CI history + alerts | Adopt the storage/gate pattern on a `bench-data` branch |

## 10. Folklore check (contradictions found in the scan)

- **"temperature 0 makes evals deterministic."** False per Anthropic's
  glossary, Microsoft's reproducibility doc, and Stack Overflow/Reddit
  threads on the same question
  (https://stackoverflow.com/questions/75946090/why-is-gpt-4-giving-different-answers-with-same-prompt-temperature-0).
  Even BuildPulse's post that prescribes T=0 concedes it "won't give you
  byte-identical outputs". Design for sampling: repeats + paired stats (§2).
- **"Newer judge model is always better."** Practitioners report quality
  drops across same-provider version bumps; the baseline-gated camp wins —
  swap judges only with the calibration set from §3 and a recorded baseline.
- **"Bigger eval frameworks fix reliability."** The Anthropic long-running
  agents thread reports the last 10–20% of reliability coming from complex
  frameworks at hundreds of dollars per run
  (https://news.ycombinator.com/item?id=46081704); the evals-FAQ consensus
  is error-analysis-first with baselines
  (https://news.ycombinator.com/item?id=44430117). Our loop's problems are
  process problems (resume, stats, records), not missing-framework problems.

## Sources

Statistics: https://arxiv.org/abs/2411.00640 (Miller/Anthropic);
https://arxiv.org/abs/2010.06595 (Card et al.); HELM Lite seeds note
https://crfm.stanford.edu/2023/12/19/helm-lite.html.
Judging: https://arxiv.org/abs/2306.05685 (Zheng et al.).
Determinism: https://platform.claude.com/docs/en/about-claude/glossary;
https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/reproducible-output.
Harnesses: https://github.com/promptfoo/promptfoo (+ /docs/configuration/caching,
/docs/integrations/ci-cd, /docs/integrations/github-action);
https://github.com/UKGovernmentBEIS/inspect_ai (+ inspect.aisi.org.uk
/eval-logs.html, /handling-errors.html, /options.html);
https://github.com/EleutherAI/lm-evaluation-harness (+ lm_eval/api/metrics.py);
https://github.com/confident-ai/deepeval (+ deepeval.com/docs);
https://github.com/openai/evals.
Platforms: https://www.braintrust.dev/docs/evaluate (+ /run-in-ci);
https://langfuse.com/docs/evaluation/overview (+ experiments-ci-cd,
experiments-via-sdk); https://docs.langchain.com/langsmith/evaluation;
https://docs.wandb.ai/weave/guides/core-types/evaluations;
https://github.com/comet-ml/opik; https://github.com/Arize-ai/phoenix;
https://github.com/benchmark-action/github-action-benchmark;
https://github.com/Giskard-AI/giskard-oss;
https://github.com/braintrustdata/autoevals.
CI platform: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow.
Community (discovery layer): HN 46081704, 44430117, 47566753, 48202658,
45398467, 37157323, 36358093; https://buildpulse.io/blog/flaky-evals-non-deterministic-llm-tests;
Stack Overflow 75946090, 76855624; r/LLMDevs threads on determinism and
judge spend (login-walled; used as pointers, verified via primary docs).
