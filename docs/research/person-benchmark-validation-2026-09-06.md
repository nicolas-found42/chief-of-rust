# Person Research Benchmark validation — 2026-09-06

Issue #228 remains incomplete. The implementation, corpus authoring, regression tests and local
gates have progressed; live quality acceptance has not passed. The implementation now includes
commit `f64f296` and additional uncommitted changes on `codex/person-research-quality-evaluation`.
The review scope remains the complete diff against `30b5a420c7be425f8f55a62ef909e22e6acebf01`,
including untracked source and tests, excluding temporary diagnostic probes.

## Corpus

The earlier validated collection contained 30 real people, 234 reference facts and 77 unjustified
conclusions at content version `41d616ea8dfb1786`. The current authoring adds a collection scenario
and Fowler's dated Senate testimony; the 05:22 local audit of `--corpus-coverage` loaded 30 people
at version `3dedb8c8e53a4f4c` with one collection scenario. This version is now held fixed for the upcoming full comparisons; it contains 235 individual
facts. Temporary diagnosis corpora have different versions and cannot substitute for this population. Changing reference content or scenario
expectations changes the version even if an author's version label stays the same. Duplicate
document IDs and duplicate person slugs are rejected.

Individual facts cover 19 of the 20 dossier requirements. `r18`, capability intersections with
denominators, now has a real collection scenario evaluated through `PersonDossierQueries` after
research; it is not counted as an individual biographical fact. Controlled evaluator fixtures
exercise supported, unsupported and ambiguous intersections and sparse population denominators.
The new scenario still needs full real-model assessment. Source-family balance remains weak
outside documents and published work; broad demographic coverage alone does not establish strong
references across all source families.

## Regression evidence

The Person Profiles composition tests now exercise discovery expansion beyond earlier result
caps, visible deferred selection, record readers and providers, document conversion, feed
transcript following, captions and caption absence, social authorship, challenge fallback, and
observed HTTP failure classification. Bounded runs preserve their operation ID, traversal and
attempt history. Changed transcript evidence invalidates a checkpoint even if its job was
already queued; changed profile revisions also invalidate it. These continuation regressions
were observed failing before the corresponding fixes and passing afterward.

Evaluator regressions cover invalid judge evidence, semantic overclaims despite valid quotes,
wrong-person claims, upstream-index independence, reference version changes, duplicate IDs,
interrupted operations, differing comparison populations, and identity regressions. Existing
fictional dossiers remain explicitly separate from the real-person corpus.

The earlier independent Spec review found fixes for false completion with pending work, planner
interruption reporting and checkpoint continuation/invalidation. The completion audit adds fixes
for retained shutdown outcomes, `Retry-After` longer than the retry allowance, credential-bearing
URLs in diagnostic prose, publication inside the serialized lifecycle fence, and dispatching the
requested Profile without first running an unrelated older job. Current CLI changes reject invalid
or empty selections and invalid corpus entries, preserve intentional limits in reports, and keep
fixed-document research within its supplied documents. Comparison changes separate research failure
from a completed assessment, require assessed populations and scenarios, and retain operational
regressions separately from reference recovery. These are implementation/test additions, not claims
that the current full gates or live acceptance have passed.

The evaluator/report audit also separates reference-family cohorts from actual production source
contributions. Per-person JSON now links retained source versions (URL, hash and upstream index)
to cited claims, recovered reference-fact IDs and recovery whose matched claim cites only that
family. Uncited retained material remains visible; overlapping families are not additive, and
exclusive-family recovery is not a causal or independence claim. Readable reports and comparisons
show these contributions, while legacy reports mark them unmeasured. Default whole-corpus
selection with `--limit` now records all excluded people explicitly, just like `--people` subsets.

Comparison regression checks now compare failure identities instead of net counts: replacing one
critical or wrong-person failure with a different failure at the same count cannot earn an improved
verdict. Critical fingerprints use assertions and available source URL/hash/quote while excluding
generated claim/source IDs; complete critical keys survive the display-detail limit. A report
without sufficient critical identity evidence is not comparable. Focused evaluator, CLI,
collection, comparison and source-contribution suites passed 38 tests during this audit; subsequent
provider work and final gates remain independently verified.

The updated Standards review identified a conflict between declared-binding repetition recovery and
ADR-0029. ADR-0064 now records that narrow exception and ADR-0029 links to it. Remaining nonblocking
maintainability observations are repeated `queue.status().jobs.find(...).operation` lookups in the
composition and lifecycle, allowance, collection and publication policies sharing the large
`PersonResearch.run` closure. No additional definite documented hard violation was found in the
inspected scope. Review does not replace live acceptance or final verification.

## Verification gates

The following full results belong to the earlier checkpoint-fix tree. **They do not verify the
current working tree.** All final gates must be rerun after the ongoing implementation changes.

- `pnpm run check:all`: passed typechecking, lint, formatting, knip, all 1,951 unit tests
  and all 80 Playwright tests after the final checkpoint fix.
- `pnpm run test:coverage`: passed unchanged floors; statements 83.99%, branches 73.18%,
  functions 86.52%, lines 86.43%.
- `docker compose build`: passed for app and relay. The rebuilt app booted with an isolated
  temporary workspace and returned `{"ok":true}` from `/api/health`; the verification
  Compose project was brought down afterward.
- `--corpus-coverage`: the historical run passed document hashes, reference quotes and schemas
  for all 30 people, with 19/20 individual requirement coverage. The current loader observation
  and separate r18 scenario are recorded above.
- `git diff --check`: passed.

The production build still prints its large JavaScript chunk advisory; this did not fail the
build. Local gate success does not establish the live quality criteria below.

Current narrow evidence from this audit: `pnpm --filter @chief-of-staff-demo/tests exec vitest run
tests/src/composition/person-research-lifecycle-composition.test.ts` passed four tests. They hold a
real composed extraction in flight while correction, merge, privacy deletion or source detachment
occurs; the late result publishes no claims. Privacy deletion also removes the Profile's durable
queue/attempt record. No full-gate pass is inferred from these four tests.

The thin browser audit also passed `pnpm run build` and `pnpm run typecheck:tests`.
`pnpm --filter @chief-of-staff-demo/tests exec playwright test e2e/person-dossier-journey.spec.ts`
passed the four existing/updated journeys, including completed-with-gaps and interrupted source
inspection. The new progressive-publication test initially failed because its exact-text locator
matched both summary and claim; scoping it to the claim article corrected the test. Its focused
rerun with `--grep 'published claims remain readable'` passed (one test, 9.8 seconds). It holds
the second model response through a test-only release seam, proves the first cited claim and
retained source readable while research remains active, then releases the response and verifies
completion under the same operation ID. The fixture has a 30-second safety release and releases
in `finally`; it uses no sleep to establish the intermediate state. These checks cover the thin
browser requirements without asserting a full current-tree gate pass.

## Model and source evidence

The corrected two-person fixed-document smoke run is
[`2d0a903133188b6a`](../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.md).
Both operations failed at extraction, with zero response bytes before the model boundary's
120-second ceiling. This is an observed timeout, not a proven explanation of the provider's
internal failure. Some judge calls responded. The configured model remained OpenRouter
`z-ai/glm-5.3-flash`; no runtime credentials or configuration were copied into the artifacts.

The earlier report's incorrect top-level success is explicitly disqualified in the
[artifact index](../../artifacts/person-benchmark/README.md). Failed extraction is now propagated
to the report's failed status. No full-collection live baseline, expanded run or comparison has
been produced, and no quality improvement is claimed.

Source probes returned HTTP 200 with expected JSON shapes for 15 implemented endpoints. Three
additional catalogue entries document unavailable or excluded routes and are not successful
network probes. This is access evidence, not a fresh terms-of-use audit or proof of unique
supported person facts. See [source eligibility](person-source-eligibility.md).

## Remaining acceptance work

1. Diagnose the configured model's extraction timeout using the retained attempts and production
   model boundary; obtain a successful fixed-document smoke run without changing the settled
   runtime model implicitly.
2. Finish assessing the new real collection-level `r18` scenario and strengthen underrepresented
   source families from independently researched, retained evidence. Freeze the resulting reference
   version for comparison. Never weaken references to match output.
3. Complete the full fixed-document run, live incumbent and expanded runs, and comparable report
   pair with fixed references and judge version. Preserve remaining misses and failures.
4. Close the remaining acceptance items in the audit below, then rerun `check:all`, coverage and
   isolated Docker build/boot/health/cleanup for the final tree. Preserve unchanged coverage floors.
5. Present the final reviewed changes and proposed commit message for explicit approval before
   staging or committing, as required by the implementation handoff.

## Requirement-to-evidence checklist

Statuses distinguish existing observable coverage from current verification and live acceptance.
An existing test is not marked as passed unless its current execution is recorded above or in the
final gate record. Story numbers refer to the binding
[issue #228 specification](../specs/person-research-quality-evaluation.md).

| Requirement | Observable evidence in the current tree | Remaining acceptance action |
| --- | --- | --- |
| Canonical creation/reuse, triggers and progressive reads (3–8) | Composition tests cover shared Workspace handles, upcoming Meetings, repeated confirmed Transcript mentions, publication beyond old caps and retained evidence before completion. Browser dossier journey covers add, automatic population and source inspection. New held-response journey proves the first cited claim is readable while the second extraction remains pending, then completion under the same operation ID; focused run passed. | Run final composition/browser gates. The thin overlap requirement is covered; live continuous-operation acceptance remains separate. |
| Adaptive research, lead accounting and completion (9–10, 24–27, 49) | Composition tests cover empty-discovery broadening, former eight-result cutoff, pending lead on safety bound, retry in one operation, planner outage and shutdown. Queue tests cover continuation, daily-rollover independence and process-owner restart. | Establish successful continuous production runs against real people; inspect lead disposition and explicit gaps. Existing fixtures cannot establish normal live completion or improvement. |
| Archive, merge, identity correction and cancellation during I/O (28, 63) | Queue parameterized race tests cover archive/correction/merge/privacy/pause/gate/stop/evidence. Composed serialized-archive regression fences publication. New four-case composed extraction regression covers correction/merge/privacy deletion/detachment. | Run current gates; no additional duplicate helper-level race suite is required for the same fence. |
| Standing source decisions and Transcript deletion (28, 63) | Research tests reject detached sources before recrawl and interrupt a mid-run rejection. Composition tests reject stale confirmation/checksum, invalidate during extraction, purge confirmed Transcript claims and register both deletion consumers. Dossier store tests reject detached source publication and remove historical access. | Verify final suite and ensure changed diagnostics remain in the same cleanup path; avoid a second persistent store. |
| Privacy and retained evidence (23, 55, 57, 63) | Research tests keep confirmed Transcript claims out of public projections; dossier tests protect immutable versions and privacy deletion. Composition privacy deletion clears dossier and queue. New deletion race checks durable queue text and empty attempts after late extraction. Diagnostic regression checks secret-bearing URLs in reasons/remediation. Migration classification tests include research state. | Final gates; inspect final exported artifacts for public-only evidence and nonsecret provenance. Diagnostic artifact inspection is separate from source-visibility tests. |
| Existing UI and visible research outcomes (6–7, 26–27, 64) | Browser journey covers unchanged tabs, citations, historical revision, source inspection, sparse/unavailable retained material, keyboard operation, accessibility and narrow viewport. Updated journey passed completion-with-gaps and visible provider-interruption assertions with retained source inspection. | Run final browser gate. No experimental layout integration is required. |
| Corpus and all twenty requirements (29–34) | Loader validates hashes, support quotes, duplicate identities and immutable versions. New real collection scenario supplies r18 without fabricated individual facts; Fowler's Senate testimony adds institutional evidence. | Finish reference-source balance and live collection assessment; preserve unavailable dimensions and do not count fictional controls as independent research. |
| CLI input, isolation and mode behavior (35–36, 46–47, 61) | New CLI tests reject unknown people, rejected corpus, empty selection and invalid limits before reports; a valid limit is explicitly recorded and failed evaluation remains failed. Module test constrains fixed-document mode to supplied documents. Evaluator uses isolated composed Workspaces. | Run new CLI tests with final code; run full fixed-document and live CLI modes and inspect exit status, selection, operation files and reports. |
| Semantic assessment and comparisons (37–45, 48, 50, 60) | Existing evaluator tests cover wrong person, unsupported semantic conclusions despite valid quotes, invalid evidence, upstream independence and incompatible comparisons. New comparison tests reject missing assessments, partial/duplicate/empty populations and missing scenarios; assessed research failures remain explicit. | Complete 30-person fixed, live incumbent and live expanded runs with one frozen corpus/judge configuration; produce compatible comparison demonstrating improved recovery without new critical identity/integrity failures. Record reconstruction and allowance/network differences. |
| Failure observations (51–57) | Production attempt recorder retains correlation, attempts and observations. Composition tests cover HTTP classification, challenges, retry history, model interruption, long Retry-After and URL redaction. Provider tests cover stream activity and loop/timeout classifications. | Finish configured-model diagnosis and successful smoke; audit final operation records for applicable timeout/parser/subprocess fields, reproduction pointers and absent secrets/reasoning. A source HTTP 200 or a passing model fixture is insufficient. |

## Source-family acceptance checklist

All source families remain eligible irrespective of the owner's industry. The existing
[eligibility record](person-source-eligibility.md) documents 15 successful anonymous JSON probes
and three excluded/unavailable entries, not 18 successful acquisitions. The bounded
[primary credit assessment](person-benchmark-primary-credit-validation-2026-09-06.md) adds current
Senate testimony evidence and records the Academy and State archive limitations. It is not a
complete fresh audit of the incumbent and added routes.

| Family | Current controlled/retained evidence | Still required for acceptance |
| --- | --- | --- |
| General discovery | Broadening and beyond-cutoff composition tests; MWMBL provider response yields a retained lead. | Unique supported live evidence and applicable route terms; engine count is not improvement. |
| Spoken evidence | Podcast feed transcript-following, publisher timestamp captions, missing-caption gap, PeerTube and podcast-directory lead tests. | Usable live transcripts/captions; local transcription is explicitly not wired into person research. Descriptions must remain descriptions. Investigate eligible missing routes and retain precise unavailable-runtime gaps. |
| Public social | Composed Bluesky repost provenance and Mastodon dated-status reads; anonymous API probes. | Substantive benchmark facts with verified original authorship and current route eligibility. LinkedIn/Instagram availability is per request, not guaranteed by a reader label. |
| Documents/publishers | Real PDF text-layer conversion through injected byte transport, HTML challenge/browser recovery, feeds and record readers. | Live grounded claims from documents; verify scanned PDFs/OCR, slides and attachments through the existing local runtime or record their exact unsupported/runtime gaps. Text-layer PDF tests do not prove OCR. |
| Published work | Crossref/DataCite discovery and structured record reading; existing published-work references. | Production recovery of unique supported publication/contribution evidence with date and rights provenance; DOI catalogue discovery alone is insufficient. |
| Professional/institutional | NPPES, ClinicalTrials and Nonprofit Explorer controlled records; Fowler's independently inspected official testimony is retained. | Full production discovery/read/attribution of these records and no title-to-contribution inflation. |
| Creative/cultural | TVMaze, Library of Congress, Art Institute and Open Library lead tests. | Eligible substantive credit evidence; Academy automated retention was excluded by observed terms, so it must not count as usable expansion. |
| Identity/affiliation | Existing Wikidata/ROR/identity sources remain in production; wrong-person and ambiguity regressions exist. | Live identity anchors in final reports and critical attribution checks. Mere registry membership cannot establish every linked accomplishment. |
| Historical evidence | Existing Archive/Wayback discovery remains available; Common Crawl probe only lists indexes. | Actual archived content/capture retrieval and dated retained evidence, or actionable missing-capability diagnostics. The State archive's technical-difficulty HTML is not successful evidence. |

## Latest model-boundary review and candidate validation

The boundary now supports one observed same-binding retry for transport failures or streaming
idle timeouts inside the original 120-second deadline (ADR-0066). Extraction and benchmark
judges opt in; planner calls retain their prior policy. Correlated sanitized wire-attempt records
retain recovered failures without counting another logical model call. Typed reasoning detail
deltas count as activity without being retained; parallel tool arguments are reconstructed by
tool index rather than concatenated across calls.

Independent review found and fixed two retry-fence defects. Extraction now checks operation time
and lifecycle validity without requiring another logical-call or retrieval-request slot. The
provider checks caller cancellation before every subsequent request, including binding recovery.
Regression evidence includes recovery with a one-logical-call allowance and cancellation during
both repetition recovery and unknown-support refusal recovery. All 76 provider tests and 15
diagnostics/lifecycle tests passed at this stage. A raw Zod enum error could also echo rejected
model content into diagnostics; caller diagnostics now retain schema paths and fixed issue codes
instead. The private marker regression passes.

Small fixed-document run `66ed88fb3d6a061d` produced three published claims with valid full-schema
extraction in 43.2 seconds, and its fact judge returned valid JSON in 6.1 seconds. Its separate
usefulness judge reached the original deadline while reasoning remained active. No retry was
eligible after that deadline. This is a failed assessment, not successful benchmark evidence.
A subsequent candidate smoke tests a declared forced-tool preference for semantic judges; its
result and the new full gates must be recorded before choosing that policy for final comparisons.

The subsequent smoke `39e8f583d614ad67` **completed** with one published claim and one independently
authored dated reference fact recovered, zero critical integrity findings, and both semantic
assessments completed. All three requests succeeded on their first attempts under declared
forced-tool binding. It uses the explicitly tiny diagnostic corpus `ead8f30f1cf6c27c`, not the
30-person acceptance collection. Judge version `2026-09-06.4`, extraction prompt version
`2026-09-06.4`, and canonical corpus `3dedb8c8e53a4f4c` are now held fixed for full runs. This
success does not by itself prove full-population reliability or improvement. Full fixed-expanded
and live-incumbent runs have started; their outputs remain in progress.

At the declared-tool candidate tree, `/private/tmp/issue-228-check-all-tool-judge.log` records a
passing full gate: 2,046 unit tests and all 82 browser tests, plus typechecking, lint, formatting
and knip. Coverage independently passed unchanged floors: statements 84.36%, branches 73.70%,
functions 86.89%, lines 86.76% (`/private/tmp/issue-228-coverage-tool-judge.log`). App and relay
Docker builds passed. The app booted with an empty temporary workspace in Compose project
`issue-228-verification-tool-judge`, returned `{"ok":true}`, and its container and network were
removed. Logs are `/private/tmp/issue-228-docker-{build,boot,health,down}-tool-judge.log`.
A subsequent evaluator integrity-credit fix, if adopted, needs its own final gates.

## Corrected full-input judge contract

Final Spec review reproduced two assessment errors through the evaluator/judge seams: positive
semantic verdicts could receive credit despite critical citation-integrity findings, and active
claims after claim 120 were silently excluded. The evaluator now downgrades critical-invalid
recoveries/partials before every aggregate while retaining the original semantic verdict and
explanation. Judge version `2026-09-06.5` sees all active claims, all complete cited passages, and
all retained source metadata. Saturating the 40-overclaim output bound marks assessment incomplete,
including when unknown claim IDs would later be filtered out.

The corresponding tree passed `pnpm run check:all`: 2,051 unit tests and all 82 browser tests,
plus the static gates (`/private/tmp/issue-228-check-all-judge5.log`). Coverage passed unchanged
floors: statements 84.38%, branches 73.76%, functions 86.97%, lines 86.78%
(`/private/tmp/issue-228-coverage-judge5.log`). App and relay Docker builds passed, and an empty
temporary workspace boot in `issue-228-verification-judge5` returned `{"ok":true}` before container
and network cleanup. Logs use `/private/tmp/issue-228-docker-*-judge5.log`.

A suspected interrupted-source resume defect was independently refuted using actual composition
and disk reconstruction: a failed extraction's durable checkpoint kept pending source text, and
recovery published its claim under the same operation ID with two extraction calls but one fetch.
No production change was made for that hypothesis.

The in-progress full runs use judge `.4`; they must not be relabeled `.5`. Their isolated public
evidence is being preserved separately so the corrected judge can reassess the same research,
with new report provenance and without rewriting original measurements. Reassessment support is
under implementation and is not covered by the preceding gate results.

## Corrected lookup inputs

The full fixed run exposed malformed input for Bong Joon-ho, Chimamanda Ngozi Adichie, and Hilary
Cottam: their employer hints were occupations or the word Independent, rather than organizations.
These values prevented the existing name-only/probable identity path. Their hints are now null
and their reference versions are `2026-09-06.2`. No reference fact, unjustified conclusion,
retained document, or collection expectation was removed or changed. The corrected corpus is
`cd3bd2a050f51de7`: 30 people, 235 facts, one r18 collection scenario.

Original full runs already in flight continue to use `3dedb8c8e53a4f4c`; they are not relabeled.
An exact snapshot is retained at `/private/tmp/issue-228-corpus-3dedb8c8e53a4f4c/people` (with the
parent collection scenario). Reassessing those runs requires that old corpus via `--corpus`.
The final comparison needs matching inputs in both arms. The malformed hints are not a reason
to remove the independent-professional benchmark cases or relax known-employer namesake checks.

The same audit identified a conservative literal spelling limitation: Fowler's biography says
U.S. Department of State while his hint spells United States Department of State; Bong's English
excerpt uses Bong Joon Ho. These are distinct from the malformed hints. No broad fuzzy identity
matching or reference-informed identity bypass has been introduced.

## First complete fixed-document research population

Run `96a666d0479437eb` finished all 30 research operations at 10:50:57 UTC, using its original
corpus `3dedb8c8e53a4f4c` and judge `.4`. It published zero claims and recovered zero of the 235
reference facts. Twenty-two operations were interrupted and eight completed without retained
claims; 28 of 30 person assessments completed. Laurent Freixe and Rodolphe Saadé had incomplete
judge assessments. The collection scenario completed with zero recovered matches and an active
population denominator of 30. This is a failed acceptance run, not improvement evidence.
The complete report and original operations are in
`artifacts/person-benchmark/full-fixed-2026-09-06/`.

The evidence-preservation monitor captured all 30 completed operation IDs before the isolated
workspace was removed. A validation-only call through `reassessReport`, with the frozen old
corpus and a throwing stub instead of a model, validated the complete snapshot population.
No model request was sent and no synthetic assessment report was saved. The snapshot is at
`/private/tmp/issue-228-evidence-snapshots/fixed-expanded`; the temporary validation script is
`/private/tmp/issue-228-reassessment-preflight.mts`. Reassessment has ten passing contract tests,
including an empty dossier that was never published and rejection of a missing named published
revision before any judge call. Final gates must include this new reassessment implementation.

### Retained source-version accounting follow-up

A composed failure/resume probe exposed a reporting defect: the first model failure left one
attached retained version while `sourcesRetained` reported zero; successful resume left two
versions while the counter reported one. The old counter measured successful extraction steps.

New operations count distinct source-version IDs retained or reused during that operation,
including the initial unattempted version and the classified full/partial version. Checkpoints
persist those IDs, resumed outcomes union them, and the queue display derives the same count.
A fresh refresh starts a fresh set and counts versions it actually touches, including unchanged
versions, without counting unrelated older sources. Legacy outcomes remain readable; because
previous IDs are unknown, mixed legacy continuations retain a conservative lower bound using
`max(previous count, observed distinct count)` and omit the exact identity set.

The actual-composition regression covers initial failure (one version), repeated failure after
reconstructing the composition from disk (still one), successful same-operation resume (two),
and a fresh unchanged refresh (two, excluding an unrelated historical source). It checks retained
claims, fetch reuse, queue display, and `publishedDossierRevision` against the persisted dossier.
The sequence runs for both current and legacy checkpoint/outcome shapes.

Focused validation passed: 38 tests across the source-accounting composition, research queue,
research module, model diagnostics, and lifecycle composition files; shared/server build
typechecks and tests no-emit typecheck; typed ESLint on the five changed source/test files;
Prettier and whitespace checks. This narrow result does not replace the final full-tree gates
or reinterpret already-written benchmark operation counters as if they used the new semantics.

## Current-tree gates and matching-input reruns

The reassessment, bounded live concurrency, public snapshot retention and source-version
accounting tree passed `pnpm run check:all`: 2,071 unit tests, 82 browser tests and all static
checks (`/private/tmp/issue-228-check-all-retention.log`). Coverage passed unchanged floors:
statements 84.43%, branches 73.91%, functions 86.90%, lines 86.81%
(`/private/tmp/issue-228-coverage-retention.log`). App and relay Docker builds passed; the app
booted on an empty temporary Workspace in `issue-228-verification-retention`, returned
`{"ok":true}`, and was brought down. Logs use `/private/tmp/issue-228-docker-*-retention.log`.

Fresh full fixed/expanded and live/incumbent plus live/expanded runs started at approximately
11:02 UTC using corpus `cd3bd2a050f51de7`, judge `.5`, the same configured GLM model, and public
evidence retention. Both live arms use operation concurrency two with their unchanged individual
pipeline allowances. Outputs are in the `current-*-2026-09-06` artifact directories.

At 11:04 UTC, the superseded original live runs were stopped after 19 incumbent and 10 expanded
operations had been saved. Their snapshots and original operation files remain available; they
are partial diagnostic runs, not acceptance comparisons. The original full fixed report remains
complete as recorded above. Its in-progress `.5` reassessment was also stopped without producing
a new report. This removed competing model work after corrected full runs were launched; no
original measurement was relabeled or fabricated. The old snapshot monitor was then stopped.

The refreshed independent review found no additional definite implementation defect. Standards
noted nonblocking duplication of the snapshot allowlist/validation contract and the potentially
confusing manifest name completedOperationIds (which also includes finished interrupted/bounded
operations). Spec review independently checked source-version accounting and reran 15 relevant
integration tests; the required improvement comparison is still the explicit acceptance gap.

## Immutable assessment evidence and judge phase review

Generated benchmark JSON and retained `.evidence` directories are now excluded from automatic
Prettier rewriting because reassessment provenance uses their exact bytes. Authored corpus JSON
remains checked. A controlled format-gate probe verified that malformed ordinary JSON fails the
format check, generated JSON is ignored, and even an explicit formatter write leaves generated
bytes unchanged. The temporary probes were removed; results are recorded at
`/private/tmp/issue-228-format-immutability-check.json`.

Independent review reproduced a completed reference judgement being lost when the later
support/usefulness call failed. The partial-phase correction preserves bounded structured
reference verdicts and evidence while withholding credited positive recovery until support
assessment succeeds. New per-person sidecars expose this before aggregate completion. Another
review reproduced unknown support claim IDs being silently discarded as clean, and invented
statement text being attached to a valid claim ID as a definite wrong-person finding. The `.6`
judge guard treats these as unresolved support observations, not clean assessments or established
wrong-person findings. Current research runs loaded `.5` before these fixes; final acceptance
must reassess their retained evidence using `.7` consistently in both arms.

The subsequent `.7` review fixes ensure every validated support overclaim, including an
uncertain finding, blocks positive reference credit for that claim. Support findings identify
the actual indexed citation rather than inheriting the first citation. Unknown claims, invented
statement excerpts and invalid citation selections remain unresolved observations and make the
support assessment incomplete. An existing evidence-bundle attestation is enforced for both
full and failed-only reassessment; changing evidence cannot be legitimized by starting another
full assessment. The 27 reassessment tests and 54 focused evaluator/judge/CLI tests passed;
whole-tree verification and the full real comparison remain in progress.

Only discovery/navigation `outboundUrls` are removed from each source's semantic judge metadata;
all sources, other metadata, claims and full cited passages remain. Live source metadata measured
for Ana Botín, Arvind Krishna and Anders Danielsson was dominated by navigation URLs. This is a
reduction of irrelevant request content, not proof of the upstream stall's cause. The fixed
Anders dossier has six verified citations, zero critical findings, and visibly covers several
authored references despite its `.5` progress counter of zero. The completed original fixed report now identifies the cause: for five reference matches,
the judge returned the Swedish cited passage rather than a verbatim excerpt of the English
dossier claim. All five passages occur in their selected citations but not in their claims;
the exact claim-text guard correctly withheld credit. The `.7` reassessment preserves this
guard and independently evaluates the saved evidence.

## Judge `.7` verification and completed research populations

The current implementation passed `pnpm run check:all`: 2,095 unit tests, 82 browser tests and
all static checks (`/private/tmp/issue-228-check-all-judge7.log`). Coverage passed unchanged
floors: statements 84.43%, branches 74.12%, functions 86.88%, lines 86.79%
(`/private/tmp/issue-228-coverage-judge7.log`). App and relay Docker builds passed; the app booted
against an empty temporary Workspace, returned `{"ok":true}`, and its verification container
and network were removed. Logs use `/private/tmp/issue-228-docker-*-judge7.log`.

Independent Spec review verified all three latest findings were fixed and reran 52 judge,
reassessment and comparison tests. It found no additional concrete blocker in those seams;
the full compatible improvement comparison remains the acceptance gap.

Both current fixed and incumbent research runs finished all 30 people and retained their public
evidence. Their original `.5` reports remain unchanged and failed: fixed has 26 completed judge
assessments and incumbent has 29. Full `.7` reassessments are running in
`current-fixed-judge7-2026-09-06` and `current-incumbent-judge7-2026-09-06`. These retain original
research outcomes and assess the saved evidence without repeating research. The expanded live
research run is still in progress. No final improvement claim is established by these interim
results.

The fixed `.7` first pass `b2838e9176d9058b` subsequently finished 28 assessments. Recovery
`bbc8e62af386b229` carried those 28 and the completed collection scenario, retried Ana Botín
and Anders Danielsson only, and completed all 30 assessments. Final fixed reference recovery
is 2/235, with zero critical integrity findings and zero wrong-person findings. The original
23 interrupted and seven completed research outcomes remain unchanged; the report is failed.
The judge again quoted the Swedish cited passages for five Anders matches, so those verdicts
remain ambiguous and are not eligible for more failed-only retries. This is an explicit
assessment limitation rather than proof that those five facts are absent from his dossier.

The incumbent `.7` first pass `2b5991382eeb01ab` completed 24 assessments, with six failures.
Failed-only recovery `f93fe67376b87cec` completed all 30 assessments and the collection scenario,
carrying the first 24 and retrying six only. It credits zero recovered facts and eight partial
matches. No final live comparison exists yet.

The older expanded evidence's `.7` reassessment exposed a semantic-judge inconsistency for
Ana Botín: it labeled `santander-chair` recovered while its rationale explicitly acknowledged
missing the September 2014 start date and fourth-generation detail. This positive is not accepted
as evidence of improvement. The raw judgment remains inspectable, and any final positive
comparison must be checked against the underlying reference and claim text.

## False challenge classification excluded readable biographies

Tracing the completed expanded run exposed a production source-reader defect: Cary Fowler's
Wikipedia page was recorded as a bot challenge. A fresh call through `createHttpFetch` returned
HTTP 200 and 230,075 characters of ordinary article HTML. The only trigger in the detector's
first 20,000 characters was `captcha` in Wikipedia's editing configuration at offset 3,514
(`wgConfirmEditCaptchaNeededForGenericEdit: "hcaptcha"`, with force-show false). The old detector
treated any such token as an access wall, even though the article was anonymously readable.

Two composition regressions first failed: an ordinary biography with that editing configuration
and an article discussing CAPTCHA accessibility. The corrected detector removes script, style
and template content before evaluating ordinary visible access messages, requires an affirmative
CAPTCHA instruction or specific title, and preserves actual Cloudflare challenge scaffolding.
Real CAPTCHA and sign-in cases remain classified. All 62 composition tests passed, including
independent Spec review; the HTML collector version is now `2026-09-06.1`.

The same live HTTP response now returns no challenge. A separate isolated production reader
check retained 15,238 biography characters and delivered them to a controlled extraction
observer, with zero challenge attempts. This check made no model call and establishes source
delivery only. Sanitized before/after results are in the diagnostics artifact directory.

A fresh full expanded live run in `reader-fixed-expanded-2026-09-06` measures the corrected
reader with the unchanged corpus, configured GLM model and expanded allowances, and judge `.7`.
The earlier expanded evidence and its ongoing reassessment remain immutable diagnostics; they
cannot acquire the previously rejected articles through reassessment. The fixed-document path
supplies retained documents directly and is unaffected by this HTML access detector change.

The reader-fix tree passed `pnpm run check:all`: 2,099 unit tests, 82 browser tests and all
static checks (`/private/tmp/issue-228-check-all-challenge.log`). Coverage passed unchanged
floors: statements 84.44%, branches 74.17%, functions 86.88%, lines 86.80%
(`/private/tmp/issue-228-coverage-challenge.log`). Both Docker images built; an empty temporary
Workspace boot returned `{"ok":true}`, and the verification container and network were removed.
Logs use `/private/tmp/issue-228-docker-*-challenge.log`. The fresh benchmark has already
retained Wikipedia source versions through the corrected reader; final coverage remains pending.

The older expanded reassessment `e1b50cd7d30b28a3` finished all 30 selected people with 24
complete assessments, one model-credited recovery (the rejected Ana Botín positive above),
four partial matches, zero critical integrity findings and zero wrong-person findings. Its six
failed assessments remain explicit. Running the CLI comparison against incumbent
`f93fe67376b87cec` exited 1 with `not-comparable`, correctly rejecting the incomplete candidate.
The JSON/Markdown comparison is in `pre-reader-repair-comparison-2026-09-06`. Further recovery
is focused on the fresh reader-fix run; this superseded population remains diagnostic evidence.
