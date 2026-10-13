# Narrow Spec review — literal date schema

Reviewed only new `source_dates`, due-enum schema hunks and deadline regression against fixed baseline `86f8f3721e4167ca609d8112f461efa1c56d3cdd`, plus current red/green and date-release logs. No private transcript reads or provider submissions.

**No concrete defect found.** Requirement: “Optimize … without weakening the evidence checks.” Due values are now bounded to JSON null or calendar-valid literal YYYY-MM-DD substrings in spoken segment lines. ASCII shape checks make ten-byte windows safe with Unicode input; existing chrono validates day/month/year. A sorted set removes repeated values. Dialogue selection excludes the Fireflies metadata used by this fixture. No date is synthesized from a relative phrase.

This enum bounds candidate values; it does not establish a deadline's association with an action. Runtime calendar parsing, exact source presence, Jev association checks and original uncertainty thresholds remain. A conforming output cannot contain the string “null” for due. Nonconforming provider responses still fail existing validation; universal provider adherence is not claimed. Date-shaped substrings alone are not spoken commitments.

The regression's original red result has no due enum. Corrected green constructs exactly `[null,"2026-01-05","2026-10-16"]`, excluding invalid days/months and metadata, and deduplicating valid dates. Full-line deterministic aggregation of date-release Cargo summaries gives **94 passed, 0 failed, 9 ignored**, recorded in [date-spec-counts.json](date-spec-counts.json). This supports schema construction and regression coverage, not measured live-provider reliability. Final fresh long/short benchmarks are running.

Jev selected source enumeration over pattern/coercion/retain in the recorded decision (0.96; no contradicted requirements). Narrow raw-hunk review escalated (safe_to_apply 0.27, composite 0.7075; correctness/blast-radius confidence 0), with no concrete diagnosis. Bounded verification supported enum scope at 0.95/confidence 0.92 and unchanged association gates at 0.96/0.94; red/green scope at 0.84/0.76 remained review. Direct source and actual assertion/log inspection resolves the latter; preserve all signals and require final live evidence/gate.

Earlier reviews remain completed phase snapshots. New nonprivate fulfilled-target metadata now documents the recorded-extraction/fresh-Jev target changing supported/capturable to needs_review/noncapturable with max fulfillment 0.26; this is fallible signal/policy evidence, not proof of real-world completion.
