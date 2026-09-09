# Open-issue audit — 2026-09-05

Reviewed all 35 open GitHub issues in `nicolas-found42/chief-of-staff-demo` against checkout `b6c85a64775e8f62e69e87fd3b1c8b6f5e9f6b50`. Issue bodies and comments were retrieved from GitHub. Three scoped reviewers examined Task synchronization, Briefings/production, and dossiers; the coordinating review checked architecture and parent issues and reconciled findings.

## Result and scope

13 issues have no missing implementation identified and are candidates for acceptance closeout; 20 retain implementation, integration, evidence, or parent-level acceptance work; #145 is a stale execution map; #202 is an operational cutover with missing implementation prerequisites. “Implemented” is an audit judgment bounded by the evidence below, not certification of every possible behavior. Parent assessments roll up successor work and do not independently reproduce every historical scenario. Suspected issues are explicitly marked for investigation; concrete source-traced failure paths are not claimed to have been reproduced unless stated.

No GitHub comments, labels, closures, application fixes, commits, provider sends or live Workspace cutover were performed. The existing deletion of `.claude/skills/handoff/SKILL.md` was left untouched.

## Fresh verification

- `pnpm run check`: exit 0, including typecheck, lint, formatting, knip and **170 test files / 1,838 tests passed**.
- `pnpm run test:e2e`: production build and **78/78 Playwright tests passed**. Together with the previous command, this runs the components of `check:all`.
- Reviewers additionally ran focused Task and dossier suites, recorded below.
- Docker build/isolated boot/health and real provider canaries were **not rerun**. Existing recorded proofs are credited but cannot certify the newly identified untested behavior.

The fresh root results above supersede individual reviewer statements that whole-tree or browser gates were pending/unrun. Existing browser journeys cited below passed in the full run; proposed missing journeys remain missing.

## Recommended order

1. Fix migration correctness and the safe release boundary: #183, #188, #202. Do not use the old destructive reset as the canonical Tasks cutover.
2. Fix remote failure recovery: #187/#190 authorization reconnection and uncertain remote-create recovery.
3. Fix Weekly behavior: #194–#197 live updates, scheduled refresh, finite input projections, generation failure and concurrent email delivery.
4. Complete dossier research continuation/freshness and evidence consistency: #206–#211; then close the missing acceptance proof in #212.
5. Record acceptance evidence for the 13 closure candidates, reconcile #145/#117/#172, then complete #201 and the separately authorized live cutover.

## Issue index

| Issue | Title | Audit disposition |
| --- | --- | --- |
| [#117](https://github.com/nicolas-found42/chief-of-staff-demo/issues/117) | Consolidate Content Engine, Person Profiles, Content Research, and Meeting Wizard | Remaining acceptance work |
| [#145](https://github.com/nicolas-found42/chief-of-staff-demo/issues/145) | Hub: Content Engine and Meeting Wizard implementation order (#118–#144) | Stale tracker map |
| [#166](https://github.com/nicolas-found42/chief-of-staff-demo/issues/166) | Collapse the Transcript Catalog single-adapter seams | Implemented; acceptance closeout candidate |
| [#168](https://github.com/nicolas-found42/chief-of-staff-demo/issues/168) | Deepen the Meeting Brief Generator behind one enrichment seam | Implemented; acceptance closeout candidate |
| [#169](https://github.com/nicolas-found42/chief-of-staff-demo/issues/169) | Unify Content Project generation across targets | Implemented; acceptance closeout candidate |
| [#172](https://github.com/nicolas-found42/chief-of-staff-demo/issues/172) | Make Workspace Tasks canonical and add a Weekly Meeting Briefing | Remaining acceptance work |
| [#179](https://github.com/nicolas-found42/chief-of-staff-demo/issues/179) | Dismiss, restore, and regenerate Action Items safely | Implemented; acceptance closeout candidate |
| [#181](https://github.com/nicolas-found42/chief-of-staff-demo/issues/181) | Automatically create confirmed owner Tasks | Implemented; acceptance closeout candidate |
| [#182](https://github.com/nicolas-found42/chief-of-staff-demo/issues/182) | Make Meeting Debrief email-only and non-expiring | Implemented; acceptance closeout candidate |
| [#183](https://github.com/nicolas-found42/chief-of-staff-demo/issues/183) | Migrate legacy local action review into canonical records | Remaining acceptance work |
| [#185](https://github.com/nicolas-found42/chief-of-staff-demo/issues/185) | Synchronize Google completion and missing-record state | Implemented; acceptance closeout candidate |
| [#186](https://github.com/nicolas-found42/chief-of-staff-demo/issues/186) | Resolve Google content drift and completion conflicts | Implemented; acceptance closeout candidate |
| [#187](https://github.com/nicolas-found42/chief-of-staff-demo/issues/187) | Retry, poll, unlink, and delete Google-linked Tasks | Remaining acceptance work |
| [#188](https://github.com/nicolas-found42/chief-of-staff-demo/issues/188) | Migrate app-created Google Task receipts without importing the account | Remaining acceptance work |
| [#190](https://github.com/nicolas-found42/chief-of-staff-demo/issues/190) | Synchronize Asana status, missing records, retries, and deletion | Remaining acceptance work |
| [#191](https://github.com/nicolas-found42/chief-of-staff-demo/issues/191) | Resolve Asana drift and completion conflicts | Implemented; acceptance closeout candidate |
| [#192](https://github.com/nicolas-found42/chief-of-staff-demo/issues/192) | Show canonical Tasks and Action Items on Home and Daily Briefing | Implemented; acceptance closeout candidate |
| [#193](https://github.com/nicolas-found42/chief-of-staff-demo/issues/193) | Promote the clean Meeting Wizard Today experience | Remaining acceptance work |
| [#194](https://github.com/nicolas-found42/chief-of-staff-demo/issues/194) | Add the deterministic This week Briefing tab | Remaining acceptance work |
| [#195](https://github.com/nicolas-found42/chief-of-staff-demo/issues/195) | Generate a bounded Weekly Summary on demand | Remaining acceptance work |
| [#196](https://github.com/nicolas-found42/chief-of-staff-demo/issues/196) | Persist and refresh Weekly Summaries without duplicate model calls | Remaining acceptance work |
| [#197](https://github.com/nicolas-found42/chief-of-staff-demo/issues/197) | Send one owner Weekly Briefing email each Monday | Remaining acceptance work |
| [#199](https://github.com/nicolas-found42/chief-of-staff-demo/issues/199) | Retire positional Action Item state and bulk Google Task writes | Implemented; acceptance closeout candidate |
| [#200](https://github.com/nicolas-found42/chief-of-staff-demo/issues/200) | Compose the five product areas and Task runtimes in production | Remaining acceptance work |
| [#201](https://github.com/nicolas-found42/chief-of-staff-demo/issues/201) | Prove the complete canonical Tasks and Weekly Briefing boundary | Remaining acceptance work |
| [#202](https://github.com/nicolas-found42/chief-of-staff-demo/issues/202) | Execute the authorized live Workspace cutover | Live operation + prerequisite implementation |
| [#203](https://github.com/nicolas-found42/chief-of-staff-demo/issues/203) | Make the Possible duplicate link reach a Task the filters are hiding | Implemented; acceptance closeout candidate |
| [#205](https://github.com/nicolas-found42/chief-of-staff-demo/issues/205) | Persist Person Source Documents, grounded claims, and Work Records | Implemented; acceptance closeout candidate |
| [#206](https://github.com/nicolas-found42/chief-of-staff-demo/issues/206) | Extract and synthesise deep Person Evidence through bounded research | Remaining acceptance work |
| [#207](https://github.com/nicolas-found42/chief-of-staff-demo/issues/207) | Run persistent Person Profile research with budgets and lifecycle cancellation | Remaining acceptance work |
| [#208](https://github.com/nicolas-found42/chief-of-staff-demo/issues/208) | Automatically research added people, meeting attendees, and Transcript identities | Remaining acceptance work |
| [#209](https://github.com/nicolas-found42/chief-of-staff-demo/issues/209) | Present Person Profiles as progressively populated dossiers | Remaining acceptance work |
| [#210](https://github.com/nicolas-found42/chief-of-staff-demo/issues/210) | Connect expertise, shared work, ideas, and activity across Person Profiles | Remaining acceptance work |
| [#211](https://github.com/nicolas-found42/chief-of-staff-demo/issues/211) | Answer cross-Profile questions with grounded work and connection evidence | Remaining acceptance work |
| [#212](https://github.com/nicolas-found42/chief-of-staff-demo/issues/212) | Validate deep dossiers, measure research limits, and prove production behavior | Remaining acceptance work |

## Detailed evidence

Source references below are repository-relative paths and one-based lines at the audited checkout.

## Architecture and parent issues

### #166 — Collapse the Transcript Catalog single-adapter seams

**Implemented; closure candidate after browser verification.** Identity extraction and lexical searching are internal calls, not injectable caller-facing extractor/searcher interfaces (`apps/server/src/transcript-catalog/identity.ts:158`, `apps/server/src/transcript-catalog/relevance.ts:120`). Production imports of the implementation helpers are confined to the Catalog directory. Outcome coverage includes re-mining/rematching and Catalog speaker metadata (`tests/src/modules/transcript-identity.test.ts:143`, `:254`) and retained-passage grounding (`tests/src/modules/transcript-relevance.test.ts:142`). No missing implementation criterion found. Record the current gate results and close if the required journeys pass.

### #168 — Deepen the Meeting Brief Generator behind one enrichment seam

**Implemented; closure candidate after browser verification.** `MeetingBriefGenerator.generate(occurrence)` owns the enrichment/completeness/composition flow (`apps/server/src/modules/meeting-brief-generator/generator.ts:28`, `:81`); the Run delegates to it (`apps/server/src/modules/meeting-brief-generator/module.ts:309`), with production host wiring at `host.ts:293`. The host is 1,556 lines versus the issue's 1,842-line baseline; it still owns scheduling, delivery/revision routes and wiring. Tests cover exact frozen caller input, provider failure preventing composition, and prompt/evidence selection (`tests/src/modules/meeting-brief-generator-interface.test.ts:89`, `:123`, `:181`). No further content-policy extraction was identified as necessary to satisfy this issue. Record gate evidence before closure.

### #169 — Unify Content Project generation across targets

**Implemented; closure candidate after browser verification.** One Outline implementation and one Draft implementation handle every target; target contracts parameterize the Outline call, and each owns its Result Shape validation (`apps/server/src/content-projects/generation.ts:147`, `:186`). Production composes these directly (`apps/server/src/composition/shell.ts:545`). The Project independently recomputes support against approved evidence (`apps/server/src/content-projects/projects.ts:1407`), with supported/unsupported/unknown evidence and regeneration tests through the Project (`tests/src/modules/content-project-outlines.test.ts:438`, `:488`). Nine-target selection, partial retry and lineage are covered in `tests/src/modules/content-project-outline-sets.test.ts:312`. No missing implementation criterion found; record current gates.

### #145 — Hub: Content Engine and Meeting Wizard implementation order (#118–#144)

**Stale execution map.** The body says #144 is the only remaining open child, but live GitHub state is CLOSED and its final comment explicitly supersedes the former four-area cutover with #172, #201 and #202. Remaining work: update the map's hold, final wave and critical-path terminus to reflect those replacements, then close or retain it explicitly as a historical map. Do not execute its obsolete cutover instructions. This is tracker reconciliation, not a new missing feature.

### #117 — Consolidate Content Engine, Person Profiles, Content Research, and Meeting Wizard

**Parent implementation exists; acceptance reconciliation and successor release work remain.** This audit checked its relationship to the current execution map, the architecture seams above, production wiring and successor issues; it is not an independent fresh reproduction of every historical acceptance scenario. Its historical children #118–#144 are closed, with #144 superseded rather than executed. Current code implements successor behavior that intentionally disagrees with the original spec: Transcript-origin Profile creation is allowed by #204/ADR-0062, while canonical Tasks, non-expiring email-only Debriefs and the five-area release boundary follow #172/ADRs 0052–0061. Remaining work: reconcile those superseded requirements in the parent, resolve relevant successor gaps in this report, and attach current whole-product and live-cutover proof through #201/#202. Do not classify the superseded no-auto-create, expiry or bulk-Task requirements as regressions.

### #172 — Make Workspace Tasks canonical and add a Weekly Meeting Briefing

**Partial at program acceptance level.** Canonical Tasks, Action Item promotion, external links, five-area composition and Daily/Weekly surfaces are present. Remaining concrete work is in this report's child findings: crash-safe migration of completed Action Items (#183), legacy Google receipt migration when the destination is unavailable (#188), authorization recovery (#187/#190), Weekly live refresh and summary/delivery behavior (#194–#197), and complete acceptance plus separate live cutover (#201/#202). Close the parent only after those gaps and its release proof are resolved. This is a roll-up of the child audit, not a claim that every original spec scenario was rerun independently.


---

# Tasks synchronization and Action Item audit

Reviewed current working tree against issue bodies/comments. No source or GitHub changes. Existing unrelated deletion `.claude/skills/handoff/SKILL.md` left alone.

## Verification actually run

`pnpm --filter @chief-of-staff-demo/tests test src/api/action-items-routes.test.ts src/api/auto-promotion.test.ts src/api/legacy-action-migration.test.ts src/api/task-sync.test.ts src/api/asana-destination.test.ts src/modules/meeting-debrief-review.test.ts src/modules/meeting-debrief-outputs.test.ts src/composition/legacy-dual-write.test.ts`

**8 files, 172 tests passed**, 6.89 seconds. This is hermetic seam coverage, not live Google/Asana or browser proof. Whole-tree check and Playwright were not run by this reviewer. Every issue requiring `npm run check` still needs current whole-tree proof unless the coordinating agent supplies it.

## #179 — Dismiss, restore, and regenerate Action Items safely

**Implemented; verification/closeout remains.** Stable dismissal/restore reject promoted items in `apps/server/src/tasks/action-items.ts:175`, `:190`, `:204`. UI Undo and later dismissed history: `apps/web/src/pages/TasksPage.tsx:1299`, `:1344`; Debrief history restore: `apps/web/src/pages/MeetingDebriefDetailPage.tsx:690`. Materialization appends proposals and preserves stored decisions (`apps/server/src/tasks/action-items.ts:118`); regenerated revisions cannot auto-promote (`apps/server/src/tasks/auto-promotion.ts:118`). Tests read/run: `tests/src/api/action-items-routes.test.ts:271` and `:303` preserve dismissed/promoted records and Task contents. Existing unrun browser journey: `tests/e2e/tasks-journey.spec.ts:210` covers Undo and later Debrief restoration. No missing functional work identified; run browser and whole-tree gates and close/update stale checklist.

## #181 — Automatically create confirmed owner Tasks

**Implemented; verification/closeout remains.** Stage-all defaults at `packages/shared/src/schemas.ts:78`; eligibility, first extraction, duplicate suppression and local-first delivery at `apps/server/src/tasks/auto-promotion.ts:41`, `:77`, `:110`; outbound confirmation API at `apps/server/src/api/tasks.ts:770` and UI `apps/web/src/pages/TasksPage.tsx:1428`. Tests run: `tests/src/api/auto-promotion.test.ts:104`, `:120`, `:130`, `:143`, `:166`, `:200`, `:274` cover eligibility, regeneration, restart, delivery failure, and warning. No additional feature work identified.

## #182 — Make Meeting Debrief email-only and non-expiring

**Implemented; verification/closeout remains.** Extraction materialization at `apps/server/src/modules/meeting-debrief/module.ts:564`; review turn returns done at `:350`; Gmail-only outward path at `:136`. Approved copy and Gmail link at `apps/web/src/pages/MeetingDebriefDetailPage.tsx:560`, `:574`, `:603`; index summary uses real link at `apps/web/src/pages/MeetingDebriefPage.tsx:219`. Tests run: `tests/src/modules/meeting-debrief-review.test.ts:182`, `:202`; `tests/src/modules/meeting-debrief-outputs.test.ts:398` proves whole Debrief publication creates no Tasks. Existing unrun browser journeys `tests/e2e/meeting-debrief-journey.spec.ts:276`, `:436`. No missing feature work identified; verify browser accessibility and full gate.

## #183 — Migrate legacy local action review into canonical records

**Partial: restart-safe completion recovery remains.** Mapping implemented at `apps/server/src/tasks/legacy-migration.ts:59`, pending/dismissed/Done coverage at `tests/src/api/legacy-action-migration.test.ts:219`, `:229`, `:244`; repeat/resume/immutable Run tests at `:292`, `:314`, `:331` all passed.

Concrete uncovered crash window: `apps/server/src/tasks/promotion.ts:91` writes the Task initially open, then `:112` completes it, then `:115` links the Action Item. If interrupted between create and complete, resuming `completed:true` hits orphan recovery at `:84`, which returns the open orphan and records promotion without completing it. The legacy Done decision is now promoted to an open Task and subsequent migration skips it. **Remaining:** preserve/apply requested completion when adopting this interrupted migration, and add fault-injection/restart regression for the create-before-complete boundary. Storage is atomic per file (`apps/server/src/tasks/store.ts:47`, `:63`), not one transaction across Task and Action Item, so the restart contract matters.

Also investigate positional migration after duplicate proposals: materialization deduplicates identical values (`apps/server/src/tasks/action-items.ts:112`), but legacy migration interprets returned array indexes as original positions (`apps/server/src/tasks/legacy-migration.ts:102`). On the initial materialization a duplicated proposal before a later Done/dismissed proposal can shift the mapping; subsequent materialization of already-stored proposals returns the duplicate entries, so repeated migration may disagree with the first pass. Add a duplicate-input fixture and preserve original-position-to-stable-identity mapping.

## #185 — Synchronize Google completion and missing-record state

**Implemented; verification/closeout remains.** Shared synchronization and missing-record handling at `apps/server/src/tasks/external-link.ts:477`, recreation at `:785`, classified failures at `:128`; production Google connector `apps/server/src/tasks/composition.ts:110`. Run tests in `tests/src/api/task-sync.test.ts:238`, `:252`, `:268`, `:287`, `:303`, `:333`, `:365`, `:390`, `:408` cover these contracts. No additional feature work identified beyond shared retry issues under #187.

## #186 — Resolve Google content drift and completion conflicts

**Implemented; verification/closeout remains.** Drift/conflict detection `apps/server/src/tasks/external-link.ts:558`, `:586`, explicit content resolution `:666`, status resolution `:734`; UI controls `apps/web/src/pages/TasksPage.tsx:389`, `:417`. Tests run at `tests/src/api/task-sync.test.ts:597`, `:634`, `:654`, `:672`, `:693`, `:738`, `:747`, `:773`, `:895` cover preservation, provider-failure retention, resolutions and durable restart baseline. No missing functional work identified.

## #187 — Retry, poll, unlink, and delete Google-linked Tasks

**Partial: authorization resume and uncertain-create retry remain.** Shared refresh/retry/start/timer/trash at `apps/server/src/tasks/external-link.ts:172`, `:185`, `:203`, `:230`; Tasks-open at `apps/web/src/pages/TasksPage.tsx:902`; retry-all route at `apps/server/src/api/tasks.ts:133`. Run tests `tests/src/api/task-sync.test.ts:150`, `:193`, `:219`, `:803`, `:829` cover implemented behavior.

1. `apps/server/src/tasks/external-link.ts:192` permanently excludes links with stored authorization failure from ordinary refresh, including startup and five-minute polling. Reconnection does not clear those failures or force a retry; explicit Refresh also calls this excluding path (`apps/server/src/api/tasks.ts:132`). **Remaining:** reconnect should resume affected links; prove auth failure → reconnect → next automatic tick succeeds without needing Retry all. A manual Retry can recover today, so work is not lost.
2. A successful remote insert with lost response/crash before recording its returned ID leaves `remoteId:null`. `retryOne` then calls `link` again (`apps/server/src/tasks/external-link.ts:216`); creation at `:368` has no persisted operation identity or uncertain-outcome recovery, and `apps/server/src/google/tasks.ts:71` is a fresh insert. This can duplicate a remotely successful record, contrary to the acceptance criterion. **Remaining:** define and implement safe recovery of an uncertain creation and test response-loss/crash, rather than only retries after a saved remote ID.

## #188 — Migrate app-created Google Task receipts without importing the account

**Partial: production upgrade/default path remains.** Receipt-only adoption, status refresh, unavailable recovery and immutability implemented in `apps/server/src/tasks/legacy-migration.ts:173`; run tests `tests/src/api/legacy-action-migration.test.ts:123` and `:163` cover present/missing/auth/network state and repeats.

Production only calls receipt migration when `tasks.googleTasks.enabled` and `taskListId` are already set (`apps/server/src/composition/shell.ts:334`). Both default disabled/empty (`packages/shared/src/schemas.ts:86`), and the else branch only migrates local decisions. Thus an old Workspace with receipts but no newly enabled destination gets pending Action Items instead of the promised canonical receipt-backed Tasks. Connecting later also waits for another boot (explicit comment at shell.ts:332). **Remaining:** migrate usable local Tasks and recoverable receipt links regardless of optional integration enablement, resolve/preserve the historical list destination instead of silently assuming today's selected list, and test the actual composition startup with receipts and disabled/unconfigured integration. Also ensure receipt migration is unaffected by earlier local decision mapping errors described under #183.

## #190 — Synchronize Asana status, missing records, retries, and deletion

**Partial due to shared #187 gaps.** Production connector at `apps/server/src/tasks/composition.ts:145`; shared Google+Asana contract suite declared at `tests/src/api/task-sync.test.ts:25` executes all status/missing/retry/delete tests for both providers. Isolation tests at `:1010`, `:1055` passed. Asana reconnect only saves the token (`apps/server/src/tasks/asana-link.ts:94`, `:107`) and does not resume authorization-paused links. Asana creation also sends a fresh POST (`apps/server/src/asana/client.ts:188`) after an uncertain prior create. **Remaining:** shared authorization resume and safe uncertain-create recovery plus conformance regressions; existing provider parity is otherwise substantial.

## #191 — Resolve Asana drift and completion conflicts

**Implemented; verification/closeout remains.** Same shared drift/conflict implementation and explicit UI as #186. `tests/src/api/task-sync.test.ts:25` runs the same contract for Asana, including `:597`–`:790` resolution scenarios. Asana payload at `apps/server/src/asana/client.ts:188` maps title/notes/date/project without assignee; `tests/src/api/asana-destination.test.ts:552` verifies another Responsible Person without provider identity mapping, and passed. No additional feature work identified beyond dependency #190 remaining issues.

## #199 — Retire positional Action Item state and bulk Google Task writes

**Implemented; verification/closeout remains.** Production Meeting Debrief writes Gmail only (`apps/server/src/modules/meeting-debrief/module.ts:136`); canonical composition owns Action Item materialization (`apps/server/src/tasks/composition.ts:193`). Legacy Run fields remain readable in `apps/server/src/modules/meeting-debrief/review.ts:22` and migration reads them. Run regression suite `tests/src/composition/legacy-dual-write.test.ts:101` checks production callers, retired-route regression `tests/src/modules/meeting-debrief-review.test.ts:350`, no whole-Debrief Tasks `tests/src/modules/meeting-debrief-outputs.test.ts:398` all passed. No remaining retirement code identified. Migration correctness gaps under #183/#188 should be resolved before declaring the entire expand-contract rollout safe.

## #203 — Make the Possible duplicate link reach a Task the filters are hiding

**Implemented; browser verification/closeout remains.** The stale issue describes a hash link, but current `DuplicateWarning` is inline `<details>` comparison (`apps/web/src/pages/TasksPage.tsx:184`) with title, list, date, status, notes and Responsible Person; both quick capture and Action Item review use it (`:677`, `:1191`). It does not navigate or discard override state. Filter-independent duplicate search lives at `apps/server/src/tasks/tasks.ts:289`. Existing browser regression explicitly hides the original with search, opens Compare, checks preserved input and armed Add anyway, then creates (`tests/e2e/tasks-journey.spec.ts:395`). This browser test was read but not run here. No further implementation identified; run the journey and update/close stale issue wording.


---

# Audit of #192–#202 briefing/composition issues

Read-only assessment of current checkout, issue bodies in issues.json, parent #172 and ADR-0060. No GitHub mutation, live reset, provider/model call or external send. Executed `pnpm --filter @chief-of-staff-demo/tests test -- ...` intending four narrow files; repository runner in fact executed **all 170 unit files / 1838 tests, all passed** (23.39s). Test presence and passing units do not establish browser, production Docker or live-cutover acceptance. Root is gathering wider gate evidence separately.

## #192 — implemented, verification closeout

Canonical active counts, separate lists and eight-item limits exist in `apps/server/src/tasks/overview.ts:25`; Home reads overview and renders it at `apps/web/src/pages/HomePage.tsx:59` and `:233`. Totals and View all controls are in `apps/web/src/components/WorkSummary.tsx:76`. Daily Briefing receives distinct canonical Task and Action Item projections with overdue/due-today/high-priority partitioning at `apps/server/src/tasks/briefing-projection.ts:26`, wired into production at `apps/server/src/composition/shell.ts:680`. Active-count/cap/failed-link cases exist at `tests/src/api/task-overview.test.ts:57`, `:88`, `:107`; daily separation/email cases at `tests/src/modules/daily-briefing-work.test.ts:49`. These passed in the whole-unit run. No concrete missing implementation identified. Close only after required whole check and browser evidence, including canonical item navigation with existing Task filters.

## #193 — largely implemented; small acceptance/UI gap and verification

Today metric strip and compact groups exist at `apps/web/src/pages/MeetingsOverviewPage.tsx:212` and `:299`; production CSS supplies the restrained wizard surfaces. Route/Today browser cases exist at `tests/e2e/meeting-wizard-journey.spec.ts:299` and `:348`. Full detail navigation exists from Meeting summary at `apps/web/src/pages/MeetingPage.tsx:419` and explicit “Open the full debrief” at `:441`. Debrief index name and summary navigate canonically at `apps/web/src/pages/MeetingDebriefPage.tsx:191` and `:219`, but the index does not render the explicit visible “Open full Debrief” link required by #193 (only linked title/summary). Add/verify the explicit detail affordance on that index; finish keyboard/focus/non-color/live-region/narrow/loading/error browser proof. Unit green is insufficient to certify visual acceptance.

## #194 — partial: deterministic data works; live updates missing

Timezone Sunday/Saturday bounds, exact start/end groups, cancellation exclusion and separate task sections are implemented at `apps/server/src/meetings/weekly.ts:59`. Successful artifact selection skips failed runs at `:110`; API tests cover boundaries and sections at `tests/src/api/weekly-workspace.test.ts:269`. `/meetings/weekly` is registered at `apps/web/src/App.tsx:236`; tabs are route backed. **Remaining:** the weekly page loads only on mount or explicit regeneration (`apps/web/src/pages/MeetingsWeeklyPage.tsx:213`, `:232`) and has no polling/subscription/mutation invalidation. Changing a Task or Action Item elsewhere while this page stays open leaves deterministic sections stale, contrary to immediate updates. Add an update seam and a browser test with the weekly page open while canonical state changes. The deterministic endpoint itself calls `view()` only (`weekly.ts:343`), leaving every artifact status “missing”; if consumed beyond the Today count, populate artifact coverage without model work too.

## #195 — partial: bounded generation exists, preparation projection incomplete

Allowlisted completed Brief/Debrief projection assembly is at `apps/server/src/meetings/weekly.ts:139`; strict one-paragraph/four-sentence/120-word upper-bound shape at `:365`; zero-source no-call at `:186`. Recording-fake privacy/projection/output tests at `tests/src/api/weekly-workspace.test.ts:131`, `:435`, `:511` passed. **Remaining:** upcoming projection includes only summary, conversation starters and uncertainty (`weekly.ts:159`), with no explicit confirmed preparation-point projection required by #195/#172. Meeting Brief guest talking points exist at `packages/shared/src/meeting-brief.ts:111`; design a bounded preparation selection without copying guest/profile evidence, and assert it at the completion seam. Sources are assembled via raw result artifacts and unbounded collection arrays; prove declared finite input caps for many/long artifacts as part of the bounded contract. No live LLM spending needed.

## #196 — partial: durable on-read cache exists; autonomous refresh absent

Cache records/fingerprint/reuse/last-good preservation exist at `apps/server/src/meetings/weekly.ts:204`, `:226`, `:266`; tests at `tests/src/api/weekly-workspace.test.ts:311`, `:374` pass. **Remaining:** dirty time is discovered only on `read()` (`weekly.ts:237`); no Meeting/Brief/Debrief change listener schedules generation 15 minutes after the latest change. The only timer invokes the Monday-email function hourly (`:325`); outside Monday it returns before reading (`:298`). Reproduction: generate Thursday, revise a source Thursday, leave tab open; no automatic regeneration at +15m (nor deterministic refresh). The existing quiet-period test performs GET after every change and at +15m, so proves demand-driven behavior only (`tests/src/api/weekly-workspace.test.ts:396`). Add lifecycle-owned change observation, persisted due time and scheduled generation independent of email enablement/owner confirmation, with restart and clock tests. Successful persisted `sources` carry run IDs and copied content, but not explicit source artifact revisions (`weekly.ts:139`, `:265`); make revision identity explicit or document/prove immutable Run-as-revision contract. Handle corrupted weekly/consent JSON as typed failure rather than raw parsing exceptions (`:188`, `:215`).

## #197 — partial: weekly email works, failure classification and concurrency need work

Owner-only adapter with no caller recipient, delivery-ID reconciliation and receipt persistence at `apps/server/src/meetings/weekly.ts:293`; production Gmail composition at `apps/server/src/composition/shell.ts:769`. Tests at `tests/src/api/weekly-workspace.test.ts:575`, `:608`, `:637`, `:685` pass. **Remaining:** generation failure is converted to a failed view (`weekly.ts:266`) but `sendWeeklyEmailIfDue` still sends and records a successful weekly receipt (`:303`–`:317`). Reproduction with deterministic fake: Monday + qualifying Brief + rejecting completion; invoke send, then recover completion and retry same week. First invocation sends missing-summary email and records week success; later cannot email recovered Summary. #197 explicitly requires generation failure retryable and no false success; distinguish legitimate no-source/stale degraded delivery from a failed generation that must retain retry eligibility, and add this regression. Also protect the whole reconciliation/send/receipt transaction against concurrent calls: `read()` is single-flight but email sends are not (`:293`); two calls can both observe no receipt and no remote match before sending. Add concurrent/lost-ack/restart delivery tests. The test titled “survives restart” at `tests/src/api/weekly-workspace.test.ts:575` does not recreate the runtime; add actual restart proof.

## #200 — partial: production composition is present, underlying runtime gaps remain

Five areas are explicit at `apps/web/src/productAreas.ts:29`. Tasks composition owns stores/adapters/materialization at `apps/server/src/tasks/composition.ts:83`; Shell composes it at `apps/server/src/composition/shell.ts:293`. Production startup invokes Task and weekly starts at `:1182`. Production Shell tests cover reachable areas/runtime handles at `tests/src/composition/shell-composition.test.ts:299`; passed. **Remaining:** resolve #194–197 runtime gaps before declaring this parent composition complete. Task runtime start/stop uses shared TaskLinking; both Google and Asana connectors are supplied, so no separate Asana scheduler is required. Weekly currently consumes raw stores and Run artifacts (`weekly.ts:29`, `:110`) rather than bounded product-owned read projections; Shell exports Tasks internals through composition (`tasks/composition.ts:59`), so the specified ownership boundary is only partially deepened. Production startup also automatically migrates legacy state before serving (`shell.ts:315`–`:347`), relevant to #202 authorization/cutover gap below.

## #201 — verification remains, plus upstream fixes

170 unit files/1838 passed in this audit. Test presence for Shell, weekly and canonical tasks documented above. Root is running full check/browser gates; use actual results. This issue cannot close while #194–197 findings remain. Need final acceptance matrix across all granular Task/Action Item/provider/migration behavior, genuine shared Google+Asana adapter conformance proof, actual browser/accessibility/mobile results, production image build + isolated boot + `/api/health`, and spec-to-diff review. Do not run paid Debrief eval absent prompt/Result Shape/Golden changes. Existing successful tests cannot prove uncovered autonomous refresh, generation-failure email or concurrent delivery behavior.

## #202 — operationally unexecuted; implementation prerequisite missing

Issue has no comments recording fresh explicit owner authorization. Audit request does not authorize live cutover. Need exact Workspace preview, cancellation proof, authorization, atomic/idempotent migration receipt, preserved credential/canonical-record verification, recovery instructions and completion evidence after #201 passes. **Concrete code gap:** `apps/server/src/api/migration.ts:41` and `:49` still expose old general destructive reset inventory/confirm, while canonical task legacy migration executes automatically at startup (`apps/server/src/composition/shell.ts:315`–`:347`). Neither provides the requested explicit authorized canonical-task-cutover preview/receipt flow. The old migration classifier labels Tasks disposable (`apps/server/src/migration/workspace.ts:198`). Implement the correct cutover boundary before requesting owner approval; do not use old confirm/reset or run live migration as an audit. No live Workspace state was inspected or changed to claim execution status.


---

# Dossier issues #205–#212 audit

Read the current issue bodies and binding #204, ADR-0062, domain/verification instructions, production composition, persistence/research/query/UI code and tests. ADR-0062 and #204 supersede #117's ban on automatic Transcript-origin creation; do not reopen that old prohibition. No source or GitHub changes made.

Executed: `pnpm --filter @chief-of-staff-demo/tests test person-dossier person-research person-automatic-entry`: **10 test files, 33 tests passed**, 2026-09-05, 3.64s. This covers the matching module suites and dossier page unit test. Did not execute Playwright, whole-tree or Docker gates; prior proofs below are repository records, not fresh validation.

## #205 — Persist Person Source Documents, grounded claims, and Work Records

**Status: implemented (foundation scope), with integration concerns assigned below.**

Versioned bounded contracts distinguish source class, visibility, match confidence, claim state, contribution/team contribution, authority, dated scale, outcomes and typed connections (`packages/shared/src/person-dossier.ts:16`, `:45`, `:63`, `:110`). Source text is separately stored with content-addressed immutable versions (`apps/server/src/person-profile/dossier-store.ts:63`); publishing validates exact passages, dangling/duplicate references and demonstrated-work requirements (`:116`). Revisions, public projection pruning, transcript removal, detach, merge and privacy tombstones exist (`:90`, `:185`, `:191`, `:297`, `:314`, `:341`). Atomic file replacement is at `:367`.

Focused tests passed for source persistence/restart, immutability, deletion isolation, independent support, merges, rejected attribution, mirrors and exact revisions (`tests/src/modules/person-dossier.test.ts:17`, `:77`, `:137`, `:209`, `:271`, `:362`, `:462`, `:487`), plus all-twenty populated/missing fixtures (`tests/src/modules/person-dossier-acceptance.test.ts:348`). No missing foundation feature established by this pass. Stable cross-source/work identity in the producer and lifecycle presentation still need the #206/#210 work below; foundation completion does not imply dossier automation is complete.

## #206 — Extract and synthesise deep Person Evidence through bounded research

**Status: partial.**

Implemented: finite identifier queries, full HTML/text retrieval, matched-source anchoring, bounded model extraction, verbatim validation, private-source lineage, progressive source publication and factual-update authority (`apps/server/src/person-profile/research.ts:66`, `:118`, `:196`, `:219`, `:250`, `:349`, `:385`, `:449`). Comprehensive/missing/conflict/private/detach tests passed.

Remaining concrete acceptance work:

- Preserve retrieved matching documents even when extraction fails. `retainSource` runs only after successful model extraction (`research.ts:221`, `:250`); an extraction error records a diagnostic and discards the collected material (`:325`). Empty failed/unsupported retrievals are likewise skipped before a Source Document can retain its access result (`:186`–`:195`). This falls short of retained useful material and incremental failure recovery.
- Distinguish retrieval completeness from extraction coverage. Up to 500,000 characters are retained as full text (`:479`), but only the first 60,000 go to extraction (`:238`), without a corresponding extraction-truncated flag. Finish or explicitly mark this partial extraction.
- Implement temporal reconciliation across source versions. IDs are derived from immutable source-version ID plus model-local ID (`:504`), and `combine` only appends/overwrites exact IDs (`:553`). Conflict detection handles differing values only when effective start dates are equal (`:558`–`:570`); it does not retire older open-ended claims on later effective evidence. Add source-revision/repeated-collection proof preserving old evidence while showing the supported current account.
- Ground per-section freshness. `synthesizeSections` resets every section's `updatedAt` on any publication and always emits incomplete/unresearched (`apps/server/src/person-profile/dossier-store.ts:30`–`:54`). This cannot establish that an unchanged career section was researched when one current-context source changes.

## #207 — Run persistent Person Profile research with budgets and lifecycle cancellation

**Status: partial.**

Implemented: durable jobs, restart requeue, allowance reservation before use, daily rollover, coalescing, aging priority, pause/stop generation fencing and profile-fingerprint cancellation (`apps/server/src/person-profile/research-queue.ts:36`, `:53`, `:82`, `:143`, `:153`, `:199`, `:217`, `:266`). The focused queue suite passed.

Remaining:

- Persist a finite research continuation checkpoint (query/pass/visited sources and cumulative elapsed time). The job schema has counts/attempts but no continuation or elapsed-time fields (`packages/shared/src/person-dossier.ts:188`–`:210`). Restart changes researching to queued (`research-queue.ts:53`), then starts the research algorithm at its initial queries/empty visited set (`research.ts:124`, `:129`) with remaining calls but a fresh full time allowance (`research-queue.ts:213`–`:215`). This preserves published evidence but does not resume the unfinished finite traversal; repeated work can consume the remaining allowance and time is not cumulative across restart.
- Prove crash *during* work, fairness, concurrent allowance enforcement, retry backoff, pause/resume, migration gate, and each in-flight lifecycle race. Current queue tests cover a queued restart, daily failure accounting and archive during search (`tests/src/modules/person-research-queue.test.ts:14`, `:49`); that is narrower than the requested deterministic matrix. The test named restart-resume constructs the second queue before the first has dispatched (`:35`), so it is not crash-in-flight evidence.

## #208 — Automatically research added people, meeting attendees, and Transcript identities

**Status: partial.**

Implemented: manual API enqueue (`apps/server/src/api/people.ts:61`), production Transcript automatic creation (`apps/server/src/transcript-catalog/production.ts:72`; identity rejection/stable-identifier logic in `identity.ts:190`), automatic active-Profile backfill and imminent meeting priority (`research-queue.ts:156`; `apps/server/src/composition/shell.ts:414`). Typed identifier reuse/deletion prevention and factual supersession tests passed (`tests/src/modules/person-automatic-entry.test.ts:8`, `:25`, `:72`, `:107`).

Remaining:

- Implement different refresh schedules for historical vs current facts, and an explicit material-new-evidence refresh trigger. Only one Workspace-wide `refreshHours` exists (`packages/shared/src/person-dossier.ts:185`; `research-queue.ts:246`), and periodic work enqueues whole Profiles as backfill (`:156`).
- Resolve the documented meeting/viewed cooldown discrepancy. `enqueue` lets only explicit requests bypass `nextAt` (`research-queue.ts:97`); meeting/viewed reasons cannot cause earlier stale re-research even though the acceptance report says those bypass cooldown (`docs/research/person-dossier-acceptance.md` budget table). Preserve coalescing, but implement and prove a freshness policy for imminent meetings instead of treating a priority reason alone as freshness behavior.
- Add production-composed creation-to-research journeys for Calendar, repeated Transcript mining and active legacy backfill, including contradictory identifiers. Existing dossier browser coverage has one typed addition path; queued sweep existence is not production journey proof.

## #209 — Present Person Profiles as progressively populated dossiers

**Status: partial.**

Implemented: section tabs, sourced records, source text highlighting/provenance, progressive refresh, separate canonical Relationship history, secondary maintenance, budget controls and source deep links (`apps/web/src/pages/PersonDossierPanel.tsx:48`, `:86`, `:192`, `:298`, `:336`, `:499`; `PersonProfileDetailPage.tsx:696`). The public-only empty-history unit test passed. Recorded e2e covers typed addition, source inspection, search, axe and a mobile overflow check (`tests/e2e/person-dossier-journey.spec.ts:4`).

Remaining:

- List retained Source Documents that have no claims. The Sources tab renders `claims.map(claim)` (`PersonDossierPanel.tsx:482`–`:489`), not `dossier.sourceIds`. Those documents exist and are disclosed for deletion, but cannot be discovered in normal reading; #204 explicitly requires unquoted sources remain accessible.
- Expose backfill progress across the queue, not only this Profile's source count and daily operation total (`:203`, `:215`). Settings fetch the queue's jobs but no backfill completion/waiting summary is rendered.
- Add historical dossier viewing in the UI. The dossier revision API exists (`apps/server/src/api/person-dossiers.ts:25`), but the panel reads only current dossiers (`PersonDossierPanel.tsx:29`); historical Profile views hide the dossier panel (`PersonProfileDetailPage.tsx:696`). Current factual-profile revision maintenance survives, but historical dossier records are not a navigable reading experience.
- Finish the requested sparse/full/contested/private-only and paused/unavailable keyboard/source-inspection/browser matrix, including all automatic entry paths. Existing axe check alone does not prove keyboard interaction throughout all states.

## #210 — Connect expertise, shared work, ideas, and activity across Person Profiles

**Status: partial.**

Implemented: taxonomy normalization aliases, typed supported connection paths, deduplicated observed activity, repeated collaborations, evidence composition and intersections/coverage (`apps/server/src/person-profile/dossier-queries.ts:12`, `:32`, `:88`, `:112`, `:130`, `:150`, `:185`). Four query suites passed, including sparse denominators, missing personal contribution, deduplication and archived intermediate paths (`tests/src/modules/person-dossier-query.test.ts:10`, `:118`, `:203`, `:283`).

Remaining concrete consistency work: extraction assigns Work Record identity per source version (`research.ts:504`, `:525`), so the same work remains multiple detailed records across sources and versions. Analysis repairs counts using URL/title/date heuristics (`dossier-queries.ts:98`), but that is not a canonical shared Work Record used consistently across sections and people. Implement/reconcile stable work identities and verify source-version/mirror/shared-person records do not split work or inflate collaboration. Collaboration fallback also groups counterparties solely by normalized name when no Profile ID exists (`:140`), so distinct same-name collaborators can be conflated; use grounded counterparty identity or explicitly keep uncertain identities apart. Add cross-employer/date and same-name-counterparty regression cases.

## #211 — Answer cross-Profile questions with grounded work and connection evidence

**Status: partial (core query engine implemented).**

Filtering by categories, constraints, scale and dates; supported/claimed separation; individual-contribution safeguards; exact source quotes; denominators; public-purpose filtering; and fresh rebuilding on each query exist (`apps/server/src/person-profile/dossier-queries.ts:185`–`:324`). Query tests passed. Paths preserve kind/direction/dates, shared work IDs and claim citations (`:53`).

Remaining: surface exact Work Record/Claim identity and shared work in answers. API matches return `dossierRevision`, `workIds` and `claimIds` (`:288`), but UI shows only person, gaps and quotes with current Profile/source links (`apps/web/src/pages/PersonDossierSearch.tsx:198`–`:215`). Connection rendering similarly omits the returned shared work IDs (`:150`–`:173`). Add exact-record/revision links or readable pinned record details; prove old answer citations remain inspectable until lifecycle invalidation, rather than silently navigating to a changed current dossier. Expand lifecycle answer tests to merge/detach/source or Transcript deletion/supersession, beyond the existing archived-path and public projection cases. #210 identity reconciliation also affects grounded answers.

## #212 — Validate deep dossiers, measure research limits, and prove production behavior

**Status: partial (substantial evidence already recorded).**

Do not redo this from zero: `docs/research/person-dossier-acceptance.md:1` contains the twenty-row populated/missing/conflict matrix, actual collection methods, unavailable providers, measured default-budget decisions, and prior whole-tree/76-Playwright/container health proof. `docs/research/person-dossier-canary.json:1` is a real two-person canary, clearly separate from fixtures: one model call, four verified passages, both dossiers incomplete, actual token/cost data explicitly unavailable. Focused matrix tests passed in this audit.

Remaining: close the concrete implementation gaps above and complete the absent all-entry/browser and deterministic queue/lifecycle verification matrix. Refresh the canary to include the per-URL diagnostics now shipped; the record explicitly says its retained canary predates them and is not a quality benchmark (`docs/research/person-dossier-acceptance.md:194`–`:202`). Validate defaults against actual continuation/freshness behavior after those changes, then run and record fresh cold-cache whole-tree, check:all and isolated production image health gates. Prior recorded success is evidence, but does not prove acceptance areas without tests or the new fixes. Parent #204 is already CLOSED (verified separately, closed 2026-09-05). Reconcile that closure with these still-open child acceptance gaps; do not treat its closed state as evidence that they are complete.
