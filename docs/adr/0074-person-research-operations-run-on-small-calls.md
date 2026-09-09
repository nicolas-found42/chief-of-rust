# Person research operations run on small calls

The expanded Person Research Operation's model calls were sized for strong models: one
extraction call per document over as much as 60k characters, planning under the default
`response_format` binding with no retry, and one 300 s absolute ceiling shared by every
call. On very cheap models that shape is the failure mode itself: the pinned
`inception/mercury-2.5-preview` planner answered its declared `response_format` with prose
eight times in one run (`answer_not_json` had no recovery seam), and every recorded live
expanded arm ended with model calls barely half spent against the wall-clock backstop. We
re-pinned the operation's call shapes — an ADR-0063 conditions change, taken by the
maintainer on 2026-09-08 — so each call is small enough for a cheap model to answer
reliably:
- **Extraction in parts.** A document's text is extracted in parts of at most 16k
  characters — the same 60k-per-document envelope the former single call read, now as
  up to four calls — one model call per part; per-part record ids are prefixed before
  the parts combine into one source's extraction, so a model's locally-invented ids
  from different parts can never collide.
- **The allowance pair is rebalanced, not inflated.** The per-operation model-call
  allowance moves 60 → 180 while the 900 s wall-clock backstop is unchanged. Each call is
  now several times smaller in both input and bounded output, so the same source volume
  needs more calls; the rebalance keeps wall clock the binding constraint. The total
  characters moved per operation does not grow.
- **Small calls get a small ceiling.** Discovery claim extraction, extraction parts and
  planning run under a 120 s absolute ceiling; judges keep 300 s. A stalled small call
  costs at most the 90 s silent ceiling plus change, instead of holding a slice of the
  operation's budget for five minutes.
- **A prose answer is a binding question, not a dead end.** `answer_not_json` joins the
  binding step-down set: a model that answers prose under `response_format` is asked at
  the next binding instead of ending the call. The planner also declares
  `forced_tool_call` and carries the same one-retry the extraction calls have — the
  measured contrast is that judges using `forced_tool_call` answered 28–30/30 while
  `response_format` planner calls drew prose from the same routes in the same window.
- **The judge answers with high reasoning effort.** Judges are benchmark-only machinery;
  the product never runs them. The cheap system under test is measured by a strong judge,
  so population-scale completeness is measured rather than withheld.

Considered and rejected: slicing the operation into budget-limited passes (superseded
operating model per ADR-0063's continuity rule); capping lead materialization by rank
(re-creates the removed reading-cutoff regression pinned by the composition tests);
raising budgets without changing call shapes (masks the lead-flood drowning instead of
removing it).

The changed conditions are recorded in both benchmark pipelines' condition rows; runs
recorded under the old shapes stay as honest records of those conditions and are not
compared arm-to-arm against runs under these.
