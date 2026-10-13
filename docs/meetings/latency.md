# Meeting debrief latency, cost and accuracy

Local implementation and measurements verified, October 13, 2026. Final
Jev gate escalations were resolved by stronger source and evidence reviews;
publication checks accompany the pull request. Baseline main:
`86f8f3721e4167ca609d8112f461efa1c56d3cdd`. Work is isolated from the user's
old walking-skeleton checkout and its five edits.

## Scope and acceptance criteria

The request is to optimize the 17-minute debrief, compare alternatives with
Jev, and benchmark latency, cost and accuracy on real transcripts without
weakening evidence checks. No model, dependency, account or service is added.

| ID | Requirement / stable comparison | Evidence and disposition |
| --- | --- | --- |
| L1 | Reduce long-workload elapsed time while retaining every source segment | Original serial 1,073.198s; scheduling-only 412.483s; release 247.307s. Tested on the identical snapshot, not a population latency claim. |
| L2 | Keep screening, citations, ownership/deadlines, contradiction/answer checks, deduplication and capture fences | Ten policy functions unchanged; original reconciliation questions and thresholds unchanged. Fulfillment is an additive check. |
| L3 | Bound work, preserve source order, fail closed, preserve partial evidence | Actual worker fixture varies 1/2/4 and clamps 0/99; provider failure drains tasks, preserves source-linked traces and saves no artifact. |
| L4 | Measure cost rather than infer it from latency | Response-reported Jev; token-price Mistral estimates. Unknown cost stays null. Failed-run checkpoint usage is incomplete. |
| L5 | Measure source fidelity and useful coverage separately | Predefined real-excerpt facts and negative controls; manual source review; exact citation checks. Supported-item counts are not accuracy. |
| L6 | Verify the final project path and preserve compatibility | Cargo gates, real worker/DB benchmarks, production image build/boot/restart. New saved timing fields use defaults for older artifacts. |

The initial experiment isolated scheduling: unchanged model, prompt, schema,
12KB chunks, overlap and extraction limits. Source review then justified two
additional fidelity changes (F2/F3); their final benchmark is reported
separately. Thresholds were never lowered. This is a revision of experiment
scope prompted by concrete evidence, not a replacement of the original
latency comparison.

Working budget: initially approximately 64 fresh Mistral segment calls, two long runs
plus the existing serial reference, three small comparison phases and a
recorded-extraction replay with fresh Jev. Reserve local checks, reviews and
gate capacity. No unchanged retries are used to obtain approval; failed runs
are retained in the comparison.

## Changes and findings

**F1 — serial network latency, confirmed defect in usability.** The recorded
19-segment run spent 1,040.988 summed seconds in Mistral and 31.462 in Jev,
with 1,073.198 seconds elapsed. Segment extraction median was 52.220 seconds
(12.488–113.372). The hypothesis that independent calls dominate latency is
falsifiable by overlap measurements. The original worker fixture failed with
peak one and 615ms; the scheduling implementation passed at peak four and
192ms. Final controlled six-segment measurements were roughly 600/312/187ms
for 1/2/4, with source ordering and downstream checks asserted. Fixture
timings establish scheduling, not live model speed or semantic accuracy.

The implementation runs bounded segment screen → Mistral extraction → Jev
audit chains in a Tokio JoinSet, restores original index order, then performs
all-source reconciliation and the existing final checks. A failure aborts and
drains sibling futures before returning. Upstream work already received may
still incur charges. Set `MEETING_SEGMENT_CONCURRENCY=1` for serial or `2` for
lower load; default and maximum are four. Account-specific provider limits
still apply. **Disposition: fixed and verified.**

**F2 — already fulfilled work remained an outstanding proposal, confirmed
source-backed defect.** In the scheduling-only real run, an offer to send a
link and acceptance became a capturable action even though the next exchange
confirmed the link was in chat. Jev verification flagged the interpretation
but had low same-subject/confidence signals; direct source inspection resolved
the narrow finding. A separate Noul now asks whether the same full action was
fulfilled after the cited commitment, distinguishing earlier completion,
unrelated work, partial progress and renewed requests. It uses the existing
0.15 review / 0.85 exclusion policy and retains raw source-linked signals.
No Task is marked done. The original reproduction failed before and passes
after. In the controlled replay, the identical real candidate changed from
supported/capturable to needs-review/noncapturable at fulfillment probability
0.26. The final fresh extraction also leaves that source-span action
noncapturable, through its local audit; do not attribute that fresh result
solely to the new fulfillment question. **Disposition: fixed and verified for
the demonstrated case; general semantic chronology remains fallible.**

**F3 — candidate owner/scope mistakes, demonstrated model failure.** One small
run assigned an individual owner to team-completed work; strict ownership
checks correctly held the facts for review. Another added a reporting-back
step to a narrower promise. The extraction prompt now distinguishes reporter
from performer, requires actual JSON null, and forbids unspoken extra steps.
It preserves the strict downstream audits. A Jev audit flagged the extra-step
candidate; its format/incompleteness signals also reflect the narrow audit
request and do not independently prove the source claim wrong. Source review
is the primary evidence. **Disposition: prompt improvement implemented;
final empirical results below establish its limited benefit.**

**F4 — unknown cost was counted as zero, confirmed measurement defect.** A
reviewer reproduced an $8 combined estimate despite missing Jev cost. The
helper now returns null with `jev_cost_known=false`; unknown checkpoint costs
remain unknown in either order. Four synthetic known/unknown probes pass.
**Disposition: fixed and verified.**

## Live measurements and limitations

All runs use the native Rust worker and disposable SQLite Workspace, Mistral
Large 4 and TypeSafe `typesafe/jev-1.13` through existing configured providers.
Private sources and full model outputs remain outside Git. The unavailable
original corpus directory was not recreated: authorized saved September 4
and July 3 snapshots supply the experiments. The user-excluded September 2
transcript is not used. No corpus-wide recall or audio/tone truth is claimed.

The long snapshot is 156,994 bytes; SHA-256
`d9727fa7c8d9cbde2b0b3da8c24f37a4bd0b2386467c52c3ba4b834b9f8f229e`.
All recorded long runs use the identical persisted text, 2,125 spoken lines, 19
segments and 19 extraction calls. The serial reference is historical, on the
same local platform and model; it is not a simultaneous controlled trial.

| Long snapshot | Elapsed | Mistral tokens in / out | Jev tokens in / out | Jev reported USD | Estimated combined USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Serial reference | 1,073.198s | 83,832 / 21,623 | 1,111,150 / 37,807 | 0.046668 | 0.148866 |
| Scheduling only, four | 412.483s | 83,642 / 26,711 | 1,279,877 / 39,938 | 0.053755 | 0.166457 |
| Fulfillment/prompt, before date enum, four | 360.806s | 84,763 / 24,312 | 1,320,699 / 44,638 | 0.055469 | 0.163920 |
| Release with source dates/null-only type, four | 247.307s | 85,067 / 21,974 | 1,314,719 / 46,314 | 0.055218 | 0.158989 |

Release elapsed time is 4.340× faster (76.96% shorter). Segment-stage elapsed
time is 221.533 seconds. Summed Mistral duration is 774.083 seconds; summed
Jev duration 35.483 seconds. These sums overlap and are not wall time. Final
152 records comprise 77 supported, 59 needing review, 15 invalidly cited and
one contradicted; eight proposals. Every supported quotation matches its
original source ID, range and text in an independent deterministic check.
This is citation integrity, not semantic factual precision.

Estimated combined cost rose about 6.80% against the reference. Fresh
generation is nondeterministic: output tokens and supported candidate count
changed; reconciliation calls rose from 95 to 114, and fulfillment adds
questions to those batches. Speed does not mean fewer tokens or lower cost.
Mistral does not report billing cost in this response. Estimates use current
[Large 4 list prices](https://docs.mistral.ai/models/mistral-large-4-0), fetched
October 13: $0.68 input / $2.09 output per million, without assuming cache
discounts. Actual invoices, account discounts and cancelled requests are
unverified. [Provider limits](https://docs.mistral.ai/admin/billing-usage/usage-limits)
vary by account and model.

The four-excerpt benchmark combines independent source passages from two real
meetings, explicitly a fixture collection rather than one complete meeting.
Positive reference targets were set before outputs: two reported completed
deliverables, a named relative-deadline follow-up, and a clarified scheduling
rule as a meeting statement. Five negative controls check invented completed
outcomes, an unaccepted testing assignment, an answered question remaining
open, inferred absolute dates and invented individually assigned deadlines.
Labels are source-reviewed by one coding agent; Jev helps challenge them but
is not independent corroboration. Precision is separately reviewed against
each passage. This small set cannot measure universal accuracy or calibration.

The first phase retains failures: serial stopped at 55.404 seconds for an
internally inconsistent Jev Choice (winner p0.43 vs another option p0.44);
four stopped at 1.032 seconds for screening p0.25. Both saved zero artifacts.
The successful two-mode run took 158.809 seconds. Known checkpoint cost for
failed runs is only a lower-bound measurement, with missing rejected or
cancelled response usage. The harness records every mode before failing its
overall assertion, so a successful sibling does not hide a failed Run.

After adding fulfillment but before clarifying extraction, all three modes
completed: one 180.618s, two 76.902s, four 53.176s. Four is 3.397× faster than
one on this batch. Four's source-fidelity errors prompted F3; faster execution
is not permission to call those outputs accurate. One repetition per mode,
fresh provider variability and different generated candidates limit causal
attribution. Some local checks and a separate fresh-Jev replay overlapped the
later modes; the four-mode measurement finished before that replay began.

The clarified-prompt four-mode run completed in 53.244s; all four reference
facts were recovered and five negative controls passed. Source review found
13 clearly faithful supported statements and one compound past/future
statement whose temporal scope is ambiguous (strict precision lower bound
13/14, not proof of 100% accuracy). Its serial sibling failed at 40.685s
because the model returned the string `"null"` as a date. That failure is
retained and motivates the final source-date schema correction F5 below.
It is not a successful serial latency observation.

**F5 — schema permitted string-null or invented deadlines, confirmed
structural failure.** The real serial reproduction above rejected an invalid
candidate after expensive generation. Due values are now constrained to JSON
null or the complete set of valid literal ISO dates present in spoken segment
lines. A regex shape alone would still permit invented dates. Existing
calendar parsing, exact presence and Jev date-to-work association remain
mandatory. No date coercion or relative-date inference is introduced. Jev
selected the source enum p0.96 (confidence0.95), with no contradicted selected
requirement. The regression rejects invalid calendar dates, duplicate values
and metadata-only dates while retaining every valid spoken date. Unicode/no-date holdouts
yield actual JSON null only. This new
evidence justified expanding the budget by up to 27 generation calls for a
final full run and matched short serial/four comparison. A further 19-call discriminating
long experiment verifies the equivalent null-only type declaration; one
small synthetic control verifies a positive ISO-date branch. Disposition and
final measurements: verified. Both source-enum excerpt modes completed: serial
141.473s / estimated $0.016208, four 77.753s / $0.014833 (1.819× speedup).
Both recover all 4 reference facts and pass all 5 negative controls. Manual
source fidelity is 17/18 supported statements in serial (94.4%) and 13/13 in
four (100% on this small sample). Serial added an unspoken opening condition;
Jev flagged the claim but low same-subject probability kept its result at
review. Direct source inspection supports the bounded manual label. This
remaining model error is retained as an accuracy limitation, not silently
counted correct. No claim of general 100% accuracy is made.

The initial long source-enum run failed at 188.988s on malformed JSON after
15 extraction checkpoints, with zero artifacts. The provider did not return
a conforming object; the cause is unresolved. The release schema declares
`type:null` where the only allowed date value is null, eliminating an
impossible string branch. This preserves the allowed-value set; it is not
proof the earlier nullable type caused the malformed response. Jev favored
that simplification p0.99 over adding automatic retries; two nonselected
requirement judgments were contradicted by direct code reasoning (retaining
the parser or retrying only before strict validation would still fail closed).
The next fresh release long run completes at 247.307s. No malformed JSON was
repaired, no new retry machinery added, and the failed attempt is preserved.
The short source-enum accuracy comparison precedes this equivalent null-only
type declaration; the final long run and explicit-date live control exercise
the actual release schema. The explicit-date control completes in 10.157s,
with one supported proposal and a real source ISO date. Provider variability
and grammar conformance remain limitations; one passing run is not a guarantee.

## Evidence ledger, experiments and decisions

| ID | Evidence / experiment | Consequence |
| --- | --- | --- |
| E1 / X1 | `scheduling-before.log`, `scheduling-after.log`, `scheduling-final.log` | Red/green through actual worker; restore order, cap work and clamp configuration. |
| E2 / X2 | `long-4.log`, `metrics-pre-final.json` | First fresh scheduling-only workload confirms overlap benefit; cost/accuracy remain separate. |
| E3 / X3 | `excerpts-r1*.log`, private output hashes in metrics | Retain operational failures; no validator relaxation or source-screen bypass. |
| E4 / X4 | `excerpts-r2-final-policy.log`, source label verification | Compare 1/2/4; discover owner and extra-step errors. |
| E5 / X5 | `fulfilled-before.log`, `fulfilled-final.log`, `fulfilled-replay-target.json`, `replay-final.log` | Regression plus recorded real candidates/fresh Jev; no fresh-Mistral speed claim for replay. |
| E6 / X6 | `long-release-4.log`, `metrics-release.json` | Fresh release model path with all final evidence checks; `long-final-4.log` and `metrics-final-long.json` are the intermediate fulfillment/prompt phase. |
| E7 / X7 | `metrics-unknown-cost-before.json`, `metrics-unknown-cost-after.json` | Missing prices stay null; positive and negative controls pass. |
| D1 | Jev selected bounded parallel processing p1, no escapes or contradicted selected requirements | Retain chosen model/12KB segmentation; larger chunks previously timed out, smaller model has no matched accuracy evidence. |
| D2 | Jev mechanism comparison: evidence-policy same p1; scheduling contradiction p0.95; overall review confidence0.16 | Mechanisms differ in scheduling; prose agreement is not runtime proof. |
| D3 | `fulfilled-decision.json` selected additive check p1; `fulfilled-source-verification.json` preserves low-confidence source signal | Root source review resolves the narrow fulfillment finding. |
| D4 | `prompt-experiment-judgments.json` selected clarification p1; separate audit flagged scope | No automatic metadata erasure, threshold lowering or forced model approval. |
| D5 | Standards/Spec review and follow-up raw judgments | All broad model patch reviews escalated; stronger source/record inspection resolved concrete concerns. |

All named evidence lives in `docs/meetings/evidence/latency/`. Phase-one policy
hashes are historical in `evidence-policy-invariance.json`; final additive
policy comparison is `evidence-policy-release.json`; the earlier `evidence-policy-final.json` is
 the intermediate fulfillment/prompt phase. Console logs and review prose remove trailing whitespace only; original byte
hashes and recoverable copies are recorded in `log-whitespace-provenance.json`.
Full private outputs are
under the original private research directory recorded in the teardown; hashes
link them without publishing meeting prose. The TypeSafe live API and fan-out
docs were fetched via curl after web retrieval failed, screened (review p0.35)
and inspected as reference data. Examples were not executed as instructions.
Existing native HTTP integration and Tokio are retained; Cargo manifests and
lockfile do not change. No new credentialed execution dependency is introduced.

The first whole completion gate exceeded the provider token budget and
returned an error, providing no approval. Three bounded gates retain the actual
code, test and report diffs in `final-gate-a.json`, `final-gate-b.json` and
`final-gate-c.json`. All escalated, with safe-to-apply probabilities 0.34,
0.36 and 0.29. Gate C verified the qualified timing, cost and accuracy claims
at confidence 0.97, 0.95 and 0.95. Unsupported code/test/doc claims in the
verification branches lacked the source witnesses supplied to the separate
patch-review branches. Gate A's timing contradiction had confidence 0.22 and
omitted the historical reference. Stronger current-source, assertion and
measurement inspection resolves those specific concerns without treating the
gates as automatic approvals; see `final-gate-spec-resolution.md` and
`final-gate-standards-resolution.md`. The concrete stale intermediate-run link
found during that inspection is corrected in E6. Original errors, distributions
and unfavorable signals remain preserved.

## Verification and remaining coverage

`cargo fmt --all -- --check`,
`cargo check --workspace --all-targets --locked`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`, and
`cargo test --workspace --locked` pass. The current whole-suite log has
94 passed, zero failed, nine opt-in live tests ignored. Real checks are invoked
separately with their specific Cargo filter; ignored tests are not green live
coverage. `verification-*.log` holds current output; earlier logs remain historical.

Production checks use isolated Compose project `chief-meeting-evidence`, port
55318: build app; `up -d --wait`; `python3 scripts/smoke.py` over all five product
pages, health and Task creation; restart; then smoke `--verify-persistence`.
The final image build and boot/restart checks pass. No production deployment,
outbound meeting message or unrelated container/volume change was made.

Reproduce live full runs with `MEETING_CORPUS_FILE` and an absolute private
`MEETING_EVAL_OUTPUT`, using `cargo test -p chief-of-rust --test meeting_corpus
live_meeting_corpus --locked -- --ignored --nocapture`. Excerpt comparisons use
`MEETING_BENCH_CASES`, fresh private `MEETING_BENCH_OUTPUT_DIR` and
`MEETING_BENCH_MODES`, then the same Cargo command with
`live_meeting_latency_benchmark`. Run `scripts/meeting_benchmark_metrics.py`
with explicit price flags over the saved outputs to reproduce numeric summaries.
The native worker/DB path is live; synthetic scheduling/provider failures and
manual labels have the limits described above.

Tested: bounds/order, cancellation/failure artifact exclusion, source-linked
checkpoints, original citation/ownership/date/uncertainty fences, final real
long pipeline and downstream reconciliation, production image and restart.
Partially tested: provider variability, semantic accuracy/recall, all-source
chronology and redaction. Untested: provider tail latency, account-specific
rate saturation, concurrency above four, broad corpus accuracy, audio tone,
other platforms and production account behavior. Access-limited: original
corpus directory; private snapshots remain reproducible in this environment.
These nonessential gaps do not imply exhaustive coverage or perfect judgments.
