# Content Engine, Person Profiles, Content Research, and Meeting Wizard consolidation

**Status:** Approved product specification; ready to be decomposed into implementation work after publication.

**Evidence base:** This specification synthesizes the completed [repository investigation](../../questionnaire-answers.md), the [original discovery questionnaire](../../to-questionnaire-content-and-meeting-workflows.md), the repository glossary, and the accepted ADRs. The investigation remains the authoritative record of observed current behavior. This specification defines approved future behavior and does not repeat the code-level inventory.

## Status legend

- **Observed current behavior** describes what exists at commit `a89269e` before this specification is implemented.
- **Approved future behavior** is binding scope for the first release described here.
- **Deferred** is explicitly excluded from the first release and must not be smuggled into implementation.
- **Retired** means the workflow and its local product data do not survive the cutover.

## Problem Statement

The application exposes content creation, content research, person intelligence, transcript processing, and meeting preparation as separate tabs whose product labels do not match their real capability boundaries. Person Profiles already contain the beginnings of a Workspace-owned identity model, but they have no complete application surface and are composed inside Meeting Brief. Content Research watches module-local Named People rather than requiring canonical Profiles. Content Scout discovers useful opportunities but terminates in an expensive fixed 23-draft Content Pack and Notion workflow. Idea Engine separately mines private transcripts into Content Ideas. Meeting Brief is mature, while Meeting Debrief exists only as an accepted domain design.

The workspace owner wants one coherent product organized around four independently understandable areas:

- Content Engine creates evidence-backed platform outlines and, on request, one finished Draft at a time.
- Content Research monitors confirmed people and reports resonance without owning their identity.
- Person Profiles owns canonical, evidence-backed identity and review across every consumer.
- Meeting Wizard presents prospective Brief and retrospective Debrief as sibling workflows without merging their Runs or lifecycle state.

The reorganization must also safely mine every transcript in the configured Drive folder for people and organizations. A plausible name must never silently become a canonical identity. Private evidence must not leak into public content. The application is not yet available to other users, so backward compatibility and local history migration provide no value: the cutover will delete all local product state while preserving authentication.

## Solution

Ship one gated, clean-slate release with four top-level product areas and a small set of deep shared interfaces:

1. A Workspace Person Profile interface owns candidate search, confirmation, enrichment, revisioning, merge, correction, archive, and privacy deletion. Consumers reference Profile IDs and exact revisions; they do not own identity.
2. A shared Transcript Catalog interface owns Drive-folder inventory, immutable transcript artifacts, Calendar association, Transcript Mentions, Organization Mentions, match candidates, review decisions, processing ledgers, retention, and deletion cascades.
3. A Content Project interface owns author intent, Brand Voice, research mode, frozen evidence, approved Outline Brief revisions, independent Platform Outline versions, and individually requested Draft versions.
4. Meeting Wizard aggregates Calendar occurrences, Brief Runs, Transcript associations, and Executive Assistant Runs for navigation while Brief and Debrief retain separate state machines and outputs.
5. Shared public research keeps Source Adapters independent. Content Opportunity discovery, scheduled Content Research, and bounded project Research Requests reuse the same normalized Source Item seam without sharing Runs or lifecycle state.

The first release is outline-first, not outline-only. All selected targets generate independent outlines from one approved immutable Outline Brief. A user may then generate or regenerate a finished Draft for one target at a time. Content Engine does not edit, publish, schedule, or track publication.

The release includes full-folder transcript mining, the Person Profiles Review queue, transcript-enriched Meeting Briefs, and Meeting Debrief. These are release requirements, not later enhancements. The destructive auth-preserving reset happens only after the complete first-release acceptance gate passes.

## User Stories

### Navigation and onboarding

1. As the workspace owner, I want four product areas named Content Engine, Content Research, Person Profiles, and Meeting Wizard, so that navigation reflects ownership rather than backend Module registration.
4. As the workspace owner, I want an explicit migration inventory before local state is destroyed, so that I understand the cutover boundary.
6. As the workspace owner, I want all provider authentication preserved while every other product datum and setting is removed, so that I can start clean without recreating credentials.
9. As the workspace owner, I want to confirm my canonical owner Profile from the preserved Google identity during onboarding, so that author identity has one canonical home.
10. As the workspace owner, I want to create and approve a Brand Voice before generating content, so that every output has reproducible positioning and constraints.

### Content Engine

12. As an authorized author, I want to start a Content Project from a freeform Topic, a Content Opportunity, or a Person Profile, so that different discovery paths converge on one creation workflow.
14. As the workspace owner, I want only the owner and explicitly authorized Person Profiles to be selectable as authors, so that a discovered person cannot be impersonated.
15. As an authorized author, I want a manually approved Content Voice overlay combined with Workspace Brand Voice, so that individual perspective remains explicit and consumer-specific.
17. As an authorized author, I want to choose no external research, existing Workspace evidence, or fresh bounded research, so that cost and evidence scope are deliberate.
19. As an authorized author, I want to review, include, exclude, and freeze sources before generation, so that every claim has a reproducible evidence basis.
20. As an authorized author, I want fresh person research to use all available identifiers automatically when useful, including email addresses, so that recall is prioritized under the accepted privacy policy.
22. As an authorized author, I want Content Engine to receive only a public-safe Person Profile projection, so that private email, Calendar, Drive, CRM, meeting, and transcript evidence cannot leak into public content.
23. As an authorized author, I want one Content Opportunity to seed one Project, so that the central angle remains coherent.
25. As an authorized author, I want a required approved Outline Brief containing subject, author, audience, objective, thesis, angle, claims, evidence map, CTA intent, Brand Voice revision, and targets, so that bad framing is caught before platform generation.
26. As an authorized author, I want all selected Platform Outlines generated independently and concurrently after approval, so that each target receives the same evidence without inheriting a sibling's framing or mistakes.
28. As an authorized author, I want platform choices for LinkedIn Standard Post, LinkedIn Carousel, LinkedIn Long-form Article, Website Blog Article, Email Newsletter, YouTube Short, YouTube Long-form Video, Instagram Reel, and TikTok Video, so that v1 has a bounded and meaningful target contract.
29. As an authorized author, I want every Platform Outline to include title, hook direction, thesis, ordered beats, evidence per beat, examples, CTA intent, target length or duration, constraints, warnings, and production notes, so that it is useful before prose generation.
30. As an authorized author, I want to request a new immutable Outline version with a bounded instruction, so that I can steer the structure without an in-app editor.
32. As an authorized author, I want to generate a finished Draft for one target at a time, so that optional drafting does not become another bulk Content Pack.
38. As the workspace owner, I want no standalone Idea inbox or transcript-to-idea path, so that the retired Idea Engine does not return under a new label.

### Content Opportunities and Content Research

39. As the workspace owner, I want approved Source Targets to continue recurring collection and Source Discovery, so that useful opportunity discovery survives removal of Content Packs.
41. As the workspace owner, I want selecting a Content Opportunity to start a normal Content Project, so that opportunity discovery and content creation meet at a deliberate seam.
42. As the workspace owner, I want Content Research to remain a distinct top-level workflow, so that scheduled monitoring and Resonance Reports are not reduced to a generation helper.
43. As the workspace owner, I want every Named Person watch to require a confirmed Person Profile, so that name-only identity drift cannot reappear after the reset.

### Person Profiles and identity review

47. As the workspace owner, I want a searchable Profile list and detailed evidence view, so that canonical identity is independently discoverable.
50. As the workspace owner, I want transcript candidates in one Review queue, so that ambiguous identities do not become silent facts.
51. As the workspace owner, I want to confirm a candidate, choose another Profile, create a Profile, mark not-a-person, or leave a person unresolved, so that review preserves ambiguity honestly.
53. As the workspace owner, I want exact non-conflicting identifiers to auto-link mentions to existing Profiles, so that obvious matches do not require clerical review.
54. As the workspace owner, I want transcript mining never to auto-create a Profile, so that a full-folder scan cannot silently expand the canonical identity collection.
55. As the workspace owner, I want Calendar to create a minimal email-anchored shell Profile for any unknown attendee, so that automatic Briefs can use one canonical identity model.
56. As the workspace owner, I want to merge duplicate Profiles and detach or split wrongly attached evidence, so that identity errors are repairable.
59. As the workspace owner, I want reversible archive and separately confirmed privacy deletion, so that ordinary cleanup does not require destructive erasure.

### Transcript Catalog and identity mining

62. As the workspace owner, I want a first-run inventory of the configured Transcripts Drive folder, so that I can see count, date range, provider exposure, and scope before processing.
63. As the workspace owner, I want one explicit confirmation to authorize full historical backfill and continuous future mining, so that consent is informed without becoming per-file busywork.
64. As the workspace owner, I want every current folder transcript mined after I invoke the first run, so that historical people and organization context become available.
65. As the workspace owner, I want every later unprocessed transcript mined automatically, so that the catalog remains current.
71. As the workspace owner, I want unresolved people displayed as unresolved evidence in Meeting Wizard but excluded from factual synthesis, so that useful names remain visible without becoming claims.
73. As the workspace owner, I want transcript deletion to cascade through local excerpts, mentions, candidates, decisions, Debriefs, and transcript-origin Person Evidence, so that deletion is meaningful.

### Meeting Wizard and Meeting Brief

78. As the workspace owner, I want automatic Briefs for every eligible internal or external meeting, so that preparation is not limited to External Guests.
79. As the workspace owner, I want eligibility to require a timed, non-cancelled event, owner participation, and at least one other non-declined attendee, so that focus blocks and all-day holds do not trigger Briefs.
81. As the workspace owner, I want internal attendees enriched from Workspace-owned evidence and external attendees enriched from the full configured bundle, so that colleague privacy and external preparation have appropriate scopes.
82. As the workspace owner, I want every provider selected for an attendee-class bundle to succeed, so that a Brief is not presented as complete when configured evidence is missing.
85. As the workspace owner, I want prior transcripts with confirmed person, organization, or meeting-series links eligible automatically, so that relationship history can enrich preparation.
86. As the workspace owner, I want semantic discovery across the full transcript corpus, so that relevant conversations can be found even without an existing link.
87. As the workspace owner, I want unlinked semantic discoveries to require relevance confirmation before they affect factual Brief synthesis, so that similarity cannot leak an unrelated confidential conversation.

### Meeting Debrief

90. As the workspace owner, I want every mined transcript to start a Meeting Debrief, so that historical and unlinked conversations receive retrospective processing.
91. As the workspace owner, I want every Debrief to extract decisions, action items with inferred owners and optional due dates, open questions, summary, effectiveness evidence, and coaching advice, so that the result is operational and reflective.
93. As the workspace owner, I want approval blocked until every attendee has a confirmed Person Profile and verified email, so that attendee-facing drafts cannot be misaddressed.
96. As the workspace owner, I want every Debrief to wait for approval before any outward write, so that historical backfill cannot create surprise email drafts or Tasks.
98. As the workspace owner, I want every approved Debrief to create an attendee-facing Gmail draft, so that approved follow-up is ready to send manually.
99. As the workspace owner, I want confirmed attendees other than the owner included automatically as recipients, so that the follow-up reaches the meeting participants.
100. As the workspace owner, I want the model to suggest non-attendee recipients but require my confirmation of a Profile with verified email, so that meeting information is not disclosed merely because someone was mentioned.
101. As the workspace owner, I want the Gmail draft to include only summary, decisions, retained actions, open questions, and next steps, so that private coaching and diagnostics remain in Meeting Wizard.
103. As the workspace owner, I want Google Tasks created only for actions confidently assigned to me, so that other people's commitments do not become my responsibilities.
104. As the workspace owner, I want approval to lock the Debrief, roster, recipients, and review decisions, so that one local result remains aligned with one draft and one set of Task receipts.

## Confirmed Scope

### First-release scope

- Four product areas and exact routes described below.
- One-time auth-preserving, product-state-destroying Workspace reset.
- Content Engine with required Brand Voice, authorized authors, research modes, source review, approved Outline Brief, nine target contracts, independent outline generation, and optional individual Draft generation.
- Recurring Content Opportunity discovery without Content Pack generation or Notion publication.
- Content Research with Profile-backed watches, reports, schedules, Sheets ledger, and owner Gmail draft.
- YouTube Trends under Content Research with a clean new spreadsheet.
- Person Profiles list, detail, manual creation, Review queue, revisions, merge, split/detach, correction, archive, privacy deletion, consumer links, and public-safe projections.
- Full-folder transcript cataloging, historical backfill, continuous mining, person/organization extraction, candidate matching, review, retention, and deletion controls.
- Meeting Wizard Overview, expanded Calendar-backed Brief, automatic owner-only delivery, full-corpus transcript discovery, and separate Meeting Debrief with approval-gated Gmail/Tasks outputs.

## Out of Scope

- The fixed 23-output Content Pack, Content Draft Target contract, Content Pack retries, and Notion publication.
- Idea Engine, transcript-derived Content Ideas, Expand Prompts, and private-transcript content sources.
- Direct Content Engine publication, scheduling, analytics, publication records, or platform connections.
- In-app character-level Outline, Draft, or Debrief editing.
- Bulk Draft generation across selected Content Engine targets.
- Manual or non-Calendar Meeting Briefs.
- A canonical Organization Profiles product.
- CRM-style Profile notes, relationship stages, outreach history, tags, tasks, synchronization, or messaging. These are a later direction only.
- Public-writing-style inference or automatic impersonation from Person Evidence.
- Authenticated scraping, imported browser sessions, CAPTCHA bypass, or control evasion.
- Shared hosting, application login, or multi-user isolation. The accepted local-first trust boundary remains.
- Backward-compatible legacy product routes, old local Runs, old indexes, or old destination configuration.

### Deferred direction, not committed work

- Direct publishing and scheduling from Content Engine.
- CRM/outreach capabilities around Person Profiles.
- Private transcripts as selectable Content Engine research sources.
- A canonical Organization Profile resource.
- Additional Content Engine targets, including Reddit, Substack, X, Threads, and Bluesky.

## Information Architecture

| Area | Route | Landing state | Internal routes |
| --- | --- | --- | --- |
| Content Engine | `/content` | Create | `/content/opportunities`, `/content/library`, `/content/sources`, `/content/brand` |
| Content Research | `/content-research` | People | `/content-research/reports`, `/content-research/trends` |
| Person Profiles | `/people` | Profiles | `/people/review`, `/people/new`, `/people/:profileId` |
| Meeting Wizard | `/meetings` | Overview | `/meetings/brief`, `/meetings/brief/:occurrenceKey`, `/meetings/debrief`, `/meetings/debrief/:runId` |
| Settings | `/settings` | Existing Shell settings | `/settings/content`, `/settings/content-research`, `/settings/people`, `/settings/meetings` |

Home remains `/`. Runs remain `/runs` and `/runs/:id` for post-cutover work. Legacy `/content-scout`, `/idea-engine`, `/youtube`, `/meeting-brief`, and `/transcript` routes are removed and return the normal not-found state. There are no redirects or retirement pages.

Product navigation must not be mechanically derived from the hosted Module registry. A product area may aggregate several Modules, while a Module may remain live without a top-level product tab.

## Terminology

- **Brand Voice:** the Content Engine user-facing label for the canonical versioned Brand Profile; it does not create a second brand resource.
- **Content Project:** durable creation work with one subject, authorized author, input revisions, and generated artifacts.
- **Authorized Author:** the owner or a confirmed Person Profile explicitly permitted by Workspace policy to supply an authorial point of view.
- **Content Voice:** manually approved author-specific writing guidance combined with Workspace Brand Voice; it is not Person Evidence.
- **Outline Brief:** the immutable, approved shared input for independent Platform Outline generations in one Project revision.
- **Outline Set:** the sibling Platform Outlines produced from one approved Outline Brief.
- **Platform Outline:** one versioned platform/format-specific plan. It is not publishable copy.
- **Draft:** one optional, immutable finished-copy or finished-script version generated from one approved Platform Outline. It is not a publication record.
- **Transcript:** one immutable normalized local source artifact plus source and meeting metadata registered in the Workspace Transcript Catalog.
- **Transcript Mention:** one preserved source span classified as a possible person or other entity; it is evidence, not identity.
- **Organization Mention:** one preserved organization span and its normalized identifiers or aliases; it does not create an Organization Profile.
- **Identity Decision:** the durable, auditable resolution of a Transcript Mention to a Profile, rejection, or unresolved state.
- **Meeting Wizard:** the product area that aggregates meeting navigation while Brief and Debrief remain sibling workflows.

## Capability and Ownership Boundaries

| Capability | Owns | Consumes | Must not own |
| --- | --- | --- | --- |
| Content Engine | Content Projects, author policy, Content Voice, Project revisions, Outline Briefs, Outline Sets, Drafts | public-safe Profile projection, Brand Voice, Research Requests, Opportunities, Source Items | canonical identity, watch decisions, transcript intake, meeting state, publication state |
| Content Research | Named Person watch decisions, schedules, baselines, Reports, Suggestions | confirmed Profile ID/revision, public Source Adapters, Brand Voice context | canonical Profile facts, Content Project state, meeting state |
| Person Profiles | canonical Profile ID, identity signals, evidence, provenance, confidence, revisions, candidate review, merge/correction/deletion | Calendar, HubSpot, public search, manual input, confirmed transcript evidence | content angles, author voice, watch state, meeting talking points, action items |
| Transcript Catalog | transcript registration, immutable artifacts, source/occurrence links, mentions, organizations, candidates, identity decisions, ledgers, retention/deletion | Drive source, Calendar/source participants, Person Profile candidate interface | Debrief fields, Brief composition, content generation, canonical Profile creation policy |
| Meeting Brief | Calendar eligibility/schedule, occurrence snapshot, evidence snapshot, Brief revisions, owner delivery | Profiles, Gmail, Calendar, Drive, CRM, public research, confirmed transcripts | canonical identity, transcript decisions, retrospective actions |
| Meeting Debrief | transcript association, structured Debrief, review, expiry, recipients, Gmail draft, owner Tasks | Transcript, occurrence/roster, Profile snapshots | prospective Brief state, canonical identity guesses, pre-approval outward writes |
| Shared public research | Source Adapter and Source Item interfaces, bounded collection, diagnostics | approved targets or bounded queries | consumer-specific Runs, reports, opportunities, Projects, Profiles |
| Shell | Runs, Stages, artifacts, retry/recovery, credential custody, generic settings/status | Module interfaces | product result shapes, identity decisions, content or meeting policy |

### Deep interfaces

Implementation must prefer a small number of deep interfaces whose observable behavior is also the test surface:

1. **Person Profiles interface:** search candidates; retrieve current or exact revision; confirm/create; enrich; merge; detach/correct; archive/delete; return consumer-specific projections. Matching algorithms, indexes, provenance, revision writes, and deletion invalidation stay behind the interface.
2. **Transcript Catalog interface:** inventory/authorize folder; register/process source; associate occurrence/roster; list review work; decide mention/relevance; retrieve bounded evidence; pause/resume; delete with cascade. Conversion, deduplication, extraction, scoring, indexing, semantic retrieval, tombstones, and processing ledgers stay behind it.
3. **Content Project interface:** create/revise intent; attach/freeze evidence; propose/approve Outline Brief; generate/retry outlines; approve/regenerate outline; generate/regenerate/export Draft. Research orchestration, artifact lineage, bounded concurrency, target prompts, and missing-only retry stay behind it.
4. **Meeting Wizard read interface:** project Calendar occurrence, Brief, Transcript, and Debrief state into Overview without creating a combined lifecycle record.

External providers are true-external seams and use injected adapters. Tests use fake adapters. Shared logic must not expose provider-specific request shapes to product callers.

## Content Engine Workflow and Contracts

### Project inputs

Required before Outline Brief generation:

- subject statement;
- authorized author, defaulting to the confirmed owner Profile;
- objective: educate, provoke discussion, establish authority, drive a specific action, or custom;
- intended audience, optionally prefilled from Brand Voice but explicitly confirmed;
- approved Brand Voice revision;
- research mode;
- reviewed frozen evidence, or explicit no-external-research acknowledgement;
- at least one target.

Optional inputs:

- subject Profile snapshot;
- one source Content Opportunity;
- seed notes, user-supplied claims, or source URLs;
- CTA intent;
- timing/event context;
- constraints and exclusions.

### Research modes

1. **No external research:** use user input and explicitly mark unsupported or author-supplied claims.
2. **Existing Workspace evidence:** use selected Opportunities, Reports, Source Items, and public-safe Profile evidence without new queries.
3. **Fresh bounded research:** start a finite Research Request, show all configured-provider failures, and require user approval of the actual returned evidence before freezing it.

Fresh project research never creates or activates a Named Person watch. A separate explicit action may open Content Research to create one.

Public person research may automatically send any available identifier, including email, to anonymous public-search providers when useful. Diagnostics must persist identifier class, provider, timestamp, and purpose. Content Engine still receives only the public-safe result projection; private input evidence and search diagnostics do not enter prompts as content claims.

### Target catalog

| Target ID | Platform | Format | Outline result | Optional Draft result |
| --- | --- | --- | --- | --- |
| `linkedin-standard-post` | LinkedIn | Standard Post | hook/argument/evidence/CTA plan | finished post copy |
| `linkedin-carousel` | LinkedIn | Carousel | cover and slide-beat plan | finished slide copy |
| `linkedin-long-article` | LinkedIn | Long-form Article | section/evidence plan | finished article copy |
| `website-blog-article` | Website | Blog Article | headline/section/SEO evidence plan | finished article copy |
| `email-newsletter` | Email | Newsletter | subject/opening/section/CTA plan | finished newsletter copy |
| `youtube-short` | YouTube | Short | hook/visual beats/payoff plan | record-ready short script |
| `youtube-long-video` | YouTube | Long-form Video | cold open/chapter/visual plan | record-ready long script |
| `instagram-reel` | Instagram | Reel | pattern interrupt/visual beats/payoff plan | record-ready Reel script |
| `tiktok-video` | TikTok | Video | immediate hook/rapid proof/payoff plan | record-ready TikTok script |

Target contracts are versioned. “Concept” and “script” are no longer separate video targets: Outline and Draft are lifecycle artifacts of one target.

### Generation and revision rules

1. Evidence selection freezes exact Source Items, Profile projection revision, Brand Voice revision, and user-supplied material.
2. Outline Brief proposal is immutable. Regeneration appends a version.
3. Only an approved Outline Brief generates Platform Outlines.
4. All selected outlines start concurrently within a bound and are independent siblings.
5. Partial success is retained; retry creates only missing/failed targets.
6. Outline regeneration accepts bounded instructions and appends a version. Direct editing is unavailable.
7. One approved Outline version may generate one or more immutable Draft versions over time, but Draft generation is invoked for one target at a time.
8. Draft regeneration accepts bounded prose instructions but cannot alter approved thesis, evidence, or unsupported-claim policy.
9. Any Project input/evidence/target change creates a new Project revision and approval sequence. Prior artifacts remain exact.
10. Copy and Markdown download are required user exports. Structured JSON remains available through the product interface for application rendering and tests; it need not be promoted as the primary user download.
11. Content Engine owns no publication status and performs no outward write.

## Content Opportunities and Content Research

### Opportunity discovery

Retain recurring Source Target collection, Source Discovery, adapter diagnostics, opportunity ranking, shortlist decisions, dismissal/cooldown state, and evidence. Remove every terminal path that creates a Content Pack or Notion page. Selecting one Opportunity starts one Content Project and records the relationship; it does not bypass Project inputs, evidence review, or Outline Brief approval.

Public Source Adapters remain independent under ADR-0028. Successful Source Items survive another adapter's failure. Strict all-provider completeness applies only to a bounded provider bundle explicitly selected for a Project or enrichment request, not to recurring multi-adapter collection.

### Content Research

- Every Named Person requires a confirmed `profileId` and pins the revision used by each Run.
- Watch configuration, source hints, schedules, baselines, reports, and Suggestions remain Content Research-owned.
- Accepting a Person Suggestion must select or create/confirm a Profile before creating the watch.
- Content Research consumes a public-safe Profile projection.
- Sheets ledger and owner-only Gmail report draft remain active outputs.
- YouTube Trends is presented at `/content-research/trends` and keeps an independent measurement Run and spreadsheet output.
- Post-reset onboarding requires clean new Sheets; old remote outputs are neither cleared nor reconciled.

## Person Profiles

### Required surface

- searchable list with archive state;
- detail with signals, claims, sites, publications, evidence, provenance, confidence, diagnostics, revisions, author authorization, and consumer references;
- manual creation;
- Review queue for mentions, ambiguous candidates, merge suggestions, disputed evidence, and semantic transcript relevance;
- confirm, choose another, create Profile, not-a-person, unresolved, and scoped remember-mapping decisions;
- merge Profiles;
- detach/split evidence and invalidate wrong links;
- factual correction through a new revision;
- archive and privacy delete;
- public-safe and meeting-appropriate consumer projections.

### Creation and matching policy

- Calendar may create a minimal shell Profile for any unknown internal or external attendee because exact Calendar email is an authoritative anchor.
- The owner Profile is proposed from preserved Google identity but requires explicit confirmation during onboarding.
- Transcript mining may auto-link only to an existing Profile through a non-conflicting stable identifier: exact email, canonical profile URL, verified handle, external contact ID, or source-speaker-to-Calendar-email mapping.
- Transcript mining never creates a new Profile automatically, even when it observes a stable identifier.
- Name-only and name-plus-organization matches require review.
- A review confirmation applies only to that mention unless the user explicitly stores a scoped reusable mapping.
- Author authorization and Content Voice are Workspace/Content Engine policy, not Person Evidence.

### Correction, archive, and deletion

- Factual correction appends a Profile revision. Historical snapshots remain readable and show that a newer revision supersedes claims.
- Wrong-person correction detaches evidence and invalidates affected consumer links/claims. Historical artifacts remain audit records but cannot present invalidated facts as current.
- Archive is reversible and stops new selection/consumption. Active dependent configuration, such as a Named Person watch, must be paused or re-pointed explicitly.
- Privacy deletion removes canonical Profile data, revisions, evidence, aliases, candidates, learned mappings, structured identity decisions, active consumer links, and person-specific derived snapshots. It leaves a content-free tombstone for reference integrity.
- Privacy deletion does not rewrite immutable transcript or public source text. The confirmation surface lists residual source artifacts and offers separate source deletion where supported.
- Remote provider data is never deleted by a local Profile deletion.

## Transcript Catalog, Mining, and Identity Decisions

### Corpus, consent, and processing

- V1 supports one configured Google Drive Transcripts folder.
- The first mining operation is user-invoked and begins with an inventory preview: folder identity, file count, date range, estimated scope, local retention, configured model/provider exposure, and external-query behavior.
- Confirmation establishes standing folder-level consent for the full historical backfill and automatic processing of every future unprocessed file.
- The first-run ledger is independent of deleted pre-cutover checkpoints. It processes every current folder file exactly once.
- Processing is resumable, pausable, retryable, checksummed, and idempotent. Pausing stops new mining but preserves the catalog and completed decisions.
- Every mined transcript starts a Meeting Debrief, whether Calendar-linked or not.

### Transcript record

Each Transcript retains:

- stable Transcript ID;
- source system, external file ID, URL, checksum, and observed revision;
- immutable normalized-text artifact;
- ingestion and extractor versions;
- meeting date/time when known;
- Calendar event/occurrence identity when confirmed;
- organizer and attendee candidates;
- source-system participants and speaker metadata;
- diarization/speaker labels and any speaker-to-email mapping;
- processing and deletion state.

### Extraction and normalization

Preserve original quote/span/timestamp/speaker label while deriving Unicode-, whitespace-, punctuation-, email-, URL-, handle-, honorific-, credential-, and organization-normalized comparison forms. Deterministic recognition supplements a strict model Result Shape. Extraction retains people named in organization context, non-attendees, organizations without people, titles, roles, aliases, relationship assertions, ambiguous single names, products, and unknown entities. It must not coerce every proper noun into a person.

### Candidate generation and policy

Candidate retrieval uses exact identifiers, speaker/Calendar mapping, known aliases, normalized full names, organizations, titles, roster context, and prior explicitly remembered mappings. Every candidate persists a signal-by-signal score explanation, conflicts, lead over the second candidate, algorithm version, and evidence.

Policy classes:

- **Confirmed:** a non-conflicting stable identifier may auto-link to an existing Profile.
- **Probable:** suggested match requiring review.
- **Ambiguous:** no link; retain all plausible candidates.
- **Rejected/not a person:** retain classification and reason without promoting it to identity.

Exact numeric thresholds are implementation-tunable policy data. Tests assert classifications at representative boundaries and hard-conflict behavior rather than a particular scoring implementation unless a threshold is part of the versioned policy.

### Unresolved and organization behavior

- Meeting Wizard may show unresolved surface text, organization context, source meeting/date, and a Review link.
- Unresolved mentions cannot become attendees, confirmed Related People, action owners, recipient Profiles, or factual talking points.
- Organization Mentions retain spans, normalized name, aliases, domains, external company IDs, person relationships, confidence, provenance, and merge decisions.
- V1 has no top-level Organization Profiles UI. Organization review is scoped to identity review and meeting evidence.

### Retention and deletion

- Full normalized text is retained until explicit local transcript deletion.
- Transcript deletion removes local full text, quotes, mentions, candidates, identity and relevance decisions, transcript-derived Debriefs, and transcript-origin Person Evidence, including sensitive copies in revisions where necessary.
- Independently supported Profile facts survive.
- A content-free tombstone containing source identity/checksum, deletion time, and do-not-reingest policy survives.
- The remote Drive source, Gmail drafts, Tasks, and other provider records remain untouched.

## Meeting Wizard

### Overview

Overview is a read projection keyed by Calendar occurrence when available. It shows upcoming eligible meetings, Brief schedule/readiness/revisions/delivery, recently completed meetings, Transcript association/mining state, and Debrief extraction/review/expiry/output state. It links sibling records; it does not own one combined meeting state machine.

### Meeting Brief

#### Eligibility and entry points

- timed Calendar event;
- not cancelled;
- owner has not declined;
- at least one other attendee has not declined;
- all-day and owner-only events excluded;
- internal and external meetings both eligible;
- automatic schedule and explicit “Prepare now” entry points;
- no manual/non-Calendar Briefs.

#### Attendee identity and provider bundles

Every attendee resolves to an existing Profile or an email-anchored Calendar shell Profile. Internal and external attendee classification uses configured Internal Domains.

- Internal bundle: Person Profile, Calendar history, Gmail relationship evidence, Drive Workspace evidence, confirmed transcripts, and locally held organization context. Anonymous public search, HubSpot, company news, and industry news are not selected by default.
- External bundle: full explicitly enabled Profile, Gmail, Calendar, Drive, CRM, public person/company, organization, and transcript enrichment.

Every provider selected in the applicable bundle is required. Successful artifacts survive for retry, but no partial Brief is composed or delivered. Retry uses bounded backoff until 30 minutes before start. At cutoff, the Run fails visibly and sends nothing. The user may repair or disable a provider and explicitly retry; policy never relaxes silently.

#### Transcript retrieval

Two lanes search all retained history:

1. Confirmed person, organization, or meeting-series linkage creates automatically eligible candidates.
2. Global semantic discovery uses meeting title, purpose, attendees, organizations, and topics. Unlinked results are suggestions only and require explicit relevance confirmation.

Retrieval ranks relationship strength, meeting relevance, and recency and passes a bounded cited excerpt set into composition. Pending suggestions never block scheduled generation. Confirming one later offers an explicit regeneration action; the resulting new Brief revision is automatically emailed because the user deliberately requested it.

#### Output and delivery

Brief preserves structured attendee/company/organization context, relationship history, conversation starters, Related People, citations, missing evidence, and uncertainty. Confirmed non-attendees may appear under Related People. Unresolved mentions appear only as unresolved review notices.

After current-truth and quiet-period checks, a successful Brief is available in-app and automatically emailed only to the connected owner. Gmail delivery failure does not erase the composed result and is retryable, but no external attendee ever receives a Brief.

### Meeting Debrief

#### Entry and stages

Every mined Transcript starts an Executive Assistant Run. Calendar-linked transcripts prefill occurrence and roster; unlinked transcripts require manual roster confirmation.

Recommended stages are:

1. `associate` — occurrence, participants, and roster;
2. `mineIdentities` — consume/catalog identity work without owning it;
3. `extractDebrief` — decisions, actions, questions, summary, effectiveness evidence, coaching;
4. `review` — durable human wait;
5. `draft` — attendee-facing Gmail draft after approval;
6. `tasks` — owner-assigned Google Tasks after the draft succeeds.

Transcript conversion/cataloging may occur before the Run; the Executive Assistant must consume the immutable artifact rather than duplicate Drive polling or conversion.

#### Review and expiry

- No outward write before approval.
- Review permits whole-field regeneration and dropping individual action items only.
- Regeneration reads immutable Transcript input, creates an audited Stage, and cannot see the rejected generated field.
- Regenerating action items clears prior drop decisions.
- Approval is blocked until the attendee roster is confirmed and every attendee other than the owner has a Profile with verified email.
- Unreviewed Runs expire after 30 days to `skipped`, leave the active queue, remain readable, and create no Gmail draft or Tasks.
- Approval is terminal and locks the Debrief, roster, recipients, and review decisions.
- Redo after approval starts a separate Run with a duplicate-output warning.

#### Gmail draft and recipients

Every approved Debrief creates exactly one attendee-facing Gmail draft and never sends it automatically.

- All confirmed attendees other than the owner are included automatically.
- The model may suggest non-attendee recipients from follow-up context.
- Every additional recipient requires explicit user confirmation and a Person Profile with verified email.
- The external-safe body contains concise summary, confirmed decisions, retained action items with owners/dates, open questions, and agreed next steps.
- Effectiveness assessment, coaching, confidence, source excerpts, identity-review state, private evidence, and diagnostics remain in Meeting Wizard.

#### Tasks and partial failure

Only retained action items confidently assigned to the Workspace owner become Google Tasks. Other and unresolved commitments remain in the Debrief and draft. Gmail draft creation precedes Tasks. If Tasks fail, the draft receipt remains and retry starts only the missing Tasks Stage.

## Affected Existing Capabilities

| Current capability | Decision |
| --- | --- |
| Content Scout collection, Source Targets, Source Discovery, Opportunities, diagnostics | Retain behavior; present under Content Engine; reset existing local state |
| Content Pack, 23 Draft Targets, bulk generation, Notion pages | Retire completely; remove active code paths and local history; do not delete remote Notion pages |
| Idea Engine and transcript-derived Content Ideas | Retire completely; retain no active route, API, poller, prompt, backfill, index, or local history |
| Generic text conversion and Google Drive intake primitives | Retain behind Transcript Catalog; remove duplicate consumer polling |
| Transcript → Tasks | Retire after Executive Assistant reaches acceptance; retain Google output adapters as shared capabilities |
| Content Research | Retain as distinct Module; require Profile-backed watches; reset state; use clean outputs |
| YouTube Trends | Retain measurement behavior; move product surface under Content Research; reset state |
| Workspace Person Profile model/store/resolver | Deepen into shared interface; add application surface and split broad resolution authority |
| Legacy Guest Profile | Remove routes, settings, and product concept |
| Meeting Brief Generator | Retain core Run/schedule/revision/delivery behavior; expand eligibility and transcript/provider policy; present under Meeting Wizard |
| Executive Assistant / Meeting Debrief | Build as separate retrospective Module |
| Shell Runs, Stages, artifacts, model seam, Google connection | Retain; cutover removes pre-release records but post-cutover durability remains |
| Notion authentication | Preserve as authentication during reset but leave unused by v1; no Notion product surface |

## Migration and Cutover

### Destructive boundary

The one-time migration deletes all local product data and non-auth configuration, including Runs, artifacts, results, timelines, retry state, profiles/revisions/evidence, content/research state, Source Items, baselines, Brand Voice, Source Targets, Calendar schedules/checkpoints, transcript text and ledgers, identity decisions, destination configuration, and indexes.

It preserves all authentication material for every provider: OAuth client registrations, access/refresh tokens, API keys, connection identifiers, and equivalent secrets. Exact storage classification must be enumerated in the migration inventory; ambiguous mixed files must be split or parsed deliberately rather than preserved wholesale.

Remote provider-owned data is untouched: Drive files, Calendar events, Gmail drafts/messages, Tasks, Sheets, HubSpot records, Notion pages, and public sources.

### Migration flow

1. Detect pre-cutover Workspace and block normal startup behind migration UI.
2. Inventory deletion categories and preserved authentication categories with counts but no sensitive content excerpts.
3. Require typed confirmation.
4. Execute the reset transactionally where possible and fail closed if auth cannot be separated safely.
5. Write a content-free purge receipt and one-time migration marker.
6. Validate that credentials remain structurally available without using them to fetch external data.
7. Enter onboarding: enable providers, confirm owner Profile, create Brand Voice, select Internal Domains, choose Transcripts folder, configure clean Sheets, configure workflow bundles.
8. Require every first-release capability and acceptance gate before this migration is made available outside development.

No automatic backup is created. There is no old-route compatibility, historical Run rendering, legacy retry, local data import, or remote-output reconciliation.

## Privacy, Security, and Provider Behavior

- The application remains local-first, single-user, loopback-bound, and unauthenticated under ADR-0001. Shared hosting remains blocked on authentication and isolation.
- Transcript content and public Source Items are untrusted model input and cannot alter instructions, invoke tools, or change destinations.
- Full transcript text may be sent to the configured model provider as disclosed in first-run consent.
- Public person queries may automatically include every available identifier, including email; diagnostics are mandatory.
- Content Engine receives only public-safe Profile projections despite the broad query policy.
- Provider authentication survives reset; enablement and workflow policy do not.
- A selected provider's failure is a workflow failure for bounded enrichment. Independent recurring public adapters remain partial-success collection.
- Local delete operations never claim to delete remote provider data.
- Privacy deletion is an explicit, audited exception to otherwise immutable local history.

## Implementation Decisions

1. Product navigation is explicit and independent from the Module registry.
2. Existing workflow Modules keep separate Runs and result shapes even when presented in one product area.
3. Person Profile, Transcript Catalog, Content Project, and Meeting Wizard read projection are deep modules whose interfaces are the primary test seams.
4. Person Profile lookup, candidate generation, enrichment, confirmation, creation, merge, correction, archive, and deletion have separate authority. The old broad “resolve everything” behavior may exist only as a compatibility implementation for strong controlled Calendar signals until replaced; it is never the transcript interface.
5. Consumers pin `{profileId, profileRevision}` and request an explicit projection appropriate to their purpose.
6. Content Voice and author authorization live outside canonical Profile facts.
7. Transcript Mention and Identity Decision persistence is outside Profiles; only confirmed eligible evidence attaches to a Profile.
8. Organization Mentions are shared evidence records, not Profile employer strings and not a new top-level resource.
9. Calendar occurrence identity links sibling Brief and Debrief records; it does not create a combined lifecycle.
10. Transcript Catalog is the sole writer for transcript processing ledger, immutable normalized artifact, mentions, candidates, and deletion tombstones.
11. A deleted source tombstone wins over automatic Drive detection until the user explicitly restores processing permission.
12. Content Engine source selection freezes exact source revisions and diagnostics before Outline Brief generation.
13. Outline Briefs, Platform Outlines, and Drafts use separate versioned result contracts.
14. Selected outlines are independent sibling generations from one immutable approved Outline Brief.
15. Drafts are generated individually from one approved Outline version and cannot consume sibling outputs.
16. Recurring Source Adapter collection and finite Research Requests share normalized Source Items but not Runs, checkpoints, baselines, or result models.
17. Every Named Person requires a Profile ID; deletion/archive of its Profile pauses or removes the active watch rather than leaving an orphan.
18. Meeting Brief provider bundles differ for internal and external attendees and are versioned policy.
19. Brief automatic retry ends 30 minutes before start; no partial fallback exists.
20. Global transcript semantic discovery returns reviewable candidates. It never bypasses relevance or identity confirmation to become Brief evidence.
21. Meeting Debrief approval is the sole transition to outward writes and is terminal.
22. Gmail draft and Task adapters are idempotent by Run/stage receipt and retry only missing work.
23. Legacy product routes and compatibility endpoints specific to retired workflows may be removed because no external consumer or local history survives cutover.
24. The existing backend implementation may be reorganized surgically, but the specification does not prescribe incidental file layout or class structure.

### Product-facing interface namespaces

The web application should consume cohesive product namespaces rather than old tab-specific endpoints:

- `/api/content/*`
- `/api/content-research/*`
- `/api/people/*`
- `/api/transcripts/*`
- `/api/meetings/*`, with separate `/brief/*` and `/debrief/*` lifecycle operations
- `/api/migration/*` for inventory, confirmation, status, and receipt

Exact transport routes are subordinate to the deep interfaces above. Avoid one endpoint per internal helper. Operations must return durable resource state and typed failure classifications, not provider-specific implementation details.

## Staged Implementation and Release Gate

Implementation should proceed in dependency order while remaining unreleased behind the current product boundary:

1. **Domain contracts and migration classifier:** define new result/resource contracts, auth-versus-product-state inventory, and destructive migration tests without executing the cutover.
2. **Person Profiles foundation:** deep shared interface, list/detail/review/manual-create, projections, correction/merge/archive/delete, Calendar shells, owner confirmation.
3. **Transcript Catalog and identity mining:** folder consent/inventory, shared conversion, ledger, mentions/organizations/candidates, Review integration, retention/deletion, semantic relevance candidates.
4. **Content Engine:** explicit IA, Brand Voice onboarding, author policy/Content Voice, Research Request, Outline Brief approval, nine targets, outline/draft versioning/export.
5. **Opportunity and Content Research adaptation:** keep collection/reports, remove pack terminal path, require Profiles, move Trends, configure clean outputs.
6. **Meeting Wizard Brief:** Overview projection, broaden eligibility, attendee bundles, Transcript retrieval/review, strict cutoff, owner delivery.
7. **Meeting Wizard Debrief:** automatic Run per Transcript, roster/recipient review, structured regeneration, expiry, external-safe Gmail draft, owner Tasks, approval lock.
8. **Whole-product acceptance:** new browser journeys, provider degradation, privacy cascades, restart recovery, container gate.
9. **One-time cutover:** only after all prior slices pass; expose migration gate once and switch navigation after completion.

No partial navigation with “coming soon” first-release areas is approved. No repeated destructive development resets are part of the migration contract.

## Testing Decisions

### Test philosophy and seams

Good tests assert externally observable behavior through the same interfaces callers use. They should survive internal refactors and must not assert helper call order, private indexes, prompt prose, or file layout unless those are public persistence contracts.

The fewest useful high-level seams are:

1. **Browser journeys** for Content Project creation/versioning, Profile review/correction, transcript first-run consent/review/deletion, Meeting Brief, and Meeting Debrief approval/output.
2. **Module-interface contract tests** for Person Profiles, Transcript Catalog, Content Project, Content Research/Opportunity Runs, Meeting Brief, and Executive Assistant using fake true-external adapters.
3. **Workspace migration contract** for inventory, typed confirmation, auth preservation, product-data erasure, receipt, idempotency, and fail-closed separation.
4. **Existing Run engine contracts** for blocked waits, restart recovery, immutable artifacts, Stage retries, missing-only output, and expiry.

### Prior art to preserve

- Existing Content Scout tests demonstrate frozen shared briefs, independent sibling generation, partial success, missing-only retry, Source Adapter diagnostics, and Notion receipts; reuse the first five shapes and delete Notion/23-pack assertions when the old path is removed.
- Existing Person Profile and Meeting Brief Profile-snapshot tests establish revisioned evidence and exact Run snapshots.
- Existing Meeting Brief journey, Calendar Intake, revision, cancellation, provider, and delivery suites establish the prospective workflow seam.
- Existing transcript pipeline and Drive Intake suites establish conversion, recovery, and Google output adapter behavior; replace duplicated consumer intake assertions with Transcript Catalog contracts.
- Existing Content Research and YouTube Trends suites establish independent Runs, indexes, schedules, reports, and Sheets output.
- Existing blocked-Run and ADR-0037/0038 behavior supplies the shape for Debrief review, regeneration, expiry, and ordered outputs.

### Required test groups

- Navigation and route-not-found behavior.
- Destructive migration dry inventory and actual reset with every credential category.
- Owner onboarding, Brand Voice gate, provider enablement, clean destination enforcement.
- Content Project input validation, research modes, source freeze, Profile projection privacy, Outline Brief approval, nine targets, sibling independence, partial retry, immutable revisions, single-target Draft generation, bounded instructions, export, and no publication state.
- Opportunity selection to Project creation; removal of pack/Notion behavior; independent adapter failures.
- Profile required watches, suggestion acceptance, archive/delete effects, report revision snapshots, Sheets/Gmail outputs.
- Profile candidate matching, hard conflicts, no transcript auto-create, Calendar shell creation, remembered mapping scope, merge/split/correction/invalidation, projections, archive, privacy deletion, residual-source disclosure.
- Transcript inventory consent, historical and continuous processing, pause/resume/restart, source revision/idempotency, entity extraction, explainable candidates, unresolved display, organizations, semantic relevance review, retention, cascade deletion, tombstone reingestion prevention.
- Brief eligibility for internal/external meetings and exclusion of solo/all-day/declined/cancelled events; attendee bundles; strict provider completeness; retry cutoff; transcript two-lane retrieval; pending suggestion behavior; owner-only delivery and revision.
- Debrief creation for every Transcript; unlinked roster; recipient Profile/email gate; field regeneration/drop behavior; 30-day expiry; attendee/non-attendee recipients; external-safe rendering; Gmail-before-Tasks; owner-only Task selection; approval lock; duplicate warning.
- Privacy assertions that private Profile evidence and transcript content cannot enter Content Engine prompts/results, and that local deletion never mutates remote adapters.
- Restart recovery for every durable wait and long-running backfill.

### Verification gates

During implementation, run the narrowest relevant test file while changing a seam, then `npm run typecheck`, then `npm run check`. Product navigation and user journeys require `npm run check:all`. Changes to server/web production bundles or runtime dependencies also require the production container build, boot, health check, and teardown gate defined by repository instructions.

## Acceptance Criteria

### Cutover

- The migration UI enumerates every local deletion and auth-preservation category before confirmation.
- Cancelling leaves the Workspace byte-for-byte unchanged except non-sensitive diagnostic logs.
- Confirming deletes all product state and non-auth configuration, preserves every recognized credential, writes one content-free receipt, and is idempotent on restart.
- Ambiguous mixed credential/product state fails closed and deletes nothing.
- No external provider call or remote deletion occurs during reset validation.
- Post-reset providers are available but disabled; old destinations are not restored.

### Content Engine

- Generation is impossible until owner Profile and Brand Voice are approved.
- Unauthorized Profiles cannot be selected as authors.
- Private Profile evidence and transcript-origin evidence are absent from Content Engine context and outputs.
- Each approved Outline Brief generates exactly the selected targets and no others.
- One target failure preserves successful siblings; retry creates only the missing target.
- Outline/Draft regeneration appends versions and preserves parent lineage.
- Draft generation is one target per user action; there is no bulk Draft action.
- The nine target contracts produce structured Platform Outlines before any optional Draft.
- No Notion page, platform post, publication record, schedule, or analytics record is created.

### Content Research and Opportunities

- Opportunity discovery runs without any pack/publication stage.
- Selecting an Opportunity creates one Content Project and does not generate an Outline automatically.
- One failed public adapter does not erase successful Source Items or invalidate other adapter work.
- A Named Person cannot be created without a confirmed Profile.
- Fresh Project research does not mutate the watchlist.
- Research/Trends outputs use new Sheets and preserve retry receipts.

### Person Profiles and transcripts

- Exact stable identifiers can auto-link only to existing Profiles and hard conflicts prevent linking.
- No transcript code path auto-creates a Profile.
- All ambiguous/name-only matches remain reviewable with original evidence and score explanations.
- “Remember mapping” is opt-in, scoped, versioned, and reversible.
- Calendar creates minimal attendee shells without accepting unsupported employer/title facts.
- Profile wrong-person correction invalidates affected consumers; ordinary correction appends a revision.
- Profile privacy deletion removes structured identity but discloses retained source documents.
- Transcript first run cannot begin before inventory consent.
- Full historical folder processing and later automatic processing are exactly-once across restart.
- Transcript deletion removes every locally derived transcript artifact and prevents automatic reingestion while leaving Drive untouched.

### Meeting Brief

- Eligible internal and external multi-person events schedule automatically; solo, all-day, declined, and cancelled events do not.
- No non-Calendar Brief can be created.
- Missing any selected provider prevents composition; retries stop 30 minutes before start with no partial email.
- Confirmed transcript links may supply bounded cited evidence automatically.
- Unlinked semantic results require confirmation and cannot block a scheduled Brief.
- A successful Brief is emailed only to the owner.
- Confirming late evidence never sends a surprise revision; an explicit regeneration action is required.

### Meeting Debrief

- Every mined Transcript starts one Debrief Run idempotently.
- Approval is impossible without a confirmed roster and verified attendee emails.
- No Gmail draft or Task exists before approval.
- The attendee-facing draft excludes coaching, effectiveness, private evidence, diagnostics, and unresolved identity state.
- Suggested non-attendee recipients require explicit confirmed Profile selection.
- Only owner-assigned actions become Tasks.
- Gmail draft creation precedes Tasks and partial retry does not duplicate the draft.
- Unreviewed Runs skip after 30 days and never write outward.
- Approval locks the Run; redo creates a separate Run with duplicate warning.

## Rejected Alternatives and Decision Record

- Retaining the 23-output Content Pack as advanced mode was rejected; the workflow and local history are removed completely.
- Preserving historical local Runs was rejected in favor of a one-time full product-state reset with auth retention.
- Redirecting old routes was rejected because the app has no other users or stale bookmarks.
- Deferring transcript identity mining was rejected; it is a first-release requirement.
- Mining only Calendar-linked transcripts was rejected; the full folder is processed, and every Transcript creates a Debrief.
- Auto-creating Profiles from transcript identifiers was rejected; only Calendar may create stable email shells.
- Hiding unresolved mentions was rejected; they remain visible but non-factual.
- Making every review decision globally reusable was rejected; remembered mappings are explicit and scoped.
- Finished-copy-only or bulk generation was rejected; Content Engine is outline-first with individual optional Drafts.
- Direct editing was rejected for Outlines, Drafts, and Debrief fields.
- Optional Brand Voice was rejected; an approved revision is required.
- Automatic watch creation from project research was rejected.
- In-app-only or review-gated Brief delivery was rejected; successful Briefs auto-send to the owner.
- External-only Brief eligibility was rejected; internal meetings with another attendee qualify.
- Partial Brief fallback was rejected; all selected providers must succeed before the cutoff.
- Global semantic transcript results automatically influencing Briefs was rejected; unlinked results require review.
- Manual Meeting Briefs were rejected for v1.
- Full Organization Profiles were rejected for v1.
- Post-approval Debrief synchronization was rejected; approval is terminal.
- Keeping research outputs in-app only was rejected; existing Google outputs survive with new destinations.
- Per-query approval for public identifiers was rejected; all identifiers may be used automatically with diagnostics.

## Open Questions

There are no unresolved product decisions blocking implementation. Exact scoring thresholds, bounded concurrency values, source/excerpt caps, retry intervals before the fixed Brief cutoff, and visual presentation details are implementation policy values owned by the implementation plan. They must remain versioned/configurable where changing them can alter persisted classifications, and they may not weaken the approved authority, privacy, lifecycle, or output boundaries.

## Further Notes

- This specification intentionally changes or supersedes parts of earlier decisions: Content Pack generation/publication portions of ADR-0028 and ADR-0041 are retired, while Source Adapter independence and immutable sibling-input principles remain; ADR-0034 owner-only Brief delivery remains but eligibility expands beyond External Guests; ADR-0037 and ADR-0038 remain binding for Debrief review/expiry; ADR-0039 remains binding for independent Content Research; ADR-0042 remains binding for Workspace-owned Person Profiles.
- The one-time reset means there is no migration for current Named People, Person Profiles, Brand Voice, Sources, Calendar schedules, Runs, or local evidence. The implementation must not spend effort preserving data the owner explicitly chose to erase.
- The first release may be built in internal slices, but it is not complete until every acceptance group passes and the single destructive cutover is safe.
- No application implementation changes are authorized by this specification session.
