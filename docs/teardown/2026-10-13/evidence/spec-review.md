# Separate Spec review

Reviewed `git diff 3155bf2bd6023e0d16fa435733bdf76e29811a83...7112f6367788de20714f887d3698754a95e38718` against the user's teardown request and accepted retrieval/provenance/proxy scope. No unresolved material Spec finding remains in the reviewed patch. This is a bounded review, not an exhaustive product certification.

## Initial concern and resolution

**S1 / P2 — optional empty search discarded useful manual evidence.** The documented People workflow says, “Public search is optional” (`crates/app/src/people.rs`); the accepted empty-collection criterion concerns an empty overall source collection. At `bf48082`, shared `search_results` rejected zero selected snippets before People could use its nonempty saved evidence. The initial test suite covered empty watches, but omitted manual evidence plus empty optional search.

[manual-regression-before.log](manual-regression-before.log) demonstrates a failed Run with zero dossiers despite saved manual evidence. The revised HTTP/router/worker holdout tests both an empty result array and a blank snippet. [retrieval-final.log](retrieval-final.log) records both completing with one dossier. Assertions inspect the saved manual evidence, its exact supported quote, and `selected=0` coverage.

The corrected collector returns valid empty results with coverage. Content watches/projects retain their nonempty search-evidence guard; People retains its combined-evidence guard. HTTP failures, malformed result lists, and invalid JSON still propagate errors. The current log preserves failed empty watches with zero reports and the other failure controls. **Disposition: fixed and verified within the fixture path.**

## Judgment evidence and boundaries

Initial Jev verification: regression supports/contradicts/silent `0.85/0.14/0.01`, confidence `0.77`, review; missing-test claim `0.99/0.01/0`, confidence `0.98`, auto. Resolution verification on actual delta and before/after logs: corrected manual path `0.71/0.28/0.01`, confidence `0.56`, review; preserved empty/error controls `0.54/0.45/0.01`, confidence `0.31`, review. No claim was contradicted, but neither resolution judgment earned automatic acceptance. Stronger agent review resolved them by inspecting actual guards, the two distinct fixture inputs, saved-record assertions, and red/green logs. Model confidence does not replace this evidence.

No new dependency or unrelated behavior surfaced. Unchanged matters were not re-judged to obtain approval. This review does not establish anonymous live web completeness, platform universality, or full final-gate completion; the root verifier owns current whole-tree gates and completion claims.
