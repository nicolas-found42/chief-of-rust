# Exact proposed tracker updates

Drafts only. No GitHub mutation has been authorized or performed. Final passing gates are recorded in `verification.md`; these drafts are ready to accompany the verified commit. Publish these updates with the accompanying verified change; do not close parents that still require #202.

## #117 — Consolidate Content Engine, Person Profiles, Content Research, and Meeting Wizard

#172/#204 supersede historical task and identity policy. Implementation and regression evidence roll up from the rows below; exact live cutover #202 remains separately authorized.
Proposed action: keep open until the named release requirement is satisfied.

## #145 — Hub: Content Engine and Meeting Wizard implementation order (#118–#144)

Replace the claim that #144 is the only open ticket with: historical #118–144 work is complete/superseded; canonical Tasks release is #172, local acceptance #201, live cutover #202. Never execute the old reset. Native dependencies remain the tracker gate.
Proposed action: replace Current hold with the paragraph above and mark the old #144 execution wave superseded by #202, then close this historical navigation aid.

## #166 — Collapse the Transcript Catalog single-adapter seams

Transcript Catalog composition retains one intake/identity owner; no duplicate adapter was reintroduced. Verified by `modules/transcript-catalog.test.ts; composition/shell-composition.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #168 — Deepen the Meeting Brief Generator behind one enrichment seam

Meeting Brief production enrichment remains behind its composed provider interface. Verified by `modules/meeting-brief-google-enrichment.test.ts; composition/shell-composition.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #169 — Unify Content Project generation across targets

Nine-target generation remains unified; this change does not alter governed generation behavior. Verified by `modules/content-projects.test.ts; existing Content Engine browser journeys` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #172 — Make Workspace Tasks canonical and add a Weekly Meeting Briefing

Canonical Tasks, Action Items, connector recovery, Weekly generation/email and production composition are reconciled below. Release execution awaits #202 exact-Workspace authorization.
Proposed action: keep open until the named release requirement is satisfied.

## #179 — Dismiss, restore, and regenerate Action Items safely

Dismiss/restore/regeneration preserve canonical decisions. Verified by `api/action-items-routes.test.ts; tasks-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #181 — Automatically create confirmed owner Tasks

Confirmed-owner auto-promotion remains explicit policy; manual and external Task creation share canonical ownership. Verified by `api/auto-promotion.test.ts; api/action-items-routes.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #182 — Make Meeting Debrief email-only and non-expiring

Debrief remains email-only and non-expiring; no bulk provider Task publication was restored. Verified by `meeting-debrief-journey.spec.ts; composition/legacy-dual-write.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #183 — Migrate legacy local action review into canonical records

Crash between orphan Task creation and local completion now resumes completion; duplicate proposals no longer shift positional review indexes. Verified by `api/legacy-action-migration.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #185 — Synchronize Google completion and missing-record state

Google completion/missing-record behavior passes shared connector conformance; recovered uncertain creates preserve local completion. Verified by `api/task-sync.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #186 — Resolve Google content drift and completion conflicts

Google content drift and completion conflict remain explicit owner decisions; retries do not silently settle conflicts. Verified by `api/task-sync.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #187 — Retry, poll, unlink, and delete Google-linked Tasks

Persisted authorization revisions distinguish reconnect from unchanged restart. Failed reconciliation reads stop writes. Uncertain creates/recreates cannot duplicate on retry; explicit record-ID recovery reconciles completion. Verified by `api/task-sync.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #188 — Migrate app-created Google Task receipts without importing the account

Only app-receipted identities migrate. Recorded historical list IDs survive; unresolved historical titles resolve uniquely rather than using a current optional destination. Disabled/unconfigured Google does not prevent a read-only preview. Verified by `api/legacy-action-migration.test.ts; api/task-cutover.test.ts; composition/shell-composition.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #190 — Synchronize Asana status, missing records, retries, and deletion

Asana uses the same restart/reconnect, retry, conflict, deletion and uncertain-create recovery contract as Google. Verified by `api/task-sync.test.ts; api/asana-destination.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #191 — Resolve Asana drift and completion conflicts

Asana drift and completion conflicts remain grounded in last synchronized values and explicit resolution. Verified by `api/task-sync.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #192 — Show canonical Tasks and Action Items on Home and Daily Briefing

Home and Daily Briefing read canonical Tasks/Action Items; automatic Task state changes remain visible. Verified by `modules/daily-briefing-work.test.ts; unit/home-status.test.ts; tasks-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #193 — Promote the clean Meeting Wizard Today experience

Today retains the five-area navigation and now exposes Open full Debrief. Verified by `meeting-wizard-journey.spec.ts; meeting-debrief-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #194 — Add the deterministic This week Briefing tab

An open Weekly page refreshes canonical changes without navigation; artifact coverage is deterministic even without generation. Verified by `api/weekly-workspace.test.ts; meeting-wizard-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #195 — Generate a bounded Weekly Summary on demand

Meeting-owned projections include preparation and artifact revisions, cap forty model sources and field sizes, and exclude raw/private evidence and Tasks. All deterministic Meetings remain visible. Verified by `api/weekly-workspace.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #196 — Persist and refresh Weekly Summaries without duplicate model calls

Source events drive autonomous regeneration; quiet deadlines survive restart. Corrupt saved state remains preserved; shutdown fences late model publication. Verified by `api/weekly-workspace.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #197 — Send one owner Weekly Briefing email each Monday

Email delivery is one single-flight transaction. Generation failure stays retryable; a reconstructed runtime reconciles a lost acknowledgement by delivery ID before sending again. Verified by `api/weekly-workspace.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #199 — Retire positional Action Item state and bulk Google Task writes

Positional state is confined to historical migration and provider bulk writes stay retired. Verified by `composition/legacy-dual-write.test.ts; api/legacy-action-migration.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #200 — Compose the five product areas and Task runtimes in production

Tasks composition no longer exports TaskStore. Weekly accepts read-only capabilities and a finite Meeting-owned source query. Production composition holds and schedules the five product areas. Verified by `composition/shell-composition.test.ts; api/weekly-workspace.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #201 — Prove the complete canonical Tasks and Weekly Briefing boundary

The granular suites, shared Google/Asana conformance, migration, model privacy/consent, browsers and production composition are assembled. Final cold check:all (1,880 unit tests and 80 browser journeys) and isolated production-image proof passed; see verification.md.
Proposed action: close after publication of the verified commit; final local gates passed and live cutover remains tracked separately in #202.

## #202 — Execute the authorized live Workspace cutover

Preview and execution are separate; the canonical atomic bundle replaces the old destructive reset in production. Exact candidate Workspace preview is content-free and read-only. Do not execute or close without fresh authorization and recorded post-cutover verification.
Proposed action: keep open until the named release requirement is satisfied.

## #203 — Make the Possible duplicate link reach a Task the filters are hiding

Possible duplicate links reach Tasks even when current filters hide them. Verified by `tasks-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #205 — Persist Person Source Documents, grounded claims, and Work Records

Immutable source versions and grounded records persist across restart; unquoted sources remain discoverable and rejected attribution also blocks unquoted republication. Verified by `modules/person-dossier.test.ts; modules/person-dossier-lifecycle.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #206 — Extract and synthesise deep Person Evidence through bounded research

Matched source text survives failed extraction; extraction coverage is explicit. Supported dated changes supersede earlier open-ended facts while preserving historical evidence. Unchanged section timestamps survive unrelated publication. Verified by `modules/person-research.test.ts; modules/person-dossier-acceptance.test.ts; modules/person-dossier-coverage.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #207 — Run persistent Person Profile research with budgets and lifecycle cancellation

Finite checkpoints and elapsed/call allowances persist. Actual SIGKILL during extraction resumes retained evidence. Daily rollover preserves URLs, traversal and historical scope; concurrent fairness and eight lifecycle changes are exercised. Verified by `modules/person-research-queue.test.ts; modules/person-research.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #208 — Automatically research added people, meeting attendees, and Transcript identities

Current/historical freshness schedules differ, material Transcript evidence invalidates stale work, and bounded meeting/viewed cooldowns coexist with coalescing. Production-composed entry coverage includes manual, typed, Calendar, repeated Transcript and legacy backfill. Verified by `composition/shell-composition.test.ts; modules/person-automatic-entry.test.ts; modules/transcript-identity.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #209 — Present Person Profiles as progressively populated dossiers

Sources without claims are inspectable, dossier revisions are navigable, and backfill progress refreshes without overwriting edited settings. Private/contested DOM fixtures and sparse/unavailable keyboard/mobile browser cases pass. Verified by `unit/person-dossier-page.test.tsx; person-dossier-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #210 — Connect expertise, shared work, ideas, and activity across Person Profiles

Canonical work URLs establish stable Work Record IDs across sources/versions; later evidence retains earlier supported details. Unidentified same-name counterparties remain distinct; query counts deduplicate mirrored work. Verified by `modules/person-research.test.ts; modules/person-dossier-query.test.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #211 — Answer cross-Profile questions with grounded work and connection evidence

Search results expose exact dossier revision, Work/Claim identity and pinned source links. Queries rebuild from current admissible evidence; detached sources invalidate collaboration/activity answers and historical citations follow lifecycle removal. Verified by `modules/person-dossier-query.test.ts; modules/person-dossier.test.ts; person-dossier-journey.spec.ts` and the final whole-tree/browser/production evidence recorded in `docs/research/remaining-work-2026-09-05/verification.md`. Independent Standards and Spec findings are resolved. No real provider write was used as a test. Local acceptance is complete; proposed action: close after publication of the verified commit.

## #212 — Validate deep dossiers, measure research limits, and prove production behavior

The twenty-row populated/missing corpus remains the coverage matrix. Added actual crash, lifecycle, freshness, all-entry production and dossier UI proof. Refreshed real canary records both profiles incomplete and unavailable usage/cost; no quality success is claimed. Final cold check:all and isolated production-image gates passed; see verification.md.
Proposed action: close after publication of the verified commit; final local gates passed and live cutover remains tracked separately in #202.

## #204 — closed parent reconciliation

The remaining dossier child acceptance gaps found after parent closure are now reconciled in the verified follow-up commit and its issue-by-issue evidence ledger. The bounded real-source canary remains incomplete, with precise per-URL diagnostics and unknown token/cost values; fixture coverage is not claimed as real-source quality. Keep the historical parent closed after child acceptance updates are published, while retaining these explicit evidence limits.
