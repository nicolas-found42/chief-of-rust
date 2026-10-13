# Performance patch: Standards review

Baseline: `86f8f3721e4167ca609d8112f461efa1c56d3cdd`; reviewed the
subsequent uncommitted scheduling patch. Sources: AGENTS.md,
CODING_STANDARDS.md, verification.md, pr-workflow.md and domain.md.
No private corpus was accessed.

**Documented standards:** no remaining demonstrated breach. The scheduler
changes intermediate segment processing; finished artifacts/attempt records
are not rewritten. New timing fields have backward-compatible defaults.
Cancellation and source-order comments explain the correctness/cost reasons
for non-obvious choices (debrief.rs:646–659). README adds hand-wrapped
scheduling guidance without unrelated reflow.

One initial record-coverage concern was addressed during review:
meetings.rs originally checked checkpoint phases with `.all()`, allowing an
empty collection. Current :1051–1076 requires nonempty bounded checkpoints
and reads unique segment position, run, attempt, total, transcript identity
and injection probability. The stale “no witnesses” claim was rejected by
current source; Jev returned contradiction .89, confidence .83. This was
a test gap, not an observed production data-loss defect.

**Heuristic smells:** no material smell identified. SegmentResult bundles
the evidence/usage returned by one independent chain; extracting
analyze_segment creates a useful concurrency seam. JoinSet introduces no
unnecessary general framework. Clamping is small explicit resource policy.

**Cancellation evidence:** analyze_segments awaits shutdown before returning
a segment error (:649). The locked Tokio 1.53.1 source implements shutdown
as abort_all followed by draining join_next. This supports async-task drain;
it does not prove upstream requests or charges are undone. Results are
sorted by original index before durable assembly (:658–660). Fixture tests
read saved source order, generation count and concurrency, and assert zero
active siblings after failure.

meetings-tests-final.log reports 15 passed, zero failed, including the
strengthened cancellation regression. scheduling-final.log records fixture
peaks 1/2/4 for their configured modes. These establish scheduling behavior,
not provider accuracy or general latency guarantees.

Jev raw-patch review escalated: safe_to_apply .24, composite .55575,
test-gap confidence .28. Preserved without unchanged retries. Stronger
source inspection resolves only the bounded concerns above; verification
supports async drain .99/.98, source-order evidence .93/.89, strengthened
record assertions .89/.83 and the refreshed log 1/1. No automatic whole-patch
approval is claimed. Final full-suite, Docker, real benchmarks and completion
gate remain pending in the parent task.

Count: no remaining hard violations or material heuristic findings; one
record-test gap addressed.
