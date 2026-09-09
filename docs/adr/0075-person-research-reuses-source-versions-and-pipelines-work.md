# Person research reuses source versions and pipelines useful work

The post-#315 investigation found repeated extraction through tracking aliases,
irrelevant registry queries, and useful reads waiting behind a batch barrier.
The maintainer requested implementation of the speed research on 2026-09-09;
we preserve ADR-0063's Completion Conditions and ADR-0074's model and time
allowances while changing the work that consumes them.

Canonical destinations identify retrieval work, while original discovery URLs
and observed destinations remain provenance. Exact text-version reuse stays
inside one Person Profile revision and operation, where model, prompt, parser,
scope and rejection state are fixed. Capture dates, source versions, attribution
metadata and extraction ranges participate in retained-source identity. Existing
source IDs remain valid; new versions never rewrite a previously cited record.
Copies remain one content family and cannot manufacture independent support.

Ready reads proceed to bounded extraction, with publication serialized and every
retained unfinished document checkpointed. The legacy singular checkpoint is
still readable; new checkpoints also carry the complete set. Source reads and
model work have separate limits shared across operations in one composition.
Benchmark research and judging have separate worker queues and both must drain
before evidence can be removed.

Discovery receives explicit identity and coverage context. Organization records
resolve known organizations and do not assert the person's employment. Registry
and catalogue queries use their native entity inputs, with no industry exclusion.
Selection adjusts relevance using observed novel supported evidence and elapsed
processing time. The planner receives an exploration allowance for unchanged
evidence/coverage contexts; repeated equivalent claims cannot restart expansion
indefinitely. Deterministic expansion and all Completion Conditions still run.

Long documents keep the same 60k extraction envelope but select opening context
and relevant original-text windows. Exact offsets record what was read; the whole
retrieved text remains retained and extraction stays explicitly partial when
material is omitted. Timeline assessments use only revisions published by each
cutoff, and never infer that an operation completed at that time.

These are new benchmark conditions. The exact-#315 run and its 24/30 threshold
retain their original meaning. A speedup or quality improvement requires a new
comparison with fixed references and judge configuration; passing unit tests or
publishing many claims does not establish either improvement.
