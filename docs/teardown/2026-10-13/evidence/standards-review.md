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
