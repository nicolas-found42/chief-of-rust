# Separate Spec review

Reviewed `git diff 3155bf2bd6023e0d16fa435733bdf76e29811a83...7112f6367788de20714f887d3698754a95e38718` against the user's teardown request and accepted retrieval/provenance/proxy scope. No unresolved material Spec finding remains in the reviewed patch. This is a bounded review, not an exhaustive product certification.

## Initial concern and resolution

**S1 / P2 — optional empty search discarded useful manual evidence.** The documented People workflow says, “Public search is optional” (`crates/app/src/people.rs`); the accepted empty-collection criterion concerns an empty overall source collection. At `bf48082`, shared `search_results` rejected zero selected snippets before People could use its nonempty saved evidence. The initial test suite covered empty watches, but omitted manual evidence plus empty optional search.

[manual-regression-before.log](manual-regression-before.log) demonstrates a failed Run with zero dossiers despite saved manual evidence. The revised HTTP/router/worker holdout tests both an empty result array and a blank snippet. [retrieval-final.log](retrieval-final.log) records both completing with one dossier. Assertions inspect the saved manual evidence, its exact supported quote, and `selected=0` coverage.

The corrected collector returns valid empty results with coverage. Content watches/projects retain their nonempty search-evidence guard; People retains its combined-evidence guard. HTTP failures, malformed result lists, and invalid JSON still propagate errors. The current log preserves failed empty watches with zero reports and the other failure controls. **Disposition: fixed and verified within the fixture path.**

## Judgment evidence and boundaries

Initial Jev verification: regression supports/contradicts/silent `0.85/0.14/0.01`, confidence `0.77`, review; missing-test claim `0.99/0.01/0`, confidence `0.98`, auto. Resolution verification on actual delta and before/after logs: corrected manual path `0.71/0.28/0.01`, confidence `0.56`, review; preserved empty/error controls `0.54/0.45/0.01`, confidence `0.31`, review. No claim was contradicted, but neither resolution judgment earned automatic acceptance. Stronger agent review resolved them by inspecting actual guards, the two distinct fixture inputs, saved-record assertions, and red/green logs. Model confidence does not replace this evidence.

No new dependency or unrelated behavior surfaced. Unchanged matters were not re-judged to obtain approval. This review does not establish anonymous live web completeness, platform universality, or full final-gate completion; the root verifier owns current whole-tree gates and completion claims.

## Final completion audit

Independently inspected the report, final source/tests, saved-record assertions, and supplied final logs. Source is unchanged between `7112f636` and report/evidence HEAD `a706627`. The current ordinary log sums to 72 passed, zero failed, two explicitly ignored live tests; the separate live log shows both passing. fmt/check/clippy logs are successful. Image build records a release binary and image digest; boot is healthy; smoke and restart logs reread a saved Task. Cleanup records only the task Compose project removed, its volume retained, and the original five edited files unchanged.

The applicable new behavior has positive, negative and discriminating controls: real HTTP through router/worker into saved records for all three consumers; fragment deduplication with later sources; distinct query parameters; Unicode truncation; invalid/blank rows; bounded/escaped failed-engine diagnostics; empty watch without report; HTTP/shape/JSON failures; manual evidence with optional empty/blank search; legacy report/artifact decoding; exact dossier quotes; and a before/after proxy request witness. Shared consumer guards explain the corresponding empty-project behavior. Existing suites cover stale records, review/export lineage, unsupported citations, connection fencing and durable work admission. The live watch supplements fixtures; fixture assertions do not establish natural-web relevance or source truth.

No essential missing check or wrong bounded completion claim was identified. The final gate's reported generic test-gap confidence `0.25` and safe-to-apply `0.54` are uncertainty signals, not concrete defects. This stronger review resolves that bounded uncertainty through the source paths and observed assertions/logs above. It does not derive confidence from model agreement or waive a discovered risk. Dependency manifests, lockfile, Docker and workflow files have an empty baseline-to-final diff, resolving the reported dependency-confidence doubt deterministically.

Local accepted fixes can be called complete within the report's stated boundaries. Publication still requires the five CI checks on the exact PR head and matched-head squash merge; no publication outcome is asserted here. Broad platform/accessibility/account/format coverage remains explicitly limited. Previous judgment outputs are preserved in [spec-judgments.json](spec-judgments.json); unchanged judgments were not rerun and thresholds were not altered.
