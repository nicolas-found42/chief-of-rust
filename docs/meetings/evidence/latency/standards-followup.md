# Standards follow-up: fulfillment and benchmark metrics

Scope: additions after the completed scheduling review; base remains
`86f8f3721e4167ca609d8112f461efa1c56d3cdd`. The earlier report is
preserved. No implementation edits or private corpus access by this reviewer.

**Documented standards:** no remaining demonstrated breach. Fulfillment
changes intermediate findings before publication, retains source-linked raw
judgments and excludes proposals without changing Tasks (debrief.rs:698–747).
The new regression rereads saved status/probability/source identity and checks
empty proposals, ActionItem and Task records (meetings.rs:1151–1177).
fulfilled-before.log fails on an outstanding proposal; fulfilled-final.log
passes after the fix. Prompt clarification strengthens existing attribution
and null contracts rather than inventing new owners or extra commitments.

**Heuristics:** no material new smell. The bounded fulfilled question uses
the existing reconciliation batch and thresholds. No new provider, generic
framework or speculative execution path is introduced.

**SF1 — confirmed measurement-output defect; fixed and verified.**
The initial helper converted missing Jev cost to zero in combined estimates.
A synthetic successful Run with an $8 Mistral estimate and unknown Jev price
reported combined $8. That understated unknown spend; the prose boundary
did not make the numeric total complete (meeting_benchmark_metrics.py).

Current helper returns combined null and jev_cost_known false for missing
prices. Four executed synthetic cases verify successful unknown, successful
known ($8 + $.25), and sticky unknown failed-checkpoint costs in both orders.
No provider or corpus was used. Failed upstream charges remain explicitly
incomplete; these probes do not establish invoice accuracy.

release-test.log deterministically sums to 93 passed, zero failed, nine
ignored across 15 result blocks. Jev could not corroborate this arithmetic
claim within mixed red/green evidence (unsupported/review .43); the exact
log-only parse resolves the count without treating model arithmetic as proof.
Ignored live checks are not implied by ordinary results.

Jev follow-up patch review escalated: safe_to_apply .43, composite .7361875,
minimum confidence zero; preserved without unchanged retries. Verification
supports fixture fulfillment evidence .92/.88, original cost defect .98/.97,
and current cost fix .91/.86. These are bounded claim checks, not automatic
whole-patch approval. Real semantic benchmarks, final report and completion
gate remain the parent task's work.

Count: one confirmed helper defect fixed; no remaining hard standards
violation or material heuristic finding.
