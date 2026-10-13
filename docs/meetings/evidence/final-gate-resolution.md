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

## S3 incremental final gate

After the earlier four gates, a measured compatibility defect was fixed in the
weekly consumer. Its new raw delta received a separate gate after new Cargo,
Docker and live-consumer checks. Safe-to-apply was 0.32, composite 0.764333;
the gate escalated, chiefly test-gap/blast-radius confidence. Its live-consumer
claim was verified at confidence 1; its count claim was contradicted at low
confidence 0.34 and source-projection claim unsupported at confidence 0.25.
Those signals remain in `gate-weekly-final.json`; the gate was not repeated.

Primary stronger reasoning resolution: deterministic current log aggregation
is 90 passed, zero failed, eight ignored (`final-count-after-weekly.json`).
The earlier 89/7 result is preserved in `test-log-before-weekly.json` and applies
to the earlier revision. Direct source inspection shows canonical artifacts
are still parsed and retained for before/after revision checks; only a separate
provider-state object copies narrative, identity, proposals and approvals.
The executed regression asserts a source quotation reaches generation, raw
audit marker does not, canonical job/artifact history retains that marker, and
the saved WeeklyReview has the expected body, dates and meeting ID. The original
code failed the same consumer bound. Actual saved live input is 571,090 bytes;
projected evidence is 48,685 bytes. The fresh live Mistral consumer saved one
review in 35.038 seconds. These source and runtime witnesses resolve the narrow
gate concerns, with no claim of weekly prose accuracy. No additional concrete
defect or essential missing check is established. Current-head CI is still
required after publishing this final delta.
