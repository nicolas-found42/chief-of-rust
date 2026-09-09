# Content and meeting workflow discovery questionnaire

**Purpose:** Inspect the current application and return an evidence-backed recommendation for consolidating its content and meeting features around shared Person Profiles.

**From:** Nicolas  
**To:** A fresh coding agent with no prior knowledge of this codebase  
**How answers will be used:** To decide the final information architecture, feature boundaries, and transcript identity-resolution design before implementation begins.

## Context

The proposed product direction has two main consolidations. First, merge the relevant content-related tabs into a **Content Engine** that creates an outline for a post on one or many platforms. It should use the application's research capabilities, especially **Person Profiles** and **Content Research**. The current functionality that turns transcripts directly into posts is not considered useful enough to retain in this iteration; transcripts may return later as an optional research source, but that is explicitly deferred. Second, merge the existing meeting brief and meeting debrief areas into a **Meeting Wizard**. Brief and debrief must remain separate workflows within that shared area. Meeting briefs should be enriched with Person Profiles, names and organizations mined from transcripts, and future meetings from Google Calendar. Transcript mining should retain all useful names, including names encountered in organizational context, because those identities may later support meeting preparation, post brainstorming from a person's point of view, emails, tasks, and other debrief actions. A **Person Profile is an app-wide shared resource**, not a child feature owned exclusively by Content Engine or Meeting Wizard; each consumer should use it for its own purpose.

Begin by reading `AGENTS.md` and the repository's relevant domain and architecture documentation. Then inspect the implementation rather than relying only on labels or filenames. Do not make code changes as part of this response. Support important claims with concrete file paths, symbols, routes, and—where useful—line references. Clearly distinguish observed current behavior from your recommendations and from anything you could not verify.

## How to answer

Please answer within one focused repository review (roughly 60–90 minutes). Return one structured Markdown response, using tables where they make ownership or current-versus-proposed mappings easier to compare. Partial answers and explicit “I don't know” statements are useful when the repository does not contain enough evidence; identify exactly what evidence is missing instead of guessing.

The first five questions are the most important. Answer them before spending time on the follow-up detail.

## Critical findings

### 1. What is the complete map of the existing product surface affected by this proposal?

Identify every relevant current tab, navigation item, route, page, component, workflow entry point, server/API boundary, persistence model, background process, integration, and meaningful test. Include at least the current content research, transcript-to-post, person-profile, meeting brief, meeting debrief, transcript-processing, and calendar-related surfaces. For each item, state its current responsibility, main dependencies, and which proposed destination it would map to: Content Engine, Person Profile, Content Research, Meeting Wizard, removal/deferment, or shared infrastructure.

_Why this matters:_ We need a repository-backed impact map before changing navigation or moving responsibilities.

> Answer here. Prefer a table with columns for current surface, code location, observed responsibility, dependencies, and proposed destination.

### 2. What end-to-end workflows exist today, and where are their actual seams?

Trace the current user and data flow for: researching content, creating a post or outline, creating or enriching a person profile, generating a meeting brief, processing a transcript, and producing a meeting debrief. Show where information enters, how it is transformed, where it is stored, and where it is consumed. Identify duplicated logic, tight coupling, hidden cross-feature dependencies, and reusable capabilities that already cross tab boundaries.

_Why this matters:_ Tab consolidation should follow the product's real capability boundaries rather than merely moving UI components.

> Answer here. A compact flow diagram or numbered flow per workflow is welcome, followed by evidence from the code.

### 3. What final information architecture and tab names do you recommend?

Recommend the final top-level navigation and the internal structure of **Content Engine** and **Meeting Wizard**. State the exact user-facing tab names, route names, sub-navigation or mode names, and the intended landing state for each area. Preserve meeting brief and meeting debrief as distinct workflows inside Meeting Wizard. Explain where Person Profiles and Content Research should be discoverable, including whether each needs its own top-level entry even though it can be invoked from other workflows. Map every affected current tab and route to its proposed destination, redirect, or removal.

_Why this matters:_ We need one coherent navigation proposal that reduces fragmentation without concealing reusable capabilities.

> Answer here. Include a current-to-proposed mapping and a concise rationale for the recommended labels.

### 4. Where should the responsibility boundaries sit between Content Engine, Person Profile, Content Research, and Meeting Wizard?

Define what each capability owns, what it consumes, what it produces, and what it must not own. Treat Person Profiles as shared app-wide resources with multiple consumers rather than as records belonging to a single workflow. Explain which layer should own profile lookup, enrichment, identity matching, provenance, and profile updates; which layers may request or read those operations; and how feature-specific annotations or derived context should avoid polluting the canonical profile. Also state which existing modules could remain in place, which would need to move, and which require a new shared seam.

_Why this matters:_ Clear ownership is necessary to prevent the merged tabs from becoming coupled feature bundles and to keep profiles reusable for future outreach and other uses.

> Answer here. Prefer a responsibility matrix covering ownership, inputs, outputs, consumers, and explicit non-responsibilities.

### 5. What transcript name-mining and identity-matching design do you recommend?

Propose a concrete pipeline that mines all useful person and organization names from transcripts, including person names found in organizational context, then matches them against existing Person Profiles or produces reviewable candidates. Account for available identifiers such as full name, email address, company or organization, title, social handles, LinkedIn URL, HubSpot identity, transcript speaker metadata, meeting participants, and calendar attendees. Specify normalization, entity extraction, candidate generation, scoring or confidence, ambiguity handling, provenance, manual confirmation, deduplication, and when—if ever—a new canonical profile should be created automatically. Explain how false positives such as product names, organization fragments, and same-name people are contained. Tie the recommendation to the repository's existing models and processing boundaries wherever possible.

_Why this matters:_ Extracted names will be reused across high-impact workflows, so a plausible string match must not silently become a false identity.

> Answer here. Include the proposed stages, stored evidence, confidence policy, and at least three difficult matching examples.

## Content Engine details

### 6. What should the Content Engine's end-to-end outline workflow be?

Describe the recommended user flow and data flow for selecting a subject or Person Profile, choosing one or many platforms, invoking Content Research, reviewing sources, and generating platform-appropriate outlines. Clarify what is shared across platforms and what must be generated separately for each platform. Identify what the first iteration should produce and which current functionality can be reused.

> Answer here.

### 7. What exactly should happen to the current transcript-to-post functionality?

Locate all UI, routing, logic, prompts, storage, and tests that exist specifically to turn transcripts into posts. Recommend what should be removed from the active product, what general-purpose code should remain because another workflow uses it, and what minimal seam—if any—should be preserved so transcripts could later return as an optional Content Engine research source. Do not recommend implementing that deferred source now.

> Answer here. Separate “remove now,” “retain as shared capability,” and “defer without implementation.”

## Meeting Wizard details

### 8. How should Meeting Wizard contain two separate workflows without duplicating shared work?

Describe the recommended entry points, steps, inputs, outputs, and lifecycle for **Meeting Brief** and **Meeting Debrief** inside one Meeting Wizard area. Identify which data and services they should share and which state must remain workflow-specific. Explain how a user moves between upcoming meetings, pre-meeting preparation, transcripts, and post-meeting actions without collapsing brief and debrief into one indistinct flow.

> Answer here.

### 9. How should Person Profiles, transcripts, and future Google Calendar meetings enrich a meeting brief?

Trace the proposed enrichment sequence from an upcoming calendar event to attendee resolution, relevant transcript discovery, extracted-name review, Person Profile lookup or enrichment, and final brief generation. State what should happen when calendar access is unavailable, an attendee is unresolved, several profiles match, or a transcript mentions people who are not meeting attendees. Identify the code and data-model changes implied by your recommendation, but do not implement them.

> Answer here.

## Synthesis

### 10. What decisions can be made now, and what remains genuinely unresolved?

Conclude with: (1) your recommended information architecture; (2) the proposed capability boundaries; (3) the recommended identity pipeline; (4) the most important repository evidence supporting those recommendations; and (5) only the product questions that cannot be answered by inspecting the code. Rank unresolved questions by how strongly they could change the design. Do not turn implementation details that you can reasonably recommend into questions for Nicolas.

> Answer here.

## Anything else?

Add any important contradiction, risk, security or privacy concern, migration issue, or existing capability that the questions above missed. Keep this section evidence-based and distinguish near-term blockers from longer-term opportunities.

> Answer here.
