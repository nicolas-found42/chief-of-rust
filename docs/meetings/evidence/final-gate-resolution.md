# Final gate resolution

Four bounded gates cover the actual pipeline/records, integration, test and
configuration/report diffs. Every payload preserved raw hunks below the tool's
per-file cap; no truncation was reported. All four escalated. Pipeline,
integration, tests and config composites were 0.721625, 0.545278, 0.743714 and
0.7745; minimum safe-to-apply signals were 0.26, 0.12, 0.38 and 0.29.
These are unfavorable signals, not approval. The same gates were not repeated.

The installed Jev skill permits escalation to a stronger reasoner. The primary
reasoning review and the Spec review inspected actual source and tests instead
of changing thresholds. [Spec resolution](spec-gate-resolution.md) independently
resolves the named test-count, long-run, citation and capture claim concerns.
The integration gate's confident capture contradiction (0.92 / confidence 0.88)
is defeated by the current passing executed assertion and source identity fix;
the historical red result predates that fix. The cause of Jev's disagreement is
unknown; confusion between historical and current logs is only a hypothesis.

Additional primary reasoning review:

- `judgments.rs`: HTTPS/auth configuration rejects embedded credentials and
  redirection; bounded response parsing rejects missing/unknown questions,
  invalid distributions, inconsistent confidence/score and warnings. HTTP
  fixtures execute the native endpoint/authentication contract. This supports
  the narrow malformed-response claim, not an absence of all possible failures.
- `generation.rs`: original source/context fences remain before publication
  and capture. New capture keys bind artifact plus proposal; legacy keys remain
  intact. Two distinct attributed records and repeated captures are asserted
  after rereading SQLite, with owner/date values. The low-confidence spec-match
  rubric supplied no further concrete defect beyond those now corrected.
- `llm.rs`: existing paths keep their behavior; measured schema completion adds
  usage. Timeout/truncation/provider errors still fail. Both live Mistral suites
  passed; the subsequent capture-only edit does not change model requests.
- `intake.rs` and `work.rs`: source line anchors and escaped stage details add
  observable evidence, without new input authority or provider actions. Native
  forms exercised missing transcript, confirmed association, generation,
  review/capture/acceptance and exact source navigation. Final image boot and
  existing artifact/Task reads establish packaging/persistence on this host.
- Constructor/configuration changes add the server-side Judge to every App
  path. Cargo check/clippy and all ordinary tests pass; endpoint/key values
  are absent from browser state. No Cargo manifest/lockfile changes exist.
- Tests are explicit fixtures, live/corpus tests opt-in. Assertions retain
  actual records, quotes, usage, statuses, source identities and Task values.
  Saved replay output explicitly labels recorded Mistral replies; fresh Jev
  is configured separately. The fresh complete long run is separate evidence.
- Documentation discloses metered OpenRouter prerequisites, private evidence,
  bounded coverage, small-control accuracy and latency. The user's requested
  Jev mode overrides an accountless-service assumption; no new package or
  research account was added. Docker build/healthy boot and `/healthz` 200 are
  observed, not inferred from a successful tool call alone.

The primary review finds no remaining concrete defect or essential missing
check established by these gate signals. It accepts the patch within the
reported evidence boundaries; this is a stronger reasoning resolution, **not
Jev automatic acceptance**. General semantic accuracy, exhaustive recall,
non-English/audio/accessibility/platform coverage and the original HTTP 400's
exact cause remain unresolved limits. Green current-head CI and merge are the
remaining publication gates.
