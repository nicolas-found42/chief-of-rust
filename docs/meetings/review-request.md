# Meeting debrief request and acceptance criteria

The user requested a thorough debrief from the local Fireflies transcript
collection: action items, summary, tone, completed tasks, open questions and
related outcomes. They explicitly requested TypeSafe/Jev within application
behavior as well as development, with Choice, Noul and Score; evidence checks,
probabilities, uncertainty, source fidelity, server-side credentials, concrete
experiments, real checks and a final Jev gate.

The target is latest main in the previously authorized isolated worktree,
base `e0f69d21bd2c772dc259ba6c79e8334ca47ce2f3`. Existing user edits in the
original walking-skeleton checkout remain outside this work. The new request
adds Jev judgments to the prior single-provider model decision; generated prose
remains Mistral Large 4. Existing installed OpenRouter account access is used;
no new software dependency or account was added.

Acceptance criteria:

- Separate topics, decisions, future commitments, reported completed work,
  unanswered questions, risks and suggestions from confirmed spoken evidence.
- Exclude Fireflies generated summaries/action lists and access metadata.
- Attach exact source quotations and original transcript line references.
- Classify and audit evidence/owners/deadlines; uncertain or conflicting
  candidates cannot become captureable actions. Preserve relative deadline text.
- Judge written conversational tone, tension and transcription usability,
  with raw distributions and explicit limits. Do not infer actual emotions.
- Check every bounded segment for counterevidence to consequential findings;
  preserve all dialogue lines within documented resource bounds.
- Consolidate supported semantic repeats without erasing source records.
  Match reported completed work to related Tasks with an explicit no-match path;
  do not change Task status or execute external actions.
- Preserve source revision fences, reviewed capture and idempotency, historical
  artifacts and durable attempt evidence. Fail clearly on missing providers,
  invalid responses, screening review/block, oversized input and outages.
- Exercise real provider behavior on representative/ambiguous/negative cases;
  distinguish synthetic labels, HTTP fixtures, corpus format checks and live
  semantic coverage. Measure tokens, reported costs and latency; retain failures.
- Run Cargo gates and isolated Docker/native-form checks. Review the actual final
  diff with Jev and resolve required concerns before completion and green merge.

September 2, 2026 corpus file ending `83C2ZZFS` is excluded from further semantic
use at the user's explicit direction after a Jev block. Its content must not be
read or sent to a provider for this review. Other corpus files are authorized
for local testing with necessary evidence sent to the configured providers.

This is an implementation review in progress. Live long-meeting verification,
final Docker image verification, final judgment gate and CI/merge remain pending.
Review current source and tests; do not treat this document as completion proof.
