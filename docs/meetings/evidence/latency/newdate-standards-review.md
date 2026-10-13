# Date schema: Standards review

Narrow follow-up to the preserved completed reviews; base
`86f8f3721e4167ca609d8112f461efa1c56d3cdd`. Reviewed source_dates,
the due schema field and the new contract assertion. No private corpus,
implementation edits or provider requests by this reviewer.

**Documented standards:** no demonstrated breach. The helper's comment
explains why a string shape permits invented dates/literal null text and
links latency finding F5 (debrief.rs:895–920). It changes generation
constraints, without rewriting finished records. The unit test reads the
actual schema enum rather than a summary (debrief/tests.rs:588–600).

**Heuristic smells:** no material new smell. The deterministic scan stays
in the debrief/schema module and uses existing chrono/serde dependencies;
no generic extraction framework or model judgment is introduced for a
known syntax rule.

Each window has exactly ten bytes, so indexes four/seven are safe.
Digit/dash predicates reject windows containing split Unicode bytes.
UTF-8 conversion and calendar parsing must succeed before a value enters
the sorted set. JSON null is always seeded; no-date input consequently
retains a nonempty enum. No relative date conversion or coercion occurs.

The allowed values are source substrings, not proof of deadline ownership.
Unrelated or embedded date substrings can enter the candidate universe;
existing calendar parsing, source containment and Jev association checks
remain necessary and present. This review does not establish live provider
schema conformance.

date-schema-before.log records the new enum assertion failing.
date-schema-after.log records it passing with two unique sorted valid
spoken dates, JSON null, and invalid/duplicate/metadata dates excluded.
The no-date/Unicode-only path is source-inspected, not separately exercised
by this test. An optional holdout was suggested; its absence does not show
a code defect.

Exact log-only parsing of date-release-test.log yields 94 passed,
zero failed, nine ignored across 15 result blocks. Ignored live checks
are not inferred.

Jev raw-hunk review escalated: safe_to_apply .30, composite .708,
correctness/blast-radius confidence zero. Preserved without unchanged
retries. Bounded verification supports candidate construction .94/.91
and retained checks .95/.92. The fixture/log interpretation remained
review (.69 support, .53 confidence); exact assertion and original/final
logs resolve its bounded meaning through source inspection. These signals
are not automatic patch approval. Fresh provider benchmarks and final
completion gate remain the parent task's work.

Count: no hard standards violations or material heuristic findings.
