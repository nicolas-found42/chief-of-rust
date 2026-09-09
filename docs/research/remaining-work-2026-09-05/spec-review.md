# Spec review — final follow-up

Reviewed working-tree changes against `b6c85a64775e8f62e69e87fd3b1c8b6f5e9f6b50`, refreshed issues, ADRs 0052–0062, and audit. Independent Spec axis only. Final follow-up was limited to verifying the reported fixes and their regression assertions; no further broad review was performed.

## Finding reconciliation

- **Wrong-URL resumed evidence — fixed.** Pending retained content must match the current result URL; unmatched results are checkpointed as visited. This satisfies #206's requirement that “Unmatched identities and copied-source counts cannot establish factual support.” Continuation coverage includes retained-source recovery after process termination during extraction.

- **Daily-rollover checkpoint loss — fixed.** Paused jobs coalesce without resetting traversal or per-profile consumption. The rollover regression asserts that search/retrieval are not repeated and consumed per-profile calls survive. This addresses #207: “Resume finite interrupted work after restart.”

- **Uncertain creation recovery reopening completed Tasks — fixed.** Both waiting and lost-response creation records now store the actual provider creation baseline, `open`; `recoverCreation()` uses `retry()` to reconcile and push pending local changes. The parameterized recovery regression covers open/completed local status across Google and Asana, verifies one remote creation, and asserts preserved canonical completion and the corresponding provider status write. This addresses #185: “Local completion and reopening are pushed to the linked Google Task.”

- **Historical continuation switching to current-only scope — fixed.** `lastHistoricalAt` is now stamped only for completed `current` or `empty` outcomes, preserving historical scope across an incomplete daily pause. The real queue/research rollover regression captures the model request and asserts “Full historical” after restart, while confirming saved traversal and consumption. This addresses #207's continuation requirement and #208's separate historical/current freshness policy.

No unresolved confirmed Spec finding remains from this review. The parent reports the targeted recovery and queue suites passing; this follow-up inspected code and regression assertions without independently rerunning them. Whole-tree gates, browser/production acceptance, and authorized live-operation evidence remain separate and are not claimed passed by this report.
