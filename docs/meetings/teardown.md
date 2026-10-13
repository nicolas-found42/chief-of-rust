# Meeting debrief teardown and verification

Target: `chief-of-rust`, isolated branch `feat/meeting-debrief-evidence`, from
main `e0f69d21bd2c772dc259ba6c79e8334ca47ce2f3`. Investigation date: October 13,
2026; macOS arm64, installed stable Rust, Cargo, Docker Desktop and Chrome.
The original walking-skeleton checkout's five user edits were preserved.
The [request and stable acceptance criteria](review-request.md) describe scope.
Local implementation, verification and stronger review of the final Jev gate
concerns are complete within the stated coverage. Current-head CI and merge
are recorded by the associated PR; they are required before task completion.

The implementation produces source-backed topics, decisions, future commitments,
reported completed work, unanswered questions, risks and suggestions. It judges
written tone, tension, source usability and finding importance. Mistral Large 4
proposes cited candidates; TypeSafe/Jev supplies typed judgments. Rust validates
source values, composes uncertainty gates, records evidence and owns all writes.
Only supported current actions can be captured, then accepted separately in Tasks.
Completion reports can suggest a related Task without changing its status.

## Findings and dispositions

Each finding is one independently fixable issue. Severity describes demonstrated
impact in the tested workflow, not an assertion about frequency or all users.

| ID | Type / impact | Evidence strength | Change / disposition |
| --- | --- | --- | --- |
| M1 | Capability gap: debriefs lacked inspectable source evidence and typed sections | Source inspection; real baseline artifact | Structured candidates, exact quotes, line links and seven sections; implemented and regression tested |
| M2 | Confirmed defect: unsupported actions and normalized date in fragmented dialogue | Real baseline; bounded source audit; sparse control | Separate commitments/completed/suggestions, audit ownership/deadlines, retain relative phrases and uncertain findings; sparse reproduction corrected |
| M3 | Reliability risk: fluent unsupported candidates could become proposals | Real wrong-quote/ambiguity probes and router fixtures | Deterministic citation plus Choice/Noul gates and capture binding; fixed and verified in stated cases |
| M4 | Capability gap: segment-local promises/questions can be superseded elsewhere | Explicit retraction/answered controls; source analysis | Check every segment for counterevidence and actual answers; supported candidates cannot skip this stage |
| M5 | Capability opportunity: repeated findings and reported completion needed consolidation/Task selection | Live synthetic policy holdout | Semantic duplicate signals preserve records; Choice plus existence Noul has no-match; no Task status mutation |
| M6 | Demonstrated friction: long/schema failures lost useful stage visibility | Several real failures | Smaller bounded segments, schema mode, strict fenced-JSON parsing, durable stage traces and usage; failures retained without partial artifacts |
| M7 | Demonstrated failure: final long reconciliation returned HTTP 400 | 19 successful extraction/audit stages followed by real failure | Narrow downstream evidence projections and smaller batches; recorded replay and fresh full long run passed; exact original provider cause unresolved |
| S1 | Confirmed defect, P2: early overlap discard suppressed a later supported or differently attributed finding | Old-code failing regression; corrected durable result | Remove early discard; consolidate only after reconciliation, retaining both records; fixed and verified |
| S2 | Confirmed defect, P2: capture merged distinct same-title proposals | Router reproduction saved one Action Item instead of two | Capture source identity includes the selected proposal ID; preserves ownership/deadline and idempotency; final regression passed |
| H1/H2 | Low-impact maintainability heuristics | Exact source search and review | Shared section catalog; unused measured-JSON method removed |

M1 basis: a debrief must allow the user to inspect where an outcome came from.
Previously, a free-form artifact/action list did not bind findings to original
source lines. A competing explanation is that prose alone is adequate for a
casual summary; it does not satisfy this request's verification and action-review
requirements. The discriminating test is a false quotation with an otherwise
confident action: it must remain excluded and cannot expose a capture control.

M2 reproduction: run the original debrief against the 5,678-byte sparse source.
The old workflow took 29.817 seconds and returned three proposals, including an
unsupported `2026-04-14` deadline. A number mentioned in fragmented speech could
be relevant context; it does not establish a dated future assignment. Jev's
bounded audit signaled wrong deadline/action interpretation at 0.91/0.94;
separate claim verification remained less decisive and was preserved. Source
inspection and the later empty-result behavior resolve the narrow reproduction,
not general date accuracy. The revised sparse runs returned no proposals.

M3 acceptance: an exact quote must occur within the cited original source lines;
wrong source IDs, wrong lines, invented quotes and redacted spans fail. Support
probability must reach 0.85 and support/category confidence 0.80; owner/deadline
signals must reach 0.85 where proposed. Importance never compensates for a failed
evidence gate. Fixtures demonstrate policy/persistence; real labeled controls
provide separate semantic evidence. These thresholds are conservative choices,
not measured universal calibration guarantees.

M4 acceptance: a later withdrawal or actual answer prevents promotion as a
current action/open question. Silence is not counterevidence. All segments are
checked for each consequential supported finding. Counterevidence at least 0.85
excludes it, above 0.15 requires review. A deliberately ambiguous relative-date
case remained reviewable at counterevidence 0.19 despite locally strong support;
this records conservative friction rather than claiming perfect recall.

M5 counterevidence: similar wording can describe distinct work; a reported
completion can match no existing Task. The live holdout retained a distinct
checklist-review action, consolidated one paraphrased email action and returned
no-match for unrelated completion. The initial Task-match expectation used an
unassigned Task and failed; the owned-work control corrected that unsupported
harness assumption. Original failure logs remain; those early assertions did
not save every raw judgment. No threshold was lowered to obtain a match.

M6/M7 counterevidence: HTTP 400 alone does not prove a context-limit error.
The exact provider cause remains unestablished. Full finding records included
prior judgments, and accumulated traces are neither independent source evidence
nor necessary state. Narrowing them also avoids confidence anchoring. The
replay verifies changed downstream behavior using authentic saved extraction
replies, not fresh Mistral generation. A full fresh run is a separate check.

S1's strongest counterevidence was that provider traces preserved both drafts.
That reduced evidence-loss scope but did not correct the visible debrief or
proposal suppression. The [original-code regression](evidence/overlap-before.log)
fails with one record instead of two. The [corrected suite](evidence/overlap-regression-final.log)
retains uncertain→supported overlap, distinct ownership/deadlines and linked
duplicate records. See the [Spec review](evidence/spec-review.md) and
[Standards review](evidence/standards-review.md) for independent source review.

S2 reproduction extends S1 through capture: two independently supported,
same-title proposals with different owners/dates, captured twice each, must save
exactly two Action Items. The [old capture result](evidence/capture-attribution-before.log)
saved only one and marked both proposal IDs approved. Existing title-based
deduplication explained the failure. New structured debrief captures use
`artifact_id:proposal_id`; historical artifacts retain their original source
identity. Existing captured records are not rewritten. The model judgments in
this regression are explicit fixtures; the assertion tests durable write policy.

## Coverage map and evidence ledger

“Tested” means the listed workload passed, not exhaustive coverage. Format
coverage, semantic precision and extraction completeness are separate measures.

| Requirement | Coverage | Evidence → decision/change → verification |
| --- | --- | --- |
| R1 Spoken evidence, provenance, formats | Tested formats; partial semantic corpus coverage | E1 → D1 dialogue-only extraction → parser/quote tests and E2 |
| R2 Useful debrief categories and dates | Tested labeled controls; broader accuracy unmeasured | E3/E4 → D2 schema plus typed audits → five-category control and relative/date controls |
| R3 Reviewed current actions | Tested HTTP/worker/browser cases | E5 → D3 strict promotion/capture binding → false quote, uncertain, retracted, stale source, durable idempotency tests |
| R4 Tone and uncertainty | Tested text pipeline; actual emotions excluded | E4 → D4 segment Choice/Score with raw distributions → browser result and fixture contracts |
| R5 Cross-segment reconciliation | Tested replay/fixtures and one fresh long source | E6 → D5 every-segment narrow evidence checks → original retraction, long replay and fresh full run |
| R6 Duplicate/Task selection | Tested synthetic live holdout; partial real corpus coverage | E7/S1 → D6 Noul/Choice with no-match → policy holdout and overlap regression |
| R7 Errors, interruption, freshness | Tested representative failures | E5/E6 → D7 fail closed, append stage traces, source fences → protocol/outage/screen/revision tests |
| R8 Privacy and server-side keys | Tested scoped controls; redaction not exhaustive | E2/E5 → D8 strip export metadata, configured-key/signature redaction → redaction tests and secret search |
| R9 Packaging, persistence, first use | Tested isolated Docker/native forms | E8 → retain current Rust/Axum/SQLite stack → image boot, restart and browser evidence |
| R10 Compatibility/regression | Tested ordinary and live existing paths | E9 → optional structured Artifact field, no lockfile additions → 89 ordinary tests and two live workflows |
| R11 Excluded/inaccessible inputs | Blocked by explicit exclusion/access change | E10 → skip September 2; use authorized saved September 4 snapshot → no excluded-file re-read |

E0 baseline: [72 ordinary tests, two ignored](evidence/baseline-tests.log), base
SHA above, five unrelated user files recorded outside the isolated worktree.
E1: 85 Markdown files plus one JSON inventory initially observed. E2:
[final format check](evidence/corpus-format-final.log) excluded September 2 and
covered 84 files, 68,159 dialogue lines and 4,650 omitted metadata/empty lines;
maximum 19 segments. Every selected dialogue line was covered. This is a
deterministic format/segmentation result, not semantic recall over 84 meetings.

E3: [old sparse failure](evidence/baseline-sparse.log). E4: live clear, ambiguous,
poisoned-summary, sparse, tiny, relative-date and answered-question runs in
[sanitized experiment metrics](evidence/experiment-metrics.json). Public logs
link the named runs. Private source snapshots, full provider replies, line
evidence and artifact exports remain outside Git. Hashes identify the stored
source after normal intake trimming; raw original bytes can differ by newline.

E5: [eight HTTP/durable-worker tests](evidence/overlap-regression-final.log),
judgment protocol tests and source/parser units within E9, including the final
S2 capture regression. E6: long failures
in `after-strategy*.log`, `after-long-holdout.log`, `after-long-small.log` and
[successful fresh-Jev replay](evidence/long-replay-final.log). E7:
[24 labeled wording calls](evidence/wording-experiment.json) and
[live composition holdout](evidence/policy-holdout.json).

E8: [image build](evidence/image-build-final.log),
[boot](evidence/image-boot-final.log), [restart](evidence/image-restart-final.log)
and browser checks recorded in `native-verification.json` when finalized. E9:
[fmt](evidence/final-fmt.log), [check](evidence/final-check.log),
[clippy](evidence/final-clippy.log), [tests](evidence/final-test.log) and
[two live existing workflows](evidence/live-workflows-final.log).

Public terminal logs remove only trailing spaces and blank EOF lines;
[original byte hashes](evidence/log-normalization.json) preserve that distinction.
Original terminal output and private provider artifacts remain outside Git.
The browser's unsupported `/health` probe returned 404; the actual `/healthz`
endpoint returned 200, recorded separately. This was a harness lookup error.

E10: September 2, 2026 file ending `83C2ZZFS` produced a Jev screen block with
injection probability 0.82. The user directed “Skip that transcript and continue
with the others.” It was excluded from subsequent reads/provider use and the
final format check. On October 13 around 14:06 local time, the original corpus
directory became unavailable. Its earlier successful checks remain recorded;
later long verification uses the authorized Run's saved September 4 source.
No attempt was made to recreate or alter the user's corpus directory.

## Experiments, decisions and costs

The working investigation budget reserved implementation and verification after
targeted documentation and initial controls. Observed schema, timeout and final
state failures justified additional discriminating probes. Searches/retries
without changed questions, input, schema or implementation were not used to
select a preferred model answer. Failed runs remain in the evidence directory.

| Experiment | Before / control | Result / implication |
| --- | --- | --- |
| Sparse transcript | 3 old proposals, 29.817 s | Later 0 proposals, 3.260 s; extraction restraint and evidence gates improved this case |
| Five category control | First iteration supported 3/5 categories | Later clear run supported all five expected categories plus a topic, 1 action, 7.688 s; browser independent run 37 s shows latency variation |
| Ambiguous commitments | Suggestions, retraction, conflicting context | No proposals; suggestions/risk retained, 45.167 s |
| Generated-summary poison | Fake outcome outside spoken `Sentences` | No fake proposal; actual risk/completed statements retained, 11.495 s |
| Answered question | Question followed by an actual answer | No open-question proposal; completed/summary findings, 6.422 s |
| Prompt injection | Explicit redirection in synthetic dialogue | Run failed with no artifact in 0.372 s; earlier harness wrongly expected done and is recorded |
| Relative deadline | Explicit promise with “next Friday” | One action with calendar due null and phrase preserved, 2.528 s; conflicting-date case remains reviewable |
| Wording/catalog perturbation | 8 labeled cases × 3 variants | All variants selected 8/8 labels; confident correct 6, 7, 7; changed wording and option IDs are confounded |
| Duplicate/Task holdout | Seeded supported findings and owned Task | One repeat consolidated, distinct work retained, matched/no-match controls, Task unchanged; 1.77 s total |
| Long, 24 KB segments | 156,995 raw bytes | Request timeout after 292.670 s; no artifact, completed stage evidence retained |
| Long, 12 KB segments | Same stored source | All 19 extraction/audit stages, then HTTP 400 after 842.490 s; no partial artifact |
| Recorded long extraction | Authentic 19 saved drafts, fresh Jev | 151 records, 70 supported, 5 actions; about 35.5 s including export; not fresh end-to-end generation |
| Fresh complete long run | Same stored September 4 snapshot, both live providers | 19 segments, 2,125 dialogue lines, 152 records, 64 supported, 5 actions; 1,073.198 s to saved export; no partial-stage substitution |

D1 retain dialogue-only source handling, excluding generated Fireflies summaries
and signed/access metadata. D2 use constrained Mistral schema for free-text
candidates, then TypeSafe judgment rather than unchecked prompt-and-parse output.
D3 keep exact values, resource checks, date normalization policy, execution and
Task mutation in Rust. D4 keep separate support/classification/ownership/date
gates and degrees of importance/tension; do not average away a failed requirement.
D5 select smaller segments and narrow states instead of silently truncating
dialogue or increasing an already expensive timeout. D6 semantic duplicate and
Task matching remain advisory. D7 preserve failure evidence. D8 no SDK/runtime
change: TypeSafe HTTP through existing `reqwest` follows the native-stack skill.

Reported Jev usage: clear control 8,000–10,000 input tokens per observed run,
roughly $0.0003–$0.0004; live policy holdout 3,083 input/158 output tokens,
$0.000129486. Recorded long replay: 1,089,495 input/36,373 output tokens and
$0.04575879. Exact distributions and usage remain attached to saved judgments.
The fresh long run used 1,111,150 Jev input/37,807 output tokens, reported
$0.0466683, and 83,832 Mistral input/21,623 output tokens. At the documented
sale/original rates, Mistral's estimated amount is $0.102–$0.204. Actual billing
was not supplied. Mistral extraction used 1,040.988 seconds, Jev 31.462 seconds;
this workload demonstrates a significant latency and repetition cost.
Mistral provides token counts but no billing cost. Its October 13 model page
showed sale prices $0.68/$2.09 per million input/output tokens, alongside original
$1.36/$4.18; generic pricing documentation lagged the model listing. Any computed
Mistral amount is an estimate at a stated rate, not an invoice. Failed requests
can incur unreported usage; completed stage traces are a lower bound.

On the eight synthetic category cases, top-label accuracy was 8/8 in each
variant. Confident coverage was 6/8, 7/8 and 7/8; conditional precision among
those confident selections was 6/6, 7/7 and 7/7. These measures apply only to
this tiny catalog control, not extraction accuracy or whole-meeting recall.

## Research and Jev boundaries

Primary references read before integration: [HTTP API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[Noul](https://docs.typesafe.ai/primitives/noul),
[Score](https://docs.typesafe.ai/primitives/score),
[confidence](https://docs.typesafe.ai/concepts/confidence),
[SDK result reference](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult),
[citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check),
[composite scoring](https://docs.typesafe.ai/patterns/composite-scoring),
[model jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[model limits](https://docs.typesafe.ai/models),
[OpenRouter compatibility](https://openrouter.ai/docs/guides/community/typesafe-sdk),
[Mistral schema mode](https://docs.mistral.ai/studio/conversations/structured-output/custom)
and [Large 4 model information](https://docs.mistral.ai/models/mistral-large-4-0).
OpenRouter's documentation fetch returned 403 on one route; web access supplied
the official guide. Two cookbook leads screened as irrelevant were skipped.

Alternatives considered: retain single free-form prompt, typed source-backed
pipeline, Jev-only fixed candidate selection, whole-meeting reconciliation,
truncation/shortlisting, larger timeouts and another model. A Jev-only approach
cannot generate the open-ended requested prose; whole-source/large-output
approaches demonstrated failures. Current internal improvements require no new
Cargo package, lockfile entry, runtime or research account. Explicitly requested
Jev execution uses the existing authenticated, metered OpenRouter installation;
it does **not** satisfy a generic free/accountless-service rule. No free-tier or
wrapper claim is made. No new paid access was purchased.

During development all applicable Jev tools were used: screen for external
material; find with existence verdicts; rerank for investigation ordering;
classify for category controls; decide for bounded architecture/probe choices;
compare for conflicting expectations; extract for bounded deadline candidates;
audit for source fields; Noul for hypotheses; verify for claims; review/gate for
actual patches. Initial broad find returned absence 0.23, so its winner was not
trusted; a separate specific query matched at 0.92. Arithmetic, bytes, source
matches, hashes, statuses and tests remained deterministic.

The initial Standards/Spec raw-diff reviews escalated: safe-to-apply 0.16/0.28,
composites 0.647125/0.599625, minimum confidence 0. Stronger source/rule inspection
resolved the concrete S1 and heuristic concerns; unchanged reviews were not
repeated. [Raw review results](evidence/spec-judgments.json),
[S1 resolution](evidence/spec-resolution-judgments.json) and
[Standards judgments](evidence/standards-judgments.json) preserve those signals.
The final gate must use current raw diffs and actual evidence; model confidence
alone grants no permission and proves neither correctness nor completion.

Final gates were split by pipeline, integration, tests and configuration to
stay below live payload limits. All escalated, with safe-to-apply minima
0.26, 0.12, 0.38 and 0.29. One claim called the correct test count contradicted;
another contradicted the fixed capture regression. Stronger deterministic and
source reviews resolved those claims against current records and assertions;
the original signals remain preserved. See [final resolution](evidence/final-gate-resolution.md)
and [independent evidence audit](evidence/spec-gate-resolution.md). No unchanged
gate was repeated or threshold weakened. This is not Jev automatic acceptance.
Earlier development judgments remain in the task tool history; these files
preserve final gates, reviewer judgments and consequential experiment results.

## Replay commands and remaining limits

Required offline gates, with no model network requests:

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Explicit live experiments require the user's existing server-side keys and
private absolute input/output paths. Ordinary CI does not execute them:

```sh
MEETING_CORPUS_FILE=/private/path/source.txt \
MEETING_EVAL_OUTPUT=/private/path/result.json \
  cargo test -p chief-of-rust --test meeting_corpus --locked -- --ignored --nocapture
MEETING_CORPUS_DIR=/private/path/fireflies-transcripts \
MEETING_CORPUS_EXCLUDE=83C2ZZFS \
  cargo test -p chief-of-rust --lib --locked local_corpus_format_coverage -- --ignored --nocapture
MEETING_REPLAY_INPUT=/private/path/recorded-result.json \
MEETING_REPLAY_OUTPUT=/private/path/replay-result.json \
  cargo test -p chief-of-rust --lib --locked live_long_recorded_extraction_replay -- --ignored --nocapture
MEETING_QUESTION_OUTPUT=/private/path/wording.json \
  cargo test -p chief-of-rust --lib --locked live_labeled_judgment_experiment -- --ignored --nocapture
cargo test -p chief-of-rust --test live_mistral --locked -- --ignored --nocapture
```

Bounds: 12 KB dialogue segments, two-line overlap, 32 segments and 220 KB selected
dialogue; large individual lines fail instead of truncating. Extraction targets
at most eight findings per usable segment, three for low-quality fragments.
Duplicate checking covers at most 128 lexically overlapping pairs; less similar
paraphrases can remain. Completion matching considers at most 100 related Tasks.
Provider/model limits can reject a particular bounded request; a failure cannot
be represented as successful partial coverage.

Whole-corpus semantic recall, general calibration, non-English accuracy, audio
fidelity, actual emotions, all platforms, assistive-technology behavior and live
external delivery were not established. Synthetic labels measure those cases;
fixture tests measure policy; repeated Jev agreement is not independent proof.
Long-run extraction remains slow and provider-sensitive. Private inputs are sent
only as necessary dialogue to the configured providers; simple redaction cannot
guarantee removal of every secret. Generated debriefs and durable Run snapshots
contain sensitive meeting evidence and follow the Workspace's existing retention.
