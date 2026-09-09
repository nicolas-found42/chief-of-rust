# Content Research watches Named People and is its own Module

Content Research replaces Relay's LinkedIn-facing "11 profiles" watch (LI Content Researcher / LinkedIn Post Analyzer) with a people-first watch that survives the loss of LinkedIn. We decided it is its own Module watching Named People wherever they publish (not a Content Scout Source Target set with a different output), with a weekly People Discovery Run proposing Person Suggestions and a daily Run producing a per-person Resonance Report scored by velocity (z-score vs 90-day baseline) plus an LLM-extracted hook.

We chose people-first because the job is "what is *this person* saying that's landing, and why" — not "what did these feeds publish." A source-first config would conflate Content Scout's brand-aligned opportunity discovery with people-tracking and lose the per-person baseline that makes "resonating" meaningful. The separate Module keeps Content Scout's Source Discovery Run, Content Opportunity, and Content Pack intact while giving Content Research its own cross-Run index (primary by Person), Resonance Score definition, and Sheet ledger keyed on (person, canonicalUrl).

## `robots.txt` is not a gate

Story 8 of [#116](https://github.com/nicolas-found42/chief-of-staff-demo/issues/116) wrote "respect `robots.txt`" into the crawling posture. **We do not honour `robots.txt`**, on the owner's decision that it is not legally binding. This is recorded here rather than left to drift, because the spec text and the code have to agree: a future reviewer finding no robots check is looking at a decision, not an omission, and should not file it as a gap or build the check.

Every other commitment in that story stands and is load-bearing: bounded concurrency, per-host serialization, polite backoff honouring `Retry-After`, conditional requests via `ETag`/`If-Modified-Since`, and an honest User-Agent. Those are what keep the app from hammering public sources, and dropping the robots check does not license dropping them. The anonymous posture is also unchanged — no login, no imported cookies, no LinkedIn read.

## The Home notification is the Run summary

Story 20 asks for a Home notification per Run when at least one Person has new resonance. [ADR-0010](0010-home-is-shell-status-surface.md) makes Home a Shell status surface derived from Runs across every Module; there is no push surface for a Module to write into, and adding one would put a second, Module-owned copy of state behind the Shell's own reading of it.

So the daily Run's summary — which names the resonating people and their scores — *is* the notification, and it reaches Home's Recent activity by the ordinary path every Module uses. The `home_notification` Run event stays as the durable record that the condition was met on that Run, not as a second surface. Story 20 is satisfied by the Shell's existing mechanism rather than by a new one.
