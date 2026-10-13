# Standards review

## Initial review

Revision: `3155bf2bd6023e0d16fa435733bdf76e29811a83...bf48082`.
Sources: `AGENTS.md`, `CODING_STANDARDS.md`, and
`docs/agents/{verification,domain,pr-workflow}.md`.

- One qualified, low-priority documentation mismatch: explanatory production
  comment blocks in `integrations.rs` at lines 312, 336 and 479 explained the
  decisions but omitted the issue reference required by
  `CODING_STANDARDS.md:44`. If “block comments” means only `/* */` syntax,
  this is a convention ambiguity rather than an unambiguous hard breach.
- No durable-record test breach: the real HTTP child-process tests read saved
  URLs, snippets, Unicode truncation, coverage counts, project artifacts and
  dossier quotes. Reopening SQLite compares the entire saved watch report.
  This satisfies “A test asserts the record, not only its summary.” The
  earlier generic Jev test-gap escalation supplied no concrete defect.
- The proxy test establishes zero requests to an explicitly configured
  ambient proxy. It does not establish successful direct fetching,
  comprehensive SSRF protection, or a default Docker exploit.
- No actionable baseline smell, enum reachability defect, finished-record
  rewrite or dependency addition found. Tooling checks were not duplicated.
  Untracked teardown documents were outside the committed review diff.

Initial result: zero unambiguous hard breaches, one qualified comment
traceability mismatch, zero actionable smells or substantive test gaps.

## Followup resolution

Revision: `bf48082...7112f63`; review only the new changes.

The three production comment blocks now name existing issue #11 and the
relevant teardown finding: F1 for document identity, F3 for bounded provider
diagnostics, and F4 for connecting to the checked address. The initial
comment traceability mismatch is resolved. Issue #11 covers the five product
areas, source citation membership, exact quoted passages and source records;
the teardown findings supply the detailed collection rationale.

The new README paragraph is hand-wrapped. The optional-empty-search test
reads the saved dossier's evidence kind, claim quote and zero-source coverage.
No new standards violation or actionable smell found. The optional-search
behavior itself belongs to the separate Spec review. No tests were rerun by
this reviewer; no unchanged judgments were repeated.

## Judgment evidence

Provider: OpenRouter; model: `typesafe/jev-1.13-20260917`.

| Verify claim | Supports | Contradicts | Says nothing | Confidence | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial comment qualification | 0.99 | 0.01 | 0 | 0.98 | auto |
| Durable-record assertions | 1 | 0 | 0 | 1 | auto |
| Proxy evidence boundary | 1 | 0 | 0 | 1 | auto |
| Followup resolves comment references | 1 | 0 | 0 | 1 | auto |

Initial verification used 1,960 input / 318 output tokens; followup
verification used 900 / 107. Both returned no unresolved review actions.

Issue #11 screening returned `review`: injection 0.27, substance 0.98,
relevance 0.84; thresholds review 0.25 / block 0.75; usage 931 / 57 tokens.
Agent inspection found declarative product and verification requirements,
with no concrete attempt to redirect tools, obtain credentials or override
agent instructions. Retained as specification evidence only. The screening
signal is not proof of malicious content.

## Final report and evidence audit

Audited documentation HEAD `a706627278135e32b9dc93de088e6c78537c4fff`;
verified source revision `7112f6367788de20714f887d3698754a95e38718`.
The source/test diff between those revisions is empty. This audit does not
repeat unchanged judgments or manufacture automatic Jev approval.

- `tests.log` independently sums to 72 passed, zero failed, two ignored.
  `live-mistral.log` records both ignored live tests passing separately.
  The final fmt/check/clippy logs are successful. Image digest in
  `verification.json` matches `final-image.log`; final boot is healthy and
  `final-persistence.log` reports saved Task persistence after restart.
- `retrieval-final.log` shows empty watch and HTTP/shape/JSON failure controls,
  eight distinct useful snippets with persisted coverage, both optional-empty
  manual-evidence cases, and zero configured-proxy requests. The actual tests
  assert records. No concrete essential missing check was identified behind
  the final gate's generic test-gap uncertainty (reported confidence 0.25,
  safe-to-apply 0.54). The earlier `search-holdout-final.log` predates the
  optional-search correction; current whole-tree and HTTP logs supersede its
  earlier empty-collector expectation. Preserve that historical log.
- Exact Git comparison finds no dependency-manifest, lockfile, Dockerfile,
  Compose or CI change against the baseline. This settles the no-addition
  claim deterministically despite the gate's reported dependency confidence
  0.70; it does not assert eligibility for any existing paid provider.
- The original five-file diff equals the saved baseline diff byte-for-byte
  (3,802 bytes). Quarantine exists. Current task Compose inventory is empty;
  cleanup logs record removal of only the task project. No existing
  production-state changes were observed; that is bounded evidence, not an
  exhaustive machine audit. The final browser remains view-only because its
  last-tab close was denied; browser cleanup is therefore incomplete.
- All report-local evidence links resolve. A targeted scan of 37 text files
  found no private keys, bearer values, Google/GitHub tokens or long assigned
  credentials. Reviewed metadata uses credential-presence booleans, public
  source URLs and fictional records. This is not an exhaustive secret audit;
  the report's absolute no-secrets claim exceeds the scan's generality.
- Raw logs retain original trailing whitespace. A full `git diff --check`
  can flag that evidence; rewriting finished logs would damage preservation.
  Source/Markdown checks should be reported separately. Scope limits and the
  outstanding current-head CI/squash-merge delivery gate remain explicit.

Result: local accepted-fix verification is supported; no source change or
new essential local check is required. Publication completion awaits the
delivery record. Final Jev uncertainty was resolved through stronger bounded
review and deterministic evidence, not relabeled as an automatic pass.
