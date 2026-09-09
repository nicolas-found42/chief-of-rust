# Standards review — 2026-09-05

Reviewed the working-tree implementation against `b6c85a64775e8f62e69e87fd3b1c8b6f5e9f6b50`, including the untracked Workspace notification, Task cutover, shared contract and cutover tests. Excluded the unrelated `.claude` skill deletion. Read root agent guidance, the domain glossary and applicable persistence, migration, Tasks, Weekly Briefing and Person Profile ADRs. Tool-enforced formatting/type/lint concerns are excluded; verification gates remain the coordinating agent's responsibility.

## Final follow-up

Re-read the final authorization revision handling, canonical cutover bundle/preview, Meeting-owned Weekly projection, composition seams, queue continuation, SIGKILL fixture and production queue-entry coverage. The Spec report was not consulted. Final cold verification gates are owned by the coordinating agent and were still running during this review.

## Hard violations

None outstanding. **Resolved: restart incorrectly treated as reconnection.** `apps/server/src/tasks/external-link.ts:174` now establishes the constructor baseline; authorization failures retain their credential revision, and refresh distinguishes unchanged credentials from reconnection. `tests/src/api/task-sync.test.ts:219` covers a reconstructed service making no automatic provider call with unchanged credentials and resuming after the revision changes. This satisfies the previously flagged ADR-0056 requirement by code inspection and regression coverage; this review did not independently rerun the tests.

## Possible smells — judgment calls

- **Duplicated Code / Data Clumps** — `apps/server/src/person-profile/research.ts:179` and `:465` construct the same persisted traversal checkpoint in two places, with different cursor and pending-source handling. Consider one local checkpoint writer accepting the next pass/results/pending-source values to keep traversal limits and serialized fields aligned. Optional maintainability work, not a correctness blocker.

No additional actionable findings from the remaining baseline smell categories. The non-destructive canonical Task migration follows the explicit handoff and ADRs 0055/0059; the older destructive-reset decision is historical context, not a reason to restore deletion behavior.
