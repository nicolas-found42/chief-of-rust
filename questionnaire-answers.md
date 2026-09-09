# Repository review: content and meeting workflow consolidation

## Executive conclusion

The proposed direction is compatible with the repository’s domain model, but the current implementation is much less consolidated than the product language suggests:

- **Person Profile already exists as a Workspace-owned domain model and resolver**, with revisioned local persistence, HubSpot evidence, public-web evidence, confidence, and provenance. However, it is not yet an app-wide product surface: there is no Person Profiles tab, page, public API, review queue, manual correction flow, or reusable application-level service. Its only production composition root is currently inside Meeting Brief Generator.
- **Meeting Brief is a substantial live workflow** with Google Calendar push, a durable future-meeting schedule, Gmail/Calendar/Drive/HubSpot/public-web/profile enrichment, structured briefs, revisions, cancellation handling, and owner-only delivery.
- **Meeting Debrief is not implemented.** It is defined in domain documentation and two ADRs, but there is no hosted module, route, page, shared result type, persistence implementation, API, or test suite for it.
- **The repository does not currently turn private meeting transcripts directly into finished posts.** The closest workflow is Idea Engine, which produces Content Ideas and an Expand Prompt for a downstream copywriter. Content Scout produces finished drafts, but from public Source Items; a public YouTube transcript can be one item’s evidence. Those are separate facts and should not be collapsed into “transcript-to-post.”
- **Content Research and Content Scout are distinct live modules with different jobs.** They share source-adapter infrastructure, and Content Research currently reaches into Content Scout storage to read the Brand Profile. Consolidating their navigation should not merge their Runs, state machines, or result models.
- I recommend four top-level product areas: **Content Engine**, **Content Research**, **Person Profiles**, and **Meeting Wizard**. Content Research and Person Profiles should remain top-level because both are reusable independent workflows, not modal helpers owned by Content Engine or Meeting Wizard.
- The transcript identity pipeline should be a new shared capability built around **reviewable Transcript Mentions and Match Candidates**, not by calling the current `PersonProfileResolver.resolve()` directly on every extracted name. Exact stable identifiers may auto-link to an existing profile; ambiguous names must remain unresolved until reviewed.

I treated YouTube Trends and Transcript → Tasks as affected surfaces because they are adjacent live content/meeting workflows whose placement changes under the proposed navigation. I did not modify the repository.

---

# 1. Complete map of the affected current product surface

## 1.1 Product, workflow, persistence, and destination map

| Current surface | Concrete implementation | Observed current responsibility and dependencies | Persistence/background/integrations | Recommended destination |
| --- | --- | --- | --- | --- |
| Shell navigation and route table | [`App.tsx:43–79`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/App.tsx:43), [`useModules.ts:40–92`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/useModules.ts:40) | The top navigation is mechanically derived from every live Module descriptor. Current affected routes are `/transcript`, `/youtube`, `/idea-engine`, `/content-scout`, `/meeting-brief`, and `/content-research`. `/runs`, `/runs/:id`, and `/settings` are Shell pages. | Shared Run store and generic API; no product-area route grouping exists. | Decouple top navigation from the hosted-module registry. Keep the Run Shell, but expose four product-area tabs and redirects from old routes. |
| Shell Run/API infrastructure | [`api/router.ts:32–118`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/api/router.ts:32), [`runs.ts:367–479`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/runs.ts:367), [`engine/module.ts:9–42`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/engine/module.ts:9) | `/api/runs`, `/api/runs/:id`, retry, and artifact download are shared infrastructure. Modules own their stage order, inputs, retry policy, and result shape. Removing a hosted module makes its historical Runs readable but non-retryable. | `workspace/runs/<runId>/…`, immutable artifacts, Run metadata/timeline. | Shared infrastructure. Retain unchanged conceptually. Add an explicit “retired module” history policy before removing Idea Engine or Transcript → Tasks from hosting. |
| Transcript → Tasks tab | `/transcript` in [`RunsPage.tsx:17–87`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/RunsPage.tsx:17); host and routes in [`transcript/host.ts:24–102`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/transcript/host.ts:24) | Polls one configured Drive folder, converts files to text, extracts summary/action items/email drafts, creates Google Tasks and Gmail drafts. APIs are `POST /api/drive/sync` and `GET /api/intake/drive`. It is not a content-post workflow. | Shared `workspace/state.json` Drive checkpoints; Run-local `context.json`, `transcript.txt`, and `result.json`; background Drive poller and recovery loop; Google Drive, Tasks, and Gmail. | Meeting Wizard → Debrief, initially as a legacy transcript-actions view. Retain until the real Debrief workflow reaches task/draft parity, then retire the top-level tab. |
| Generic transcript conversion and source context | [`transcript/module.ts:29–46`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/transcript/module.ts:29), [`transcript/module.ts:280–333`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/transcript/module.ts:280), [`intake/drive.ts:67–118`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/intake/drive.ts:67), [`text/convert.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/text/convert.ts) | Reusable conversion capability, but the present input context contains only meeting date and attendee `{name,email}` pairs. There is no shared Transcript record, calendar occurrence link, speaker identity model, or cross-Run transcript index. | Drive polling; Run-local text; source URL/external ID in Run metadata. | Shared transcript infrastructure used by Meeting Wizard. Preserve it; add a catalog/identity seam rather than reusing feature-specific extraction. |
| Idea Engine tab | `/idea-engine` in [`IdeaEnginePage.tsx:9–163`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/IdeaEnginePage.tsx:9); host routes in [`idea-engine/host.ts:37–176`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/host.ts:37) | Independently polls the transcript Drive folder and extracts Content Ideas for 12 content types. `GET /api/idea-engine/ideas` exposes a cross-Run index; `POST /api/idea-engine/backfill` reprocesses historical files. | Separate `ideaEngine.ingestedIds` inside `workspace/state.json`; Run artifacts; Google Sheet `All RA Content Ideas`; one Gmail digest draft; its own Drive poller/recovery loop. | Removal/deferment. Remove from active navigation and ingestion. Preserve historical Runs and general transcript infrastructure. Do not treat it as an existing finished-post generator. |
| Idea Engine content model/prompts | [`idea-engine.ts:7–52`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/idea-engine.ts:7), [`idea-engine.ts:126–148`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/idea-engine.ts:126), [`idea-engine/module.ts:125–165`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/module.ts:125) | Each result has Title, Description, audience, CTA, Format, evidence, confidence, and `Custom Prompt`, explicitly described as an Expand Prompt for a downstream copywriter. One default prompt mentions an “SEO-friendly outline,” but the persisted result is still a Content Idea, not a platform outline artifact or post. | LLM calls in batches of four; result and per-type progress artifacts. | Retire Idea Engine-specific contracts/prompts from the active product. They may inform migration/history but should not become the new Content Engine contract. |
| Content Scout tab | `/content-scout` in [`ContentScoutPage.tsx:14–22`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/ContentScoutPage.tsx:14), [`ContentScoutPage.tsx:99–190`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/ContentScoutPage.tsx:99) | Five in-page views: Shortlist, Content Packs, Sources, Brand Profile, Settings & Health. Public Source Targets are collected, ranked into opportunities, held for human selection, then expanded into complete Content Packs. | `workspace/content-scout/state.json`, versioned Brand Profile Markdown, Run artifacts, retained public evidence transcripts, local drafts, Notion pages; daily/weekly schedules and adapter canaries. | Content Engine. Keep opportunity discovery, sources, and Brand Profile capabilities; replace or supplement the fixed complete-pack output with selected-platform outlines according to the product decision in §10. |
| Content Scout server/API | [`content-scout/host.ts:639–1026`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-scout/host.ts:639) | `GET /api/content-scout`; brand profile author/scan/accept; source add/edit/backfill; manual scout/discovery/canary; suggestion decisions; settings; shortlist selection/skip/feedback; draft lookup; storage cleanup; Notion connection/calendar. | Public source adapters, browser renderer, YouTube API, model ranker/generator, Notion output, local retention store. | Backend capabilities can remain a separate hosted Module while the UI is presented within Content Engine. Extract truly shared research adapters and Brand Profile access from feature-local composition. |
| Content Scout output contract | [`content-scout.ts:453–730`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/content-scout.ts:453), [`content-scout/module.ts:623–704`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-scout/module.ts:623) | Version 1 has exactly 23 independent draft targets across LinkedIn, Reddit, web, Substack, email, X, Threads, Bluesky, YouTube, Instagram, and TikTok. Selection produces every target, not a user-selected subset. Current outputs are usually finished copy/scripts, not merely outlines. | One frozen Opportunity Brief per selection; independent model generations; immutable drafts; one Notion page per draft. | Reuse the frozen-brief/sibling-generation pattern, but introduce a new selected-platform outline contract. Do not repurpose the 23-target “complete pack” as if it already matched the requested v1. |
| Public-video transcript research | [`content-scout.ts:95–134`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/content-scout.ts:95), [`youtube adapter:687–918`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-scout/adapters/youtube.ts:687) | A public YouTube Source Item may be enriched with captions/public transcript/`yt-dlp`/bounded local Whisper fallback. That transcript is untrusted evidence used with other Source Item fields. It is not private meeting-transcript ingestion. | Retained evidence transcript; temporary-media retention; explicit available/unavailable/unsupported/failed states. | Shared research capability under Content Engine/Content Research. Retain. It is not the transcript-to-post feature being deferred. |
| Content Research tab | `/content-research` in [`ContentResearchPage.tsx:45–101`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/ContentResearchPage.tsx:45), [`ContentResearchPage.tsx:295–410`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/ContentResearchPage.tsx:295) | Manages a Named Person watchlist, suggestions, manual daily research, backfill, discovery, platform filtering, and a cross-Run index primary by person. | `workspace/content-research/people.json`, sharded Source Items under `content-research/items`, 90-value baselines, schedule/checkpoint state; Google Sheets ledger and owner Gmail draft. | Remain a top-level Content Research product area. Add a reusable on-demand Research Request seam for Content Engine rather than moving its state into Content Engine. |
| Content Research server/API/background | [`content-research/host.ts:330–395`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-research/host.ts:330), [`content-research/host.ts:404–523`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-research/host.ts:404) | People CRUD-by-archive, suggestions, index/report/runs, run/backfill/discovery, and schedule APIs. A 30-second scheduler starts daily research and weekly People Discovery Runs. | Public adapters, public search, LLM hook extraction, Sheets, Gmail; 48-hour collection overlap and 90-day baselines. | Content Research. Keep its Runs and result model independent, consistent with ADR-0039. |
| Named Person model | [`content-research.ts:20–27`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/content-research.ts:20), [`content-research/store.ts:122–148`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-research/store.ts:122) | A Named Person has a random module-local ID, name, handle hints, and discovered targets. Active deduplication is name-only. Despite the domain documentation saying a Named Person “may reference a Person Profile,” the implemented type has no `profileId`. | Stored inside `content-research/people.json`. | Content Research remains owner of the watch decision, but every Named Person should optionally/usually reference one canonical `profileId` plus a pinned profile revision for historical reports. |
| YouTube Trends tab | `/youtube` in [`YoutubePage.tsx:30–60`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/YoutubePage.tsx:30), APIs in [`youtube/host.ts:123–232`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/youtube/host.ts:123) | Tracks configured channels, records every video’s view count, derives charts from Runs, and publishes to one spreadsheet. Manual runs can repeat; automatic intake runs once daily from 06:00. It measures channels rather than producing content. | Configured channels and spreadsheet; `youtubeTrends.lastRunDay` in `workspace/state.json`; YouTube API and Sheets. | Content Research → Trends. Keep the underlying Module and historical route redirect; it is analysis, not creation. |
| Person Profile shared model | [`person-profile.ts:6–77`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/person-profile.ts:6) | Revisioned profile with identity signals, employment/background claims, social profiles, sites, feeds, publications, mentions, source diagnostics, evidence, match confidence, and provenance. | Workspace-owned revision files. | Top-level Person Profiles area and shared application service. |
| Person Profile store/resolver | [`person-profile/store.ts:35–110`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/store.ts:35), [`person-profile/resolver.ts:81–133`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/resolver.ts:81), [`person-profile/resolver.ts:217–345`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/resolver.ts:217) | Store lookup matches only exact email/profile URL/handle. Evidence matching also accepts full-name-plus-employer as high confidence and name-only as medium. `resolve()` collects sources, merges high-confidence signals/claims, creates a new profile when no exact stored match exists, and saves a new revision. | `workspace/person-profiles/<id>/current.json` and `revisions/<n>.json`. | Person Profile shared layer. Split lookup/candidate/enrichment/create/update responsibilities so an extracted name does not automatically become a canonical profile. |
| Person Profile evidence sources | [`person-profile/sources.ts:107–168`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/sources.ts:107), [`person-profile/sources.ts:171–297`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/sources.ts:171) | HubSpot performs exact-email contact lookup and associated-company retrieval. Public web builds bounded queries from emails, names, handles, employer hints, indexed LinkedIn references, personal sites, and declared feeds. | HubSpot API, anonymous public search, feed discovery. | Person Profile-owned adapters, composed once at application startup. Public-search/feed primitives should move out of the Content Research feature directory. |
| Person Profile UI/API surface | Only an explanatory settings card in [`MeetingBriefSettings.tsx:350–369`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/components/MeetingBriefSettings.tsx:350); repository-wide references are server-side Meeting Brief integration. | No profile list, detail page, edit/merge/review UI, API routes, manual confirmation, candidate queue, or app-level service. | None beyond resolver/store. | New top-level Person Profiles surface: list, detail, revision/provenance view, and identity-review queue. |
| Legacy Guest Profile compatibility | [`meeting-brief/host.ts:662–718`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/host.ts:662), [`schemas.ts:173–214`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/schemas.ts:173) | Old `/api/meeting-brief/guest-profile/*` routes and config remain, although new production Runs prefer Workspace Person Profiles. | External endpoint/API key in config. | Remove after migration. Do not expose “Guest Profile” as a new product concept; the domain documentation explicitly replaces it. |
| Meeting Brief Generator tab | `/meeting-brief` in [`MeetingBriefPage.tsx:49–94`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/MeetingBriefPage.tsx:49), [`MeetingBriefPage.tsx:134–208`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/MeetingBriefPage.tsx:134) | Displays upcoming scheduled meetings, “Prepare now,” current briefs, cancellations, delivery state, and revision history. | Derived from Intake schedules and Runs; page performs no live Gmail/HubSpot/Drive reads for history. | Meeting Wizard → Brief. Preserve its distinct workflow and underlying Module. |
| Meeting Brief result/module | [`meeting-brief.ts:39–193`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/meeting-brief.ts:39), [`meeting-brief/module.ts:63–134`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/module.ts:63) | Structured event, guest/company context, conversation starters, references, missing evidence, uncertainty, delivery state, and revision chain. Fixed stages are `snapshot → enrich → compose → deliver`. | Frozen `snapshot.json`, `enrich.json`, structured `result.json`, provider artifacts, Gmail delivery receipt. | Meeting Wizard → Brief; keep its own state machine and result shape. |
| Meeting Brief enrichment | [`enrich.ts:410–440`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/enrichment/enrich.ts:410), [`enrich.ts:442–660`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/enrichment/enrich.ts:442) | For each external attendee: exact Gmail, company-domain Gmail, Calendar history, Drive docs, Person Profile, HubSpot, employer resolution, company news, and industry news. Currently, absence of any required provider class fails the enrichment stage. | Multiple Run-local provider artifacts and aggregated evidence. | Meeting Wizard consumes shared profiles and optional transcript evidence. Change provider availability from an all-or-nothing gate to explicit per-source gaps except for identity-critical Calendar snapshot data. |
| Person Profile use by Meeting Brief | [`enrich.ts:114–155`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/enrichment/enrich.ts:114), [`production.ts:119–149`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/production.ts:119) | Meeting Brief resolves every external attendee from Calendar email, display name, and employer-domain hint, then copies the exact resulting profile revision into a Run artifact. The only production resolver is instantiated here. | Canonical Workspace profile plus Run-local `person-profile-…json` snapshot. | Move composition to a shared application service. Meeting Brief should only request lookup/enrichment and retain a snapshot. |
| Calendar intake and background processing | [`intake.ts:17–33`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/intake.ts:17), [`intake.ts:77–110`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/intake.ts:77), [`calendar.ts:31–80`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/calendar.ts:31) | Watches the primary Calendar, performs incremental or bounded 90-day reconciliation, classifies eligible events, and schedules preparation four hours before start. Future meetings stay in Intake state rather than blocked Runs. | `workspace/meeting-brief-calendar.json`, `workspace/intake-schedules.json`; 30-second maintenance and six-hour drift-repair cadence; calendar sync token/channel. | Shared meeting infrastructure used by Meeting Wizard’s Overview and Brief. Debrief should link to the same occurrence identity but own separate Runs. |
| Calendar relay | [`ADR-0031`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0031-calendar-push-uses-an-opaque-cloud-relay.md:1), [`main.ts:327–334`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/main.ts:327) | Minimal cloud relay carries only opaque “calendar changed” wake-ups; the local app fetches actual event data. | `workspace/relay.json`, external relay deployable, local poller. | Shared meeting infrastructure. Retain the opaque-data boundary. |
| Meeting Brief APIs | [`meeting-brief/host.ts:720–798`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/host.ts:720) | `GET /api/meeting-brief/index`, config read/write, reconcile, prepare, and calendar status. | Calendar state, DurableClock, Runs. | Alias or redirect UI-facing calls under `/api/meetings/brief/*`; retain old routes during migration. |
| Meeting Debrief | Domain model only in [`CONTEXT.md:253–267`](/Users/Nicolas/Documents/github/chief-of-staff-demo/CONTEXT.md:253), review semantics in [`ADR-0037`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0037-generated-fields-are-regenerated-never-edited.md:1), lifecycle in [`ADR-0038`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0038-a-meeting-debrief-waits-for-a-person-and-expires-rather-than-sending.md:1) | Planned Executive Assistant Module: decisions, action items, open questions, summary, effectiveness evidence, and coaching advice; review/regenerate/drop actions; human approval before Gmail draft and Google Tasks; 30-day expiry. | **No implementation found.** | New Meeting Wizard → Debrief workflow backed by its own Executive Assistant Module and Runs. |
| App composition coupling | [`main.ts:137–164`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/main.ts:137), [`main.ts:177–253`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/main.ts:177), [`main.ts:276–296`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/main.ts:276) | Content Scout and Content Research share production adapter construction. Content Research creates a `ContentScoutStore` solely to read the current Brand Profile. Meeting Brief separately constructs Person Profiles inside its production runtime. | One local process; shared Google connection/model configuration but feature-local service construction. | Move shared research adapters, Brand Profile access, Person Profile service, and transcript catalog to application-level composition. Keep Module runners/results separate. |

## 1.2 Meaningful test inventory

The affected behavior is covered by these test families:

- Transcript processing: [`pipeline.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/pipeline/pipeline.test.ts:163), [`drive-intake.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/unit/drive-intake.test.ts:190), [`transcript-host.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/transcript-host.test.ts), and [`transcript-stranded-recovery.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/transcript-stranded-recovery.test.ts).
- Idea Engine: [`idea-engine.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/idea-engine.test.ts:264), [`idea-engine-intake.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/idea-engine-intake.test.ts), [`idea-engine-index.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/idea-engine-index.test.ts), and [`idea-engine-backfill.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/api/idea-engine-backfill.test.ts).
- Content Scout: the primary contract is in [`content-scout.test.ts:231`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/content-scout.test.ts:231), including the 23-draft guarantee at line 807. Supporting suites cover adapters, backfill, Brand Profile, Opportunity Brief, discovery, canaries, model boundaries, Notion, public command handling, fixtures, platform-specific adapters, and YouTube transcript fallback under [`tests/src/modules/`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules).
- Content Research: [`content-research.test.ts:293`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/content-research.test.ts:293) and [`content-research-routes.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/api/content-research-routes.test.ts).
- Person Profile: [`person-profile.test.ts:16`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/person-profile.test.ts:16) and Meeting Brief profile snapshots in [`meeting-brief-generator-profile.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/meeting-brief-generator-profile.test.ts).
- Meeting Brief and Calendar: [`meeting-brief-generator.test.ts:152`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/meeting-brief-generator.test.ts:152), [`meeting-brief-calendar-intake.test.ts:100`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/meeting-brief-calendar-intake.test.ts:100), plus provider, Gmail, Google enrichment, HubSpot, production runtime, public intelligence, quiet-period, revision, and spec-regression suites in [`tests/src/modules/`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules). The main browser journey is [`meeting-brief-journey.spec.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/e2e/meeting-brief-journey.spec.ts).
- YouTube Trends: [`youtube-trends.test.ts:188`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/modules/youtube-trends.test.ts:188), [`youtube-routes.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/api/youtube-routes.test.ts), [`youtube-channels.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/unit/youtube-channels.test.ts), and [`youtube-client.test.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/tests/src/unit/youtube-client.test.ts).
- No Meeting Debrief implementation tests were found.

---

# 2. Current end-to-end workflows and their real seams

## 2.1 Researching content

### Observed: Content Research

1. The user adds a Named Person by name with optional feed/site, YouTube channel ID, and HN username on `/content-research`.
2. `POST /api/content-research/people` creates a module-local Named Person and resolves source targets.
3. Daily/manual/backfill work derives platform targets, then uses Content Scout’s `SourceAdapter` and collection-core contracts. The direct imports are visible in [`content-research/collection.ts:1–18`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-research/collection.ts:1).
4. The Run executes `collect → normalize → scoreResonance → extractHook → publish`. The daily path is visible in [`content-research/module.ts:465–598`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-research/module.ts:465).
5. Raw Source Items are sharded locally; reports and evidence remain in Run artifacts.
6. Output is a per-person Resonance Report, Sheet ledger rows, an owner Gmail draft, and a Run summary shown on Home.

### Observed: Content Scout research

1. The user accepts a versioned Brand Profile and approves Source Targets.
2. `Scout now` starts collection through public adapters.
3. Content Scout filters and enriches promising evidence, ranks opportunities, writes a shortlist, and blocks the same Run for user selection.
4. The user selects one to three opportunities.
5. Each selection freezes an Opportunity Brief and produces every one of 23 independent drafts plus one Notion page per draft. The UI makes that contract explicit at [`ContentScoutPage.tsx:403–415`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/ContentScoutPage.tsx:403).

### Actual seam

The reusable seam is **public Source Target → Source Adapter → Source Item**, not “the Content Scout tab.” Content Research already consumes that seam. Content Research’s per-person baselines, watch decisions, reports, and Runs are not reusable Content Scout state and should remain separate.

## 2.2 Creating a post or outline

### Observed

There are two adjacent but distinct paths:

- **Content Scout** creates finished copy/scripts/production plans for 23 fixed targets after opportunity selection. It does not let the user choose an arbitrary subset of platforms and does not stop at an outline.
- **Idea Engine** creates transcript-derived Content Ideas. Its `Custom Prompt` is an Expand Prompt “the prompt a downstream copywriter uses”; the repository does not contain that downstream copywriter workflow. The model instruction is explicit at [`idea-engine/module.ts:138–155`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/module.ts:138).

### Cannot verify

I found no current route, stage, result shape, output adapter, or test that takes a private meeting transcript and directly persists a finished post. The questionnaire’s phrase “current transcript-to-post functionality” therefore maps most closely to **Idea Engine’s transcript-to-Content-Idea workflow**, not to a literal implemented post generator.

## 2.3 Creating or enriching a Person Profile

### Observed flow

1. There is no direct user entry point.
2. Meeting Brief identifies each external Calendar attendee by email, display name, and non-consumer employer-domain hint.
3. `PersonProfileResolver.resolve()` first calls `PersonProfileStore.findBySignals()`.
4. Store lookup only considers exact normalized email, profile URL, or platform handle.
5. HubSpot and public-web sources collect candidate evidence.
6. `matchPersonEvidence()` classifies exact email/URL/handle and name-plus-employer as high confidence, name-only as medium, and rejects contradictory exact identifiers.
7. High-confidence evidence can add canonical signals and claims; conflicting high-confidence claims resolve to `null`.
8. A new or revised profile is written.
9. Meeting Brief stores the exact profile revision as a Run-local artifact before composing the brief.

### Important seam and defect risk

The **Workspace profile store/resolver** is already the correct ownership layer. The problem is that it is composed inside Meeting Brief production and exposes one overly broad `resolve()` operation.

There is also a lookup mismatch:

- Evidence matching treats `name + employer` as high confidence at [`resolver.ts:114–120`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/resolver.ts:114).
- Stored-profile lookup ignores both names and employer hints at [`store.ts:58–85`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/person-profile/store.ts:58).

Consequently, a future name-plus-employer transcript request could fail to find an existing profile, generate the same stable name-derived ID or a different signal-derived ID, and overwrite or duplicate incorrectly. That is one reason not to feed mined names directly to `resolve()`.

## 2.4 Generating a Meeting Brief

### Observed flow

1. Google Calendar push wakes the local application through an opaque relay.
2. The app fetches actual Calendar state and performs incremental or bounded 90-day reconciliation.
3. Eligible events are timed, not cancelled, not owner-declined, and contain at least one non-declined external guest.
4. Intake stores a durable schedule for four hours before the event; no future placeholder Run is created.
5. At the due time or after “Prepare now,” the host creates one Run for the occurrence/version.
6. `snapshot` re-fetches and freezes current Calendar truth and eligibility.
7. `enrich` gathers Gmail, Calendar history, Drive, Person Profile, HubSpot, employer, company, and industry evidence.
8. `compose` produces a structured Meeting Brief with citations, missing evidence, and uncertainty.
9. `deliver` rechecks current truth and sends only to the connected owner.
10. Material Calendar revisions create a new Run; old Runs remain historical.

The prospective meeting state is correctly separate from retrospective transcript processing.

## 2.5 Processing a transcript

### Observed: Transcript → Tasks

`Drive file → convert → extract structured summary/tasks/email drafts → Google Tasks + Gmail drafts`.

The prompt is action-oriented, not content-oriented; it asks for `tasks`, `drafts`, and `summary` in [`llm/prompt.ts:34–86`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/llm/prompt.ts:34).

### Observed: Idea Engine

`Same Drive folder → separate checkpoint/poller → convert → 12 content-type LLM stages → Content Ideas → Sheet rows + Gmail digest`.

The shared state file deliberately maintains separate transcript and Idea Engine ingestion IDs at [`state.ts:25–38`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/state.ts:25) and [`state.ts:96–130`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/state.ts:96). Therefore the same file can be downloaded, converted, and stored twice—once per Module.

A significant current attribution weakness is documented in code: for multi-speaker transcripts, Idea Engine ultimately trusts the model’s confidence rather than enforcing speaker attribution ([`idea-engine/module.ts:580–583`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/module.ts:580)). That code must not become the basis of canonical person identity matching.

## 2.6 Producing a Meeting Debrief

### Observed

No implemented workflow exists.

### Planned, not verified in code

The documentation specifies:

- structured decisions;
- action items with inferred owner and optional due date;
- open questions;
- summary;
- effectiveness assessment with evidence;
- coaching advice;
- field regeneration rather than character-level editing;
- dropping individual action items;
- a blocked human-review wait;
- 30-day expiry to `skipped`;
- Gmail draft first, Google Tasks second, only after approval.

Those are architectural decisions, not working code.

## 2.7 Duplication, coupling, and reusable capabilities

| Finding | Evidence and implication |
| --- | --- |
| Duplicate private-transcript intake | Transcript → Tasks and Idea Engine independently poll the same folder and keep separate checkpoints. Reuse conversion and source cataloging, but keep workflow Runs separate. |
| Feature-local public research imports | Content Research imports Content Scout ports, diagnostics, and collection-core. The contracts are reusable; their location incorrectly implies Content Scout ownership. |
| Brand Profile hidden dependency | `main.ts` constructs `ContentScoutStore` solely so Content Research can call `currentBrandProfile()` ([`main.ts:186–250`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/main.ts:186)). Extract a shared Workspace Brand Profile repository/service. |
| Reverse Person Profile dependency | Meeting Brief’s Person Profile production source imports `createPublicSearch()` and `createFeedDiscoverer()` from Content Research implementation. Generic public search/feed discovery should not be owned by one consumer feature. |
| Person Profiles are only nominally app-wide | The model/store are at server root, but production construction and all consumption are Meeting Brief-local. Add one shared service composed in `main.ts`. |
| Named Person/Profile drift | Domain docs say Named People may reference profiles, but the implemented type has no profile reference and deduplicates by name. Add an explicit link; do not merge the two concepts. |
| Useful shared seams already exist | Run engine, immutable artifacts, LLM Result Shapes, Google connection, text conversion, Source Adapter/Source Item, Brand Profile, Opportunity Brief, Person Evidence, profile snapshots, Calendar occurrence identity, and DurableClock. |
| Tab/module coupling is accidental UI architecture | The nav renders every live Module. Product-area consolidation requires product routes to aggregate several Module surfaces without merging Module state machines. |

---

# 3. Recommended final information architecture and tab names

## 3.1 Top-level navigation

| Exact tab label | Route | Landing state | Rationale |
| --- | --- | --- | --- |
| **Content Engine** | `/content` | **Create** | The primary creation workflow: subject, platforms, research, sources, platform outlines. |
| **Content Research** | `/content-research` | **People** | Independent watch/research/report workflow. It remains useful without an active Content Engine project and has its own schedule, Runs, baselines, and discovery lifecycle. |
| **Person Profiles** | `/people` | **Profiles** | App-wide shared resource with manual review/provenance needs. A top-level entry prevents it from looking owned by meetings or content. |
| **Meeting Wizard** | `/meetings` | **Overview** | One meeting area, with Brief and Debrief visibly separate. Overview connects upcoming and recently completed meetings without creating one combined state machine. |
| **Settings** | `/settings` | Existing settings landing | Shell-level configuration. |
| Home | `/` through the existing Found42 title | Existing status surface | Home remains the cross-Module status surface, not another functional tab. |
| Runs | `/runs`, `/runs/:id` | Existing history/detail | Keep as a Shell utility reached from product areas and Home, not a top-level functional tab. |

## 3.2 Content Engine internal routes

| Label | Route | Responsibility |
| --- | --- | --- |
| **Create** | `/content` and canonical `/content/create` | Select topic/Profile, goal/audience, platforms, and research; review sources; generate outlines. `/content` should render or redirect to this mode. |
| **Opportunities** | `/content/opportunities` | Existing Content Scout shortlist, opportunity evidence, dismissals, cooldowns, and selection. |
| **Library** | `/content/library` | Generated outline sets and preserved historical Content Packs. |
| **Sources** | `/content/sources` | Approved Source Targets and source suggestions. |
| **Brand Voice** | `/content/brand` | Current versioned Brand Profile. “Brand Voice” is a clearer user-facing label; the underlying domain name may remain Brand Profile. |
| Content settings | `/settings/content` | Schedules, adapter health, Notion, canaries, and storage retention. These are operational settings rather than creation modes. |

## 3.3 Content Research internal routes

| Label | Route | Responsibility |
| --- | --- | --- |
| **People** | `/content-research` or `/content-research/people` | Named Person watchlist, Profile links, source hints, suggestions. |
| **Reports** | `/content-research/reports` | Per-person Resonance Reports and source evidence. |
| **Trends** | `/content-research/trends` | Existing YouTube Trends charts and channel tracking. |
| Research settings | `/settings/content-research` | Daily/weekly schedule and integration status. |

## 3.4 Person Profiles internal routes

| Label | Route | Responsibility |
| --- | --- | --- |
| **Profiles** | `/people` | Searchable canonical profile list. |
| Profile detail | `/people/:profileId` | Identity signals, facts, sites, publications, evidence, provenance, revision history, and consumer links. |
| **Review** | `/people/review` | Transcript mentions, ambiguous matches, merge suggestions, and disputed evidence. |
| New/manual profile | `/people/new` | Explicit user-authored profile or confirmed unmatched candidate. |

## 3.5 Meeting Wizard internal routes

| Label | Route | Responsibility |
| --- | --- | --- |
| **Overview** | `/meetings` | Upcoming eligible meetings, brief readiness, recently completed meetings, transcript status, and debriefs awaiting review. |
| **Brief** | `/meetings/brief` | Prospective Calendar-driven workflow: upcoming, current briefs, revisions, cancellations. |
| **Debrief** | `/meetings/debrief` | Retrospective transcript-driven workflow: transcript association, extraction, review, approval, Gmail draft, and Tasks. |
| Brief detail | `/meetings/brief/:occurrenceKey` | Current brief plus revision chain. |
| Debrief detail | `/meetings/debrief/:runId` | One Executive Assistant Run and its review/delivery state. |
| Legacy transcript actions | `/meetings/debrief/legacy` | Temporary access to current Transcript → Tasks history until Debrief replacement is complete. |

## 3.6 Current-to-proposed route mapping

| Current route | Proposed destination |
| --- | --- |
| `/content-scout` | Permanent redirect to `/content/opportunities`. |
| `/idea-engine` | Redirect to `/content/library?source=idea-engine` or a retired-history notice. Remove active ingestion and “backfill” actions. |
| `/youtube` | Redirect to `/content-research/trends`. |
| `/content-research` | Remains `/content-research`; split internal views as needed. |
| `/meeting-brief` | Redirect to `/meetings/brief`. |
| `/transcript` | Initially redirect to `/meetings/debrief/legacy`; later redirect to `/meetings/debrief` after parity and migration. |
| `/runs` and `/runs/:id` | Retain unchanged. |
| No current Person Profile route | Add `/people`. |
| No current Meeting Debrief route | Add `/meetings/debrief`. |

The existing backend Module IDs should not be renamed merely to match the routes. Historical Runs depend on stable IDs such as `content-scout`, `meeting-brief-generator`, and `transcript`.

---

# 4. Recommended responsibility boundaries

| Capability | Owns | Inputs | Outputs/consumers | Must not own |
| --- | --- | --- | --- | --- |
| **Content Engine** | Content project intent; selected subject/profile revision; platform selection; selected research evidence; frozen Outline Brief; per-platform outlines; regeneration/version state | Person Profile snapshots, Content Research reports/requests, Source Items, Brand Profile, user goal/audience/platforms | Platform outline set for the user; later publishing workflows may consume it | Canonical person identity, profile enrichment, watch-list decisions, resonance baselines, transcript ingestion, meeting state, arbitrary profile annotations |
| **Content Research** | Named Person watch decision, source hints/targets, scheduled/manual research Runs, Source Item collection, resonance baselines, hook extraction, Resonance Reports, People Suggestions | `profileId` or explicit subject identity, shared public adapters, Brand Profile context | Content Engine, user reports, future consumers | Canonical Person Profile facts, content-outline state, posting/publishing state, meeting records |
| **Person Profile** | Canonical profile ID, identity signals, candidate lookup, enrichment, provenance, evidence, confidence, revisioning, merge/split/review decisions | Calendar attendees, HubSpot, public search, social/profile URLs, transcript mentions, manual corrections | Meeting Brief, Meeting Debrief, Content Engine, Content Research, future outreach | Meeting-specific talking points, content angles, resonance scores, debrief action items, outreach policy, consumer-specific rankings |
| **Meeting Wizard – Brief** | Calendar occurrence intake, eligibility, preparation schedule, frozen event snapshot, brief-specific enrichment snapshot, structured Meeting Brief, revision and delivery state | Calendar event, Profile snapshots, Gmail/Calendar/Drive/HubSpot/public intelligence, relevant transcript evidence | Owner-facing brief and owner-only email | Canonical profile updates, transcript identity decisions, retrospective actions |
| **Meeting Wizard – Debrief** | Transcript association, debrief extraction, review wait, regeneration/drop decisions, approval, Gmail draft, Tasks | Transcript artifact, Calendar occurrence, participants/Profile snapshots | Structured Meeting Debrief, Gmail draft, Google Tasks | Prospective brief lifecycle, canonical identity guesses, automatic outward writes before approval |
| **Shared research infrastructure** | Source Adapter contract, collection retry/concurrency, public search, feed discovery, normalized Source Item/evidence handling | Approved targets/queries | Content Research, Content Engine, Person Profile public evidence where appropriate | Feature-specific Runs, rankings, profiles, outlines |
| **Shared transcript infrastructure** | Source ingestion, conversion, immutable transcript artifact, source metadata, Calendar occurrence link, speaker/participant metadata, Transcript Mention records | Drive/Fireflies or later sources | Debrief, Profile matching, optional future Content Engine source | Debrief decisions, content ideas, canonical profile creation without policy |
| **Shell/shared engine** | Runs, stages, artifacts, retry/recovery, Google connection, LLM boundary, common settings | Module-owned inputs | Every Module | Module result shapes and business decisions |

## Existing modules and code placement

### Can remain substantially in place

- Content Research Module, Runs, report models, baselines, scheduling, and APIs.
- Meeting Brief Module, Calendar Intake, DurableClock, revision chain, and delivery logic.
- Content Scout collection, opportunity ranking, source/Brand Profile management, and its existing historical Content Pack reader.
- Transcript conversion, Google connection, Run engine, LLM boundary, and generic artifact handling.
- Person Profile model/store/resolver location under `apps/server/src/person-profile`, after its API is split into narrower operations.

### Should move or be extracted

- `SourceAdapter`, collection-core, public search, feed discovery, and shared diagnostics out of `modules/content-scout`/`modules/content-research` into a neutral research package.
- Brand Profile storage access out of `ContentScoutStore` into a Workspace service, because both Content Scout/Engine and Content Research use it.
- Person Profile production composition out of Meeting Brief’s `production.ts` into `main.ts` or a shared application-services composition root.
- Private transcript intake/conversion indexing into a shared Transcript service rather than duplicating Drive polling per consuming Module.

### Requires a new shared seam

The Person Profile service should expose operations with different authority:

- `searchCandidates(signals, context)` — read-only candidate generation.
- `get(profileId)` / `getRevision(profileId, revision)` / `list()`.
- `enrich(profileId, requestedSources)` — creates a profile revision but does not change identity linkage.
- `proposeProfile(candidateEvidence)` — creates a reviewable proposal.
- `confirmMatch(mentionId, profileId)` — records a human identity decision.
- `createConfirmedProfile(signals, provenance)` — explicit canonical creation.
- `mergeProfiles()` / `splitEvidence()` — manual, audited operations.
- `attachEvidence(profileId, evidence)` — only after evidence meets policy or is confirmed.

`resolve()` can remain as a compatibility facade for strong Calendar-email cases, but it should not be the transcript-mining API.

## Preventing consumer annotations from polluting profiles

Canonical profiles should contain durable identity and evidence-backed person facts. Consumer-specific data should live with the consumer:

- Meeting-specific relationship history, talking points, and “why relevant to this meeting” stay in the Meeting Brief Run.
- Decisions, commitments, sentiment, and action-item ownership stay in the Debrief Run.
- Resonance score and hook stay in Content Research reports.
- Content angle, audience, voice treatment, and selected quote stay in the Content Engine project.
- A transcript statement such as “Priya thinks our launch is premature” is not a durable profile fact. It remains transcript evidence or meeting context unless a separate explicit profile claim type and review policy is introduced.

Consumers should retain `{profileId, profileRevision}` snapshots so historical outputs remain reproducible when the canonical profile changes.

---

# 5. Recommended transcript name-mining and identity-matching pipeline

## 5.1 Design principle

A transcript mention is evidence that a string was spoken in a particular context. It is not proof of a canonical identity.

The shared pipeline should produce a durable, reviewable **Transcript Mention**, then generate **Profile Match Candidates**. It should never call `PersonProfileResolver.resolve()` for every name.

## 5.2 Proposed stages

### Stage 1: Register and anchor the transcript

Persist a shared Transcript record containing:

- transcript ID and source system;
- source file/external ID;
- producing Run ID and immutable transcript artifact reference;
- meeting date/time;
- linked Calendar `eventId`, `occurrenceId`, and `occurrenceKey`, when available;
- Calendar attendees and organizer;
- source-system participants;
- diarization speaker IDs and any source-provided speaker-to-email mapping;
- ingestion/conversion version and checksum.

Current `TranscriptRunContext` only has meeting date and attendee name/email, so it needs Calendar occurrence and speaker metadata extensions.

### Stage 2: Normalize without destroying evidence

Normalize candidate-comparison forms while preserving original spans:

- Unicode normalization;
- whitespace and punctuation normalization;
- lowercase comparison forms;
- email normalization;
- URL canonicalization;
- platform-specific handle normalization;
- organization suffix normalization for comparison only (`Inc.`, `LLC`, `Ltd.`);
- honorific and credential stripping for comparison only;
- speaker segment/timestamp retention.

Never replace the original quote, spelling, timestamp, or speaker label.

### Stage 3: Extract entities and relationships

Use one strict LLM Result Shape, supplemented by deterministic email/URL/handle recognition:

```text
TranscriptMention
- mentionId
- sourceSpan: {start/end or timestamp, quote, context}
- speakerId
- surfaceText
- entityKind: person | organization | product | role | unknown
- normalizedName
- organizationContext[]
- roleOrTitle
- observedEmails[]
- observedHandles[]
- observedProfileUrls[]
- relationshipAssertions[]
- extractionConfidence
- extractorVersion
```

The model instruction should explicitly retain:

- meeting participants;
- non-participant person names;
- people named only in organizational context, such as “Priya from Acme”;
- organizations connected to a person;
- titles and roles;
- ambiguous single names;
- speaker references such as “our CFO” or “Jordan’s manager” as unresolved mentions.

It must not force every capitalized phrase into a person.

### Stage 4: Add authoritative context signals

Join evidence from:

1. transcript speaker metadata;
2. meeting participants supplied by the transcript source;
3. Google Calendar attendees/organizer for the linked occurrence;
4. exact emails in the transcript;
5. exact social handles or profile URLs;
6. existing Person Profiles;
7. exact HubSpot contacts and company associations;
8. Content Research Named Person links;
9. title and organization context;
10. public evidence only when bounded enrichment is requested.

Calendar and source-system metadata should remain independently attributed; they are not silently merged into the transcript claim.

### Stage 5: Generate candidates

Candidate retrieval should use indexed normalized signals:

- exact email;
- exact canonical profile URL;
- exact platform handle;
- exact HubSpot contact ID;
- source speaker mapped to attendee email;
- normalized full name;
- full name plus organization;
- full name plus title;
- known aliases;
- previously confirmed transcript mention mappings.

The current store needs indexes for names, organization aliases, and external IDs; `findBySignals()` is insufficient.

### Stage 6: Score candidates and preserve explanations

A practical v1 score can be additive and auditable:

| Signal | Suggested weight |
| --- | ---: |
| Exact email | +100 |
| Exact canonical LinkedIn/profile URL | +100 |
| Exact HubSpot contact ID | +100 |
| Exact verified platform handle | +90 |
| Speaker metadata explicitly mapped to Calendar attendee email | +90 |
| Exact normalized full name | +35 |
| Same organization/employer | +30 |
| Same role/title | +15 |
| Same meeting participant roster | +15 |
| Prior human-confirmed alias/mapping | +80 |
| Independent supporting source | +10, bounded |
| Conflicting exact email | −120 |
| Conflicting exact profile URL/handle | −120 |
| Conflicting current organization with no historical explanation | −35 |
| Candidate is an organization/product rather than a person | reject |

The stored candidate must include its individual signal contributions, not only a numeric total.

### Stage 7: Apply confidence and ambiguity policy

| Classification | Policy |
| --- | --- |
| **Confirmed**: score ≥ 90, no hard conflict, and lead over second candidate ≥ 20 | Automatically link the mention to an existing profile. Do not automatically rewrite profile facts. |
| **Probable**: score 70–89, or strong score with lead < 20 | Keep a suggested link for manual review. Consumers may display it as tentative with explicit uncertainty. |
| **Ambiguous**: score < 70, name-only, conflicting anchors, or tied candidates | No link. Keep all plausible candidates and original mention. |
| **Not a person/rejected** | Preserve the extraction decision and reason for audit, but do not enter the profile review queue unless the user reclassifies it. |

The exact thresholds can be tuned later without changing the persisted evidence model if all contributions are retained.

### Stage 8: Human confirmation and deduplication

The Person Profiles → Review surface should allow:

- confirm candidate;
- choose another profile;
- create a new profile;
- mark “not a person”;
- mark “person, unresolved”;
- merge duplicate profiles;
- split wrongly attached evidence.

Deduplicate Transcript Mentions by a stable hash of transcript ID, source span/timestamp, normalized surface text, and extractor version. Coreferential mentions inside one transcript may be grouped, but the original mentions should remain individually traceable.

Canonical profile deduplication must never be a background string-merge operation.

### Stage 9: Canonical profile creation policy

Automatically creating a new canonical profile is safe only when all of these are true:

- there is a stable authoritative identifier, such as an exact Calendar email, exact HubSpot contact, exact canonical profile URL, or source speaker explicitly mapped to an attendee email;
- no existing profile has that identifier;
- there is no hard contradiction;
- provenance identifies where the identifier came from.

A name plus organization, title, or transcript context should **not** auto-create a profile. It should create a reviewable candidate. A name-only mention should never auto-create one.

A strong Calendar attendee email may create a minimal “shell” profile automatically because the event itself provides a stable address, but any employer, title, publication, or social claim still requires attributed evidence.

## 5.3 Stored evidence and decisions

Persist outside the canonical profile:

```text
TranscriptIdentityDecision
- mentionId
- transcriptId / runId
- source quote and timestamp
- normalized signals
- calendar/source participant context
- candidate profile IDs
- score breakdown per candidate
- top-score gap
- classification
- decision: pending | confirmed | rejected | unresolved
- confirmedProfileId and profileRevision, if any
- decidedBy: policy | user
- decidedAt
- algorithm/extractor versions
```

Only after confirmation should eligible identity evidence be attached to a Person Profile, with the Transcript Mention as provenance. Feature-specific interpretation stays in the meeting/content consumer.

## 5.4 Difficult examples

### Example A: two people named Alex Kim

Transcript: “Alex Kim at Northstar will own the security review.”

Existing profiles:

- Alex Kim, `alex@northstar.example`, VP Security.
- Alex Kim, `akim@contoso.example`, Product Lead.

If Calendar contains `alex@northstar.example`, the exact email and organization yield a confirmed match. If the meeting contains neither email nor speaker mapping, “Alex Kim + Northstar” is strong but should remain reviewable unless Northstar is already high-confidence canonical employer evidence and the score clearly exceeds the second candidate. The quote itself must not change the profile’s role to “security review owner”; that is meeting context.

### Example B: organization/product ambiguity

Transcript: “Jordan at Notion said the database migration is delayed.”

“Notion” can be a company, product, or workspace concept; “Jordan” is a single name. Extract:

- person mention: Jordan;
- organization-context candidate: Notion;
- relationship assertion: possible `works_at`, low/medium confidence.

No profile should be created. If Calendar has a Jordan with an exact email at `makenotion.com`, that becomes a strong candidate. Otherwise it remains unresolved rather than matching every Jordan whose profile mentions Notion.

### Example C: non-attendee mentioned in organizational context

Transcript: “Priya Shah from Acme’s policy team wrote the original memo.”

Priya is not a participant. The pipeline must retain her name, Acme context, policy-team title hint, and quote. If an exact HubSpot contact or canonical LinkedIn URL is later found, the existing profile may be confirmed. Name-plus-Acme alone creates a review candidate. Meeting Brief may show her under “Related people mentioned in prior conversations,” but not as an attendee.

### Example D: abbreviated speaker label

Transcript source speaker: `J. Chen`; source metadata maps that speaker to `jane.chen@example.com`; Calendar contains the same email.

The exact source-to-attendee email mapping confirms the profile even though the visible speaker label is abbreviated. If the source metadata merely guessed “J. Chen” without an email, it remains a candidate signal, not confirmation.

---

# 6. Recommended Content Engine outline workflow

## 6.1 User flow

1. **Start a content project**
   - Choose a Person Profile as the subject or point of view, or choose “Topic without a profile.”
   - If a profile is selected, snapshot `{profileId, profileRevision}`.
   - Set objective, audience, and optional seed idea.
   - Apply the current Brand Profile/Brand Voice revision.

2. **Choose one or more platforms**
   - Use explicit platform/format choices, not the current mandatory 23-target pack.
   - Each choice resolves to a versioned Outline Target contract.

3. **Choose research**
   - Reuse existing Content Research reports for the selected Profile.
   - Optionally request a fresh bounded Content Research Run.
   - Allow topic-oriented public Source Items from approved Content Engine sources.
   - Do not expose meeting transcripts as a source in v1.

4. **Review sources**
   - Show canonical URL, title, publisher/person, date, evidence excerpt, completeness, and provenance.
   - Let the user include/exclude/pin sources.
   - Surface gaps, conflicts, and unavailable transcript/body states.
   - Freeze the selected sources before generation.

5. **Review the shared angle**
   - Build one immutable `OutlineBrief` containing subject/profile snapshot, objective, audience, Brand Profile revision, thesis, angle, key claims, selected evidence, citation map, CTA intent, and chosen targets.
   - The user confirms or regenerates the shared angle before platform generation.

6. **Generate independent platform outlines**
   - One model call per selected target, run concurrently within a bound.
   - Every outline reads the same frozen `OutlineBrief`.
   - No platform outline sees or transforms another platform’s output.

7. **Review and save**
   - Display outlines side by side.
   - Permit target-specific regeneration without regenerating siblings.
   - Save an Outline Set and link it to its research/profile/Brand Profile revisions.

## 6.2 Shared versus platform-specific generation

### Shared once

- subject/Profile snapshot;
- selected sources;
- evidence/citation map;
- thesis and central claim;
- audience and objective;
- Brand Voice;
- factual constraints and uncertainty;
- CTA intent.

### Generated separately for every platform/format

- hook;
- structure and beat order;
- expected length;
- presentation conventions;
- source placement;
- CTA rendering;
- visual/audio production beats where the target requires them.

This follows the strongest existing Content Scout decision: sibling outputs should share an immutable brief rather than being serial adaptations of one another ([`ADR-0028`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:1)).

## 6.3 Recommended v1 output shape

Each Platform Outline should contain:

- target ID/version;
- working title;
- primary hook;
- thesis;
- ordered sections/beats;
- intended evidence/citation for each beat;
- examples or proof points;
- CTA;
- target length/duration;
- platform-specific constraints;
- uncertainty or unsupported-claim warnings;
- production notes, where relevant.

V1 should not produce:

- finished social copy;
- publication scheduling;
- image/video assets;
- direct platform posting;
- transcript-derived research;
- 23 mandatory outputs;
- autonomous profile creation.

## 6.4 Current functionality to reuse

- Source Adapter and Source Item contracts.
- Bounded collection/retry/concurrency and completeness states.
- Content Research reports, baselines, and hook evidence.
- Versioned Brand Profile.
- Content Scout’s frozen Opportunity Brief principle.
- Independent sibling generation and missing-only retry.
- Model-boundary Result Shapes.
- Run artifacts and cross-Run indexes.
- Evidence sanitation and citation handling.
- Person Profile revision snapshots.

The current 23 Draft Target contracts can inform platform constraints, but a new **Outline Target** contract should be explicit. A 2,500-word script and a carousel outline are not the same result type simply because both are content.

---

# 7. What should happen to current transcript-to-post functionality?

## 7.1 Exact current inventory

### Private meeting transcript → Content Ideas

- UI/tab: `/idea-engine`, [`IdeaEnginePage.tsx`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/pages/IdeaEnginePage.tsx:9).
- Routing/navigation: [`App.tsx:74`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/App.tsx:74), [`useModules.ts:62–67`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/web/src/useModules.ts:62).
- Intake: independent Drive poller in [`idea-engine/intake.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/intake.ts:147).
- Server/API: `GET /api/idea-engine/ideas` and `POST /api/idea-engine/backfill`.
- Logic: conversion, chunking, 12 content-type extractions, confidence filtering, per-type deduplication, persistence, Sheet publication, and Gmail digest in [`idea-engine/module.ts`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/idea-engine/module.ts:177).
- Prompts/types: [`idea-engine.ts:7–52`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/idea-engine.ts:7) and [`idea-engine.ts:126–148`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/idea-engine.ts:126).
- Storage: Idea Engine Run artifacts, separate Drive checkpoints, external Sheet rows.
- Tests: the four Idea Engine suites listed in §1.2.

Again, the output is a Content Idea plus Expand Prompt, not a finished post.

### Public source transcript → Content Scout drafts

Content Scout’s YouTube adapter can attach a public transcript to a Source Item, and that item can support an Opportunity Brief and finished drafts. This is not the same workflow:

- it is public research evidence;
- it does not ingest the private transcript folder;
- the transcript can be one of several Source Item fields;
- it should remain available as a research capability.

## 7.2 Remove from the active product now

For Idea Engine:

- remove the top-level nav item;
- remove active `/idea-engine` user actions;
- stop its Drive poller and automatic recovery of new transcript work;
- remove/disable backfill;
- stop new Sheet publication and Gmail digest creation;
- remove its settings controls when migration is complete;
- retire the 12 transcript-specific content prompts from active generation;
- remove Idea Engine-specific active-product tests only when the production code is actually removed or archived.

Do not erase historical Runs, artifacts, Sheet data, or source links. Old `/idea-engine` should lead to a clear archived-history view or Content Engine Library filter.

Because `/api/runs/:id/retry` requires the original Module to remain hosted, retirement needs an explicit policy. Recommended: keep a lightweight retired module descriptor that can render history but refuses new Runs/retries with “Idea Engine was retired,” or accept non-retryable historical Runs and make that state clear in the UI.

## 7.3 Retain as shared capability

- generic Drive/file ingestion used by current Transcript → Tasks and future Debrief;
- `convertToText()` and conversion diagnostics;
- immutable `transcript.txt` artifacts and source metadata;
- Run/stage/retry infrastructure;
- LLM Result Shape/failure handling;
- transcript source participant context;
- current Transcript → Tasks until Debrief has functional parity;
- public-video transcript support in Content Scout’s research adapters;
- evidence provenance, sanitization, and prompt-injection treatment.

## 7.4 Defer without implementation

Preserve only natural seams already justified by current code:

- stable Transcript IDs/source metadata;
- a future-neutral Transcript catalog;
- a research-evidence interface that can eventually reference a transcript excerpt;
- existing `SourceItem.transcript` support for public sources.

Do **not** implement:

- a Content Engine transcript picker;
- private transcript indexing for content;
- transcript-to-Outline generation;
- automatic use of meeting statements as a person’s public point of view;
- new transcript-specific adapters or settings.

That avoids speculative infrastructure while ensuring transcripts can return later without reviving Idea Engine’s feature-specific pipeline.

---

# 8. Meeting Wizard with two separate workflows

## 8.1 Shared Meeting Wizard Overview

The Overview should aggregate by Calendar occurrence without creating a combined Wizard record:

- Upcoming meeting and Brief state.
- Recently completed meeting.
- Transcript found/not found/needs association.
- Debrief not started/extracting/awaiting review/approved/expired.
- Links to Brief and Debrief siblings.

The shared linkage should be the Calendar occurrence identity plus explicit transcript association:

```text
MeetingOccurrence
  ├── Meeting Brief Run(s), prospective
  └── Transcript link → Executive Assistant Run(s), retrospective
```

## 8.2 Brief workflow

### Entry points

- automatic Calendar schedule;
- “Prepare now” from Overview or Brief;
- revision after material Calendar change.

### Steps

1. Calendar occurrence eligibility and schedule.
2. Snapshot current event.
3. Resolve attendees/Profile snapshots.
4. Gather relationship, workspace, CRM, public, and relevant prior-transcript evidence.
5. Compose structured Brief.
6. Display in app and deliver according to the chosen product policy.
7. Preserve revision history/cancellation state.

### Input and output

Input is a Calendar occurrence/version. Output is one structured `MeetingBriefRunResult`. Its lifecycle remains `snapshot → enrich → compose → deliver`.

## 8.3 Debrief workflow

### Entry points

- transcript automatically linked to a recent Calendar occurrence;
- user selects a recent meeting and attaches/chooses a transcript;
- unlinked transcript enters an association queue.

### Recommended stages

1. `associate` — identify the Calendar occurrence and participant roster.
2. `convert` — preserve normalized text and source metadata.
3. `mineIdentities` — create Transcript Mentions and match candidates.
4. `extractDebrief` — decisions, actions, open questions, summary, effectiveness evidence, coaching.
5. `review` — block for human approval; allow field regeneration and action-item removal.
6. `draft` — create the Gmail draft after approval.
7. `tasks` — create Google Tasks after the draft succeeds.

The exact stage names are a recommendation because no implementation exists. They follow ADR-0037/0038’s required behavior.

### Lifecycle

- The Run blocks at review rather than finishing and leaving a passive button.
- Regenerating a field is recorded as another Stage and reads the immutable transcript input, not the value being replaced.
- Regenerating action items clears prior drop decisions for that field.
- After 30 days without approval, the Run becomes `skipped`; the Debrief remains readable, but no Gmail draft or Tasks are created.
- Gmail draft precedes Google Tasks so a partial failure leaves a visible draft and retryable task stage, not orphaned tasks.

## 8.4 Shared services versus workflow-specific state

### Share

- Calendar occurrence identity and participant roster;
- Person Profile lookup/enrichment service;
- Transcript catalog and identity decisions;
- Google connection;
- Run engine and artifacts;
- LLM boundary;
- relevant historical relationship evidence;
- common meeting overview index.

### Keep workflow-specific

- Brief schedule, Calendar version, evidence snapshot, Brief result, and delivery.
- Debrief transcript version, extracted fields, regeneration history, dropped action items, review/expiry state, Gmail draft, and Tasks.
- Provider failures and retries.
- Profile revision snapshots used by each result.

A Brief should never become “step 1” of the Debrief Run, and a Debrief should not mutate a prior Brief. They are siblings connected by occurrence identity.

---

# 9. How Profiles, transcripts, and future Calendar meetings should enrich a Brief

Google Calendar future-meeting support is already live, not merely future work. The missing work is transcript discovery/name mining and stronger shared Profile resolution.

## 9.1 Recommended enrichment sequence

1. **Calendar reconciliation**
   - Receive opaque wake-up.
   - Fetch the primary Calendar.
   - Classify Eligible Meetings and create/replace the four-hour schedule.

2. **Freeze current event**
   - At due time, re-fetch and snapshot the exact occurrence/version.
   - Preserve title, time, organizer, attendees, location, conference link, and attachments.

3. **Resolve explicit attendees first**
   - Use Calendar email as the primary authoritative signal.
   - Add display name, source-system participant metadata, exact HubSpot contact, profile URL/handle, and employer hints.
   - Link confirmed profiles; queue ambiguous matches; create only safe email-anchored shell profiles.

4. **Discover related transcripts**
   - Query a shared Transcript catalog by:
     - exact `occurrenceKey`;
     - attendee Profile IDs/emails;
     - organization IDs/aliases;
     - meeting date/time;
     - source participant metadata.
   - Do not rely on unbounded Drive full-text search.
   - Current Drive enrichment only searches for the guest email and optionally company domain, then returns document names/links ([`google/drive.ts:112–140`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/google/drive.ts:112)); it does not parse those documents as relevant meeting transcripts.

5. **Mine identities from matched prior transcripts**
   - Reuse existing confirmed Transcript Mention decisions.
   - Run the identity pipeline only when missing or stale.
   - Separate attendees from non-attendee related people.

6. **Enrich canonical Profiles**
   - Refresh only profiles needed by the brief and only according to source freshness policy.
   - Snapshot exact revisions into the Run.
   - Do not block the entire brief on ambiguous non-attendee mentions.

7. **Build brief-specific relationship evidence**
   - Prior meeting summaries/quotes, Gmail, Calendar history, Drive documents, HubSpot, and public intelligence.
   - Keep transcript-derived claims attached to their quote/timestamp/transcript.
   - Related people who are not attendees belong in an explicit “Related people mentioned previously” section, not the guest list.

8. **Compose**
   - Produce attendee context, company context, conversation starters, related people, source references, missing evidence, and uncertainty.
   - Cite Profile revisions and transcript excerpts.

## 9.2 Failure and ambiguity behavior

| Condition | Recommended behavior |
| --- | --- |
| Calendar access unavailable before reconciliation | Keep already durable schedules and existing historical briefs. Do not create new automatic occurrences from stale assumptions. Show Calendar disconnected/degraded. |
| Calendar unavailable during required event snapshot | Fail or block that Brief Run at `snapshot`; do not fabricate current event truth. Permit a separate explicit manual-brief workflow only if the product chooses to support non-Calendar meetings. |
| Attendee email exists but no Profile exists | Create a minimal email-anchored profile or use an ephemeral attendee identity, then enrich. The brief continues with explicit gaps. |
| Attendee is unresolved because several Profiles match | Do not select one. Use the Calendar-provided name/email in the brief, record ambiguity, and place the candidates in Person Profiles → Review. |
| Profile enrichment source is unavailable | Continue with available evidence and mark the missing source. The current all-provider gate at [`enrich.ts:425–439`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/meeting-brief-generator/enrichment/enrich.ts:425) should be narrowed; unconfigured HubSpot should not erase Calendar/Profile/Drive context. |
| Transcript catalog has no relevant transcript | Continue without transcript enrichment and say no relevant transcript was found. |
| Transcript contains an ambiguous person | Preserve the mention and candidates; do not use it as a fact in the brief. |
| Transcript mentions a confirmed non-attendee | Include only in “Related people,” with why they are relevant and a transcript citation. Do not add them to `guests`. |
| Transcript mentions only an organization fragment or product | Keep it as an unresolved organization/product entity, not a Person candidate. |
| Conflicting evidence | Preserve both sources and surface uncertainty. Do not silently pick the newest or most convenient claim. |

## 9.3 Implied code and model changes

No implementation is requested, but this design implies:

- shared Transcript/Transcript Mention/Identity Decision models;
- Calendar occurrence and speaker metadata in transcript source context;
- a Transcript catalog/index;
- Profile candidate APIs and review persistence;
- name/employer/external-ID indexes in `PersonProfileStore`;
- `profileId`/revision references in Content Research `NamedPerson`;
- `profileId`/revision in Brief guest records;
- a related-person result section in `MeetingBrief`;
- structured transcript evidence references rather than only flat strings;
- one application-level Person Profile service;
- an optional transcript enrichment provider for Meeting Brief;
- provider-specific availability/gap handling instead of the present all-provider failure gate;
- migration off legacy Guest Profile routes/config.

---

# 10. Decisions that can be made now and genuinely unresolved questions

## 10.1 Decisions supported by repository evidence

1. **Use four top-level product areas:** Content Engine, Content Research, Person Profiles, and Meeting Wizard.
2. **Keep Person Profiles top-level and Workspace-owned.** This is already the explicit domain and ADR direction ([`ADR-0042`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0042-person-profiles-are-workspace-resources.md:1)).
3. **Keep Content Research a distinct capability and Module.** Its watchlist decisions, baselines, scheduled Runs, People Discovery, and Resonance Reports are different from Content Engine projects and Content Scout opportunities ([`ADR-0039`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0039-content-research-watches-named-people-and-is-its-own-module.md:1)).
4. **Group Brief and Debrief in Meeting Wizard but retain separate workflows and Runs.** The prospective/retrospective distinction is explicit in the domain model.
5. **Retire Idea Engine’s active transcript-derived Content Idea workflow for this iteration.** Preserve history and general transcript infrastructure.
6. **Do not remove Content Scout’s public YouTube transcript capability.** It is research evidence, not the private transcript feature being deferred.
7. **Generate platform outputs as siblings from one frozen brief.** Existing Content Scout architecture and tests strongly support this boundary.
8. **Introduce a new Outline contract.** Current Content Scout results are fixed finished drafts; current Idea Engine results are ideas. Neither exactly matches the requested selected-platform outline.
9. **Split profile lookup, candidate generation, enrichment, confirmation, and creation.** The current `resolve()` operation is too permissive for mined transcript names.
10. **Auto-link only with strong stable identifiers; review ambiguous names.**
11. **Add an explicit `profileId` link to Named Person without making Person Profile own the watch decision.**
12. **Preserve immutable historical Run and Profile revision snapshots.**
13. **Do not implement transcripts as a Content Engine source in v1.**
14. **Move shared research and Profile composition out of feature-local directories/composition roots.**
15. **Retain old routes as redirects and old Module IDs in historical Runs.**

## 10.2 Most important supporting evidence

- Person Profile is already defined as a reusable Workspace resource, not a meeting child.
- Meeting Brief already snapshots Profile revisions and has a mature Calendar/Run lifecycle.
- Content Research explicitly owns independent people-first Runs and per-person baselines.
- Content Research and Content Scout already prove that public research adapters can cross UI boundaries without sharing Runs.
- Content Scout proves the immutable shared-brief/independent-sibling-output pattern.
- Idea Engine’s implemented result is a Content Idea with an Expand Prompt, not a post.
- Meeting Debrief exists only in documentation, so there is no implementation debt requiring a UI-preserving “merge.”
- Current profile storage cannot safely resolve all name-plus-organization cases against existing records.
- Current transcript speaker attribution is insufficient for canonical identity decisions.

## 10.3 Ranked unresolved product questions

These cannot be answered from code and could materially change the design.

### P0 — Is the current 23-draft Content Pack/Notion workflow being retired, retained as an advanced mode, or kept alongside outlines?

The proposal clearly replaces transcript-derived content with an outline workflow, but it does not say whether Content Scout’s expensive, finished 23-target packs remain a supported output. This determines whether Content Engine Library must support two durable output types and whether Notion publishing remains active.

**Recommendation if no contrary decision is made:** make selected-platform outlines the primary v1 output; retain existing Content Packs as readable history and an explicitly labeled advanced/legacy capability until usage proves they should be removed.

### P0 — What private transcript corpus may be mined, with what consent and retention?

The repository currently watches one configured Drive folder and stores raw transcript text in Runs. “Mine all useful names” could mean:

- only newly ingested transcripts;
- all historical transcripts;
- only transcripts linked to Calendar;
- only user-selected transcripts;
- or every transcript in the folder.

That decision changes cost, privacy exposure, migration time, review-queue size, and whether automatic Profile proposals are acceptable.

**Recommendation if no contrary decision is made:** process new Calendar-linked transcripts automatically; backfill historical transcripts only through an explicit user-started bounded job with preview and deletion controls.

### P1 — Which platforms/formats are in Content Engine v1?

The existing list has 23 target contracts, including both concept and script variants. The questionnaire says “one or many platforms” but does not define the initial set or whether, for example, LinkedIn post, LinkedIn carousel, and LinkedIn article are one platform choice or three format choices.

This controls the target schema, UI, prompt contracts, test matrix, and cost.

### P1 — Should Meeting Brief continue automatic owner-only email delivery?

Current behavior sends the composed Brief to the connected owner after a quiet-period/current-truth check. The proposed Meeting Wizard could preserve that, switch to in-app-only, or introduce review. Debrief explicitly requires approval; Brief currently does not.

**Recommendation if no contrary decision is made:** preserve current Brief auto-delivery and make it visibly configurable later. Do not copy Debrief’s approval wait into Brief without a product decision.

### P1 — How should existing name-only Content Research watchers be linked to Profiles?

Current Named People have no `profileId`, and their source hints may not be sufficient to identify a unique Profile. A migration needs to decide whether to:

- auto-link exact handle/channel matches;
- show suggested links;
- or require every user to review the watchlist.

**Recommendation:** auto-link only exact stable identifiers and send all name-only records to the review queue. Preserve the Named Person ID and report history regardless of link outcome.

### P2 — Should manually created, non-Calendar meetings be supported?

Current Brief eligibility is Calendar-first, and the snapshot stage correctly refuses to invent current Calendar truth. Meeting Wizard may eventually need ad hoc meetings or uploaded transcripts without Calendar events, but the questionnaire does not require this.

**Recommendation:** do not add manual Briefs in the first consolidation. Allow unlinked transcripts in Debrief’s association queue without pretending they are Calendar occurrences.

---

# Anything else: contradictions, risks, migration, and opportunities

## Near-term blockers and risks

### 1. Canonical identity can be created too eagerly

`PersonProfileResolver.resolve()` accepts one name as sufficient input and creates a profile when no exact email/URL/handle match exists. That is acceptable for controlled calls only if policy is outside the resolver; it is unsafe for bulk transcript mining.

The new identity pipeline must not reuse `resolve()` indiscriminately.

### 2. Current stored-profile lookup and evidence matching disagree

Name-plus-employer is high confidence in evidence matching but cannot locate an existing stored profile. This is a concrete duplicate/overwrite risk, not merely a UX gap.

### 3. Content Research’s Profile relationship is documented but absent

[`CONTEXT.md:319–323`](/Users/Nicolas/Documents/github/chief-of-staff-demo/CONTEXT.md:319) says Named People may reference Profiles, but [`NamedPerson`](/Users/Nicolas/Documents/github/chief-of-staff-demo/packages/shared/src/content-research.ts:20) has no such field. Consolidation should not assume this integration already exists.

### 4. Meeting Brief currently fails when any required enrichment class is unavailable

The implementation treats Gmail, Calendar history, Drive, Person Profile, HubSpot, and public intelligence as a required set for external attendees. That is inconsistent with a robust fallback design where the Brief continues with explicit gaps. Calendar event truth can remain required; most enrichment sources should degrade independently.

### 5. Idea Engine attribution is not safe for identity reuse

The code explicitly trusts the LLM’s high-confidence attribution for multi-speaker content ideas. This may be tolerable for an idea suggestion but is not tolerable for profile matching, action-item ownership, or “write from this person’s point of view.”

### 6. Historical Run migration needs an explicit retirement state

Removing `IdeaEngineHost` from the hosted-module array means old Runs remain readable but generic retry returns “module not hosted.” The user should see “retired workflow,” not an unexplained retry failure.

### 7. Legacy Guest Profile debt remains

Old settings schema and `/api/meeting-brief/guest-profile/*` routes coexist with Workspace Person Profiles. Leaving both through the IA migration will confuse ownership and increase the chance of two profile sources diverging.

## Security and privacy

- The application is explicitly local-first, single-user, and unauthenticated. [`ADR-0001`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0001-local-first-single-user.md:1) requires authentication and user/workspace isolation before shared hosting. Person Profiles and transcript mining materially increase the sensitivity of local data.
- Raw transcripts, participant emails, Calendar metadata, Gmail evidence, HubSpot records, public-web evidence, and profile revisions are all sensitive. A Person Profiles launch should include delete/export, evidence removal, retention visibility, and transcript-backfill controls.
- Public Profile searches place names/emails/employer combinations into an external search query. This should be disclosed, bounded, and recorded in source diagnostics.
- The existing prohibition on authenticated scraping, imported browser sessions, CAPTCHA bypass, and control evasion should remain. It is documented in [`ADR-0042:11–15`](/Users/Nicolas/Documents/github/chief-of-staff-demo/docs/adr/0042-person-profiles-are-workspace-resources.md:11).
- Content Research intentionally does not honor `robots.txt`, according to ADR-0039. That is a recorded product decision, but it remains a reputational/terms-of-service risk and should not silently expand into Profile enrichment or private-session collection.
- Transcript and public-source text must continue to be treated as untrusted prompt input. Content Scout already instructs the model not to follow embedded source/transcript instructions in [`content-scout/model.ts:143`](/Users/Nicolas/Documents/github/chief-of-staff-demo/apps/server/src/modules/content-scout/model.ts:143).

## Longer-term opportunities

- A confirmed Person Profile can become the stable subject key for Content Research, Content Engine, meeting preparation, outreach, and future CRM synchronization.
- A shared Transcript catalog eliminates repeated download/conversion without merging downstream Runs.
- Confirmed transcript aliases and speaker mappings can improve future Debrief action ownership and Profile matching over time.
- Existing Profile publications/feeds can seed Content Research targets after explicit watch-list approval.
- Content Research reports can become reusable evidence packages for Content Engine without making Content Engine wait for or own the watch workflow.
- Meeting Wizard Overview can expose a coherent lifecycle while retaining strict prospective/retrospective state boundaries.

## Verification and repository state

I ran the repository’s representative narrow test gate across:

- Person Profile;
- Content Research;
- Content Scout;
- Idea Engine;
- Meeting Brief Generator;
- Meeting Brief Calendar Intake;
- transcript pipeline;
- Drive Intake;
- YouTube Trends.

Result: **9 test files passed, 171 tests passed**.

No source or documentation files were modified. The only `git status` entry remains the pre-existing untracked questionnaire itself: