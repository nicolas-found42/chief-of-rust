# Spec review — 9671dae against e0f69d2

Reviewed the actual source, raw diff, unit/HTTP/live-policy tests and recorded Cargo results. Docker/long-meeting checks and final gate remain in progress; no completion claim is inferred from those pending steps.

**S1 — P2: early overlap dedup can erase the better or materially different finding** — `crates/app/src/meetings/debrief.rs:530–543`. Requirement: “Consolidate supported semantic repeats without erasing source records” and “uncertain or conflicting candidates cannot become captureable actions.” The first duplicate check discards a candidate on equal kind/text/shared quote, ignoring status, owner, due and relative deadline. An earlier `needs_review` result followed by a supported overlap result retains only the uncertain item; distinct owner/deadline records likewise disappear before cross-segment reconciliation. This can conceal useful or conflicting evidence and make extraction order affect available actions.

Counterevidence: durable traces retain drafts/evaluations; loss concerned visible results. Other requirements have source/test witnesses for citations, tone limits, failure handling, reconciliation, Task no-match/no mutations, freshness and reviewed capture. No scope creep found.

Jev verified the original behavior at support/confidence 0.96/0.94 and 0.89/0.83. Raw-diff review escalated (`safe_to_apply=0.28`, composite 0.599625; weakest test-gap confidence 0). This is uncertainty, not another defect; the unchanged review was not repeated.

## S1 resolution — corrected source, red/green evidence

Early discard removed; every candidate now reaches reconciliation before record-preserving semantic dedup. Controlled original-code reproduction failed (1 record versus expected 2); corrected regression passed all 8 HTTP/durable-worker tests. Three synthetic modes verify uncertain→supported preservation, distinct attribution retention, and identical supported duplicates retained with a reference. These fixtures test policy composition, not live semantic accuracy across real chunk boundaries. Bounded Jev verification: support/confidence 0.98/0.97, 0.99/0.98, 0.94/0.91; all auto. S1 is fixed and verified within this scope; required final whole-tree/image/live checks remain parent work.

## S2 resolution — capture identity

Requirement: “Preserve … reviewed capture and idempotency.” Original capture dedup used artifact/title, merging distinct supported owner/deadline proposals. Red capture regression saved 1 instead of 2. `generation.rs:305` now uses artifact/proposal identity for structured debriefs; historical artifacts retain artifact identity. Repeated capture stays guarded in the same transaction. Current final-test log passes all 8 integration tests; extended fixture captures each attribution twice and verifies exactly 2 proposals and both owner/deadline pairs.

S2 fixed within this scope. Historical branch compatibility is source-inspected, without an executed historical capture regression. Jev verified all four bounded claims but flagged review (support/confidence 0.54/0.31, 0.60/0.40, 0.70/0.55, 0.71/0.56). Stronger source/assertion/log inspection resolves deterministic behavior; signals retained, no unchanged retry.

[Gate resolution](spec-gate-resolution.md).
