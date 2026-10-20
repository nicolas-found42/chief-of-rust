# Chief of Staff — Complete UX/UI Refactoring Specification

## Agent Execution Protocol
You are tasked with refactoring the **Chief of Staff** web application to eliminate database-schema-first UI patterns, extreme vertical page sprawl, semantic button ambiguity, and raw data leakage (unparsed Markdown, raw UUIDs, raw JSON blobs, and unformatted timestamps/enums)[cite: 2, 13, 27, 57, 80, 144].

### Core Architecture & Codebase Map
* **Global Shell & Styles:** `crates/app/templates/shell.html`, `static/app.css`[cite: 144]
* **Routing & Work Queue:** `crates/app/src/routes.rs`, `crates/app/src/work.rs`[cite: 144]
* **Meetings & Transcripts:** `crates/app/src/meetings.rs`, `crates/app/src/meetings/{intake,generation,debrief,records}.rs`[cite: 144]
* **Content Engine & Research:** `crates/app/src/content/{models,views,routes}.rs`[cite: 144]
* **Terminal (People & Companies):** `crates/app/src/people.rs`, `crates/app/src/terminal/{mod,person,execution,comparison}.rs`[cite: 144]
* **Tasks:** `crates/app/src/tasks.rs`[cite: 144]
* **Settings & Providers:** `crates/app/src/settings.rs`, `crates/app/src/settings/providers.rs`[cite: 144]

### Guardrails for Implementation
1. **Preserve Route & Form Contracts:** Keep all existing HTTP route paths, aliases (`/content`, `/research`, `/youtube`, `/content-engine/projects/{id}`, `/onboarding`), form `action` URLs, and input `name` attributes intact unless adding backwards-compatible enhancements, so existing integration and E2E tests continue to pass[cite: 4, 144].
2. **Work Iteratively:** Complete one phase at a time. Run `cargo check` and `cargo test` at the end of every phase before moving to the next.
3. **Zero Unparsed Raw Data in User Views:** Never render raw UUIDs as primary labels, raw JSON objects as primary UI feedback, raw snake_case enum tokens, or uncompiled Markdown in user-facing prose views[cite: 20, 27, 33, 57, 80, 112, 138].

---

## Phase 1: Design System, Button Semantics & Layout Density (`static/app.css`)

Currently, almost every button in the app uses the exact same dark-green fill (`Save`, `Skip`, `Dismiss`, `Archive`, `Delete`), inputs stretch across the entire container width regardless of data type, and pages stretch up to 12,174px tall[cite: 10, 22, 39, 80, 92, 95, 117].

- [ ] **1.1 Semantic Button Hierarchy:** Define distinct button classes in `static/app.css` and apply them across all templates:
  - `.btn-primary`: Solid dark-green fill. Reserve strictly for the single primary forward/save action in a view or form (e.g., `Save meeting`, `Generate outline`, `Create project`, `Accept into Tasks`)[cite: 22, 36, 43, 117].
  - `.btn-secondary`: Neutral surface with subtle border and dark text. Apply to all secondary, cancel, filter, pause, or dismissal actions (`Skip`, `Dismiss`, `Filter`, `Pause`, `Resume`, `Archive person`, `Restore person`, `Restore task`, `Set state`, `Disconnect this workspace`)[cite: 22, 38, 39, 54, 92, 99, 113, 117, 130, 133].
  - `.btn-danger`: Red text/border on neutral surface (hovering to solid red fill) or solid red fill. Apply to all destructive actions (`Delete meeting`, `Delete transcript`, `Move to trash`, `Permanently delete profile data`, `Permanently delete company data`)[cite: 22, 23, 76, 79, 119].
  - `.btn-sm`: Compact padding and font size for inline table/list row actions.
- [ ] **1.2 Constrain Form Input Widths & Grid Layouts:**
  - Add utility classes `.form-grid` (2- and 3-column CSS Grid for related scalar inputs), `.input-sm` (`max-width: 10rem` for numeric intervals like `360`), `.input-md` (`max-width: 20rem` for dates, timezones, statuses, priorities, and confirmation words like `DELETE`), and `.input-lg` (`max-width: 36rem` for titles, names, and emails)[cite: 10, 76, 118, 131, 135].
  - Replace stacked full-width single-field rows on `/tasks` filters, `/meetings` creation, `/terminal` entity creation, and `/settings` schedules with compact horizontal/grid layouts[cite: 10, 68, 113, 135].
- [ ] **1.3 Remove Nested Scroll Traps:**
  - In `static/app.css`, remove the fixed height limit and `overflow-y: auto` from the research report prose panel (observed on `/research/reports/{id}`, Captures 46, 57, 58) so long-form reports flow naturally with the main document scroll[cite: 57, 62, 63, 144].
- [ ] **1.4 Card Borders & Status Badges:**
  - Replace the low-contrast background blocks and corner tick marks with clean, well-defined card containers (`border: 1px solid var(--border-color); border-radius: 6px; background: var(--surface-card);`)[cite: 74, 103, 113].
  - Add semantic pill badge classes: `.badge-success` (`Approved`, `reviewed`, `confirmed`, `Active`, `done`), `.badge-warning` (`awaiting review`, `Needs review`, `pending`, `partial`, `running`, `meeting changed since generation`), `.badge-danger` (`failed`, `blocked`, `error`, `uncertain`), and `.badge-neutral` (`draft`, `Paused`, `scheduled`)[cite: 20, 23, 24, 37, 48, 54, 89, 117, 124, 139].

---

## Phase 2: App Shell, Navigation & Formatting Utilities (`shell.html`, `routes.rs`)

Currently, the top navigation bar has no active-route indicator, `Runs & diagnostics` is buried in the page footer, count badges say `0 records` / `1 records` / `1 failed Runs`, and raw ISO timestamps/enums leak into templates[cite: 8, 9, 55, 85, 116, 137].

- [ ] **2.1 Active Route Highlighting in `crates/app/templates/shell.html`:**
  - Pass the current section/route identifier into `shell.html` and apply an `.active` class (`aria-current="page"`, bold weight, bottom accent underline) to the matching top-level nav link (`Meeting Wizard`, `Content Engine`, `Content Research`, `Bloomberg Terminal`, `Tasks`, `Settings`)[cite: 8, 144].
- [ ] **2.2 Promote `Runs` to Top Navigation:**
  - Add `Runs` to the top-right utility navigation alongside `Settings` in `shell.html`[cite: 8].
  - If there are currently `running` or `failed` Runs, render a compact status count badge next to `Runs` in the header[cite: 9, 139].
- [ ] **2.3 Pluralization Helper:**
  - Implement a shared formatting helper `pluralize(count, singular, plural)` and apply it across all views to fix hardcoded plural strings:
    - Home & Terminal cards: `0 records` -> `0 records`, `1 records` -> `1 record`[cite: 8, 9, 68].
    - Home Runs banner: `1 failed Runs` -> `1 failed Run`[cite: 9].
    - Debrief coverage: `1 segments` -> `1 segment`[cite: 26].
    - Content projects: `1 evidence items` -> `1 evidence item`[cite: 44, 49].
    - Content research: `1 sources` -> `1 source`[cite: 56].
    - Person dossier: `1 supported excerpts` -> `1 supported excerpt`[cite: 94].
- [ ] **2.4 Human-Readable Timestamps, Numbers & Enums:**
  - Create a timestamp formatting helper that converts raw ISO-8601/nanosecond strings (`2026-10-15T05:49:00.667833802+00:00`, `2026-10-16T14:00:00Z`) into readable dates (e.g., `Oct 15, 2026 · 05:49 UTC`), preserving the raw timestamp inside `<time datetime="...">`[cite: 55, 57, 137].
  - Create a number formatter to insert thousands separators for metrics and byte counts (e.g., `14,000` instead of `14000`, `+1,500` instead of `+1500` on `/youtube`)[cite: 13, 66, 67].
  - Create a display-label mapper for internal snake_case/kebab-case tokens:
    - `in_progress` -> `In progress`, `needs_review` -> `Needs review`, `linkedin-standard-post` -> `LinkedIn Standard Post`[cite: 29, 39, 116].
    - `not_searched` -> `Not searched`, `bounded_empty` -> `No results`, `full_returned` -> `Full content`, `selected_excerpts` -> `Selected excerpts`[cite: 83, 84, 85, 89].
- [ ] **2.5 Safe Markdown Rendering Utility:**
  - Add a shared Markdown-to-HTML rendering function (converting `#`, `##`, `###`, `**bold**`, `*italic*`, inline code, and lists into semantic HTML tags while escaping raw HTML) for use in Research Reports (`/research/reports/{id}`) and Terminal Briefs (`/terminal/people/{id}/briefs/{id}`, `/terminal/companies/{id}/briefs/{id}`)[cite: 57, 62, 63, 80, 81, 82].

---

## Phase 3: Meeting Wizard & Transcript Catalog (`meetings.rs`, `meetings/*`)

- [ ] **3.1 Replace Manual RFC 3339 Inputs (`meetings.rs`):**
  - On `/meetings` (Capture 02) and `/meetings/{id}` (Capture 16), replace the raw text input `Start (RFC 3339, with timezone, e.g. 2026-10-13T14:00:00-04:00)` with a native `<input type="datetime-local">` paired with the configured workspace timezone badge (and update the backend parser to accept both `datetime-local` strings and full RFC 3339 strings so existing tests remain green)[cite: 10, 11, 21, 131].
- [ ] **3.2 Collapse Intake Forms on `/meetings` (`meetings.rs`):**
  - Wrap `Import Google Calendar` and `Create a meeting` in clean top action disclosures (`<details>` or modal drawers) or a 2-column layout so upcoming meetings remain the primary focus of `/meetings`[cite: 10, 11].
- [ ] **3.3 Overhaul Transcript Catalog (`/transcripts`, `meetings/intake.rs`):**
  - **Move Intake Controls Above the Table:** Move `Add transcript text` and `Import from Google Drive` from the bottom of the 10,276px page (Capture 04, p. 17-18) to the top of `/transcripts` inside collapsible `<details>` action panels (`+ Add Transcript Text`, `Import from Google Drive`)[cite: 13, 17, 18].
  - **Sort & Paginate:** Sort transcripts newest-first by default instead of arbitrary insertion order[cite: 13, 14]. Add pagination (25 rows per page) and a top search/filter bar (`Search title`, filter by `All` / `Unassigned` / `Confirmed`)[cite: 13].
  - **Humanize Size & Flag Empty Imports:** Format the `Bytes` column (`66104`, `865`, `810`) as KB (`64.6 KB`, `0.8 KB`) and display a warning badge (`Very short / <1 KB`) on transcripts under 1,024 bytes[cite: 13, 14, 16].
- [ ] **3.4 Declutter Meeting Detail (`/meetings/{id}`, `meetings.rs`):**
  - In `Draft history` (Capture 16), prefix items with explicit version numbers (`Brief v2`, `Brief v1`, `Debrief v2`) and render status badges (`Draft`, `Reviewed`, `Stale: meeting changed`)[cite: 20].
  - Collapse `Edit meeting`, `Meeting state`, and `Delete meeting` into a secondary collapsible section or side panel; style `Set state` with `.btn-secondary` and `Delete meeting` with `.btn-danger`[cite: 21, 22].
  - On stale historical draft pages (Capture 53), add a direct primary button or form to `Generate new debrief` so the user is not stranded in a dead end[cite: 31].
- [ ] **3.5 Fix Debrief Review Ergonomics (`/meetings/{id}/artifacts/{id}`, `meetings/debrief.rs`):**
  - **Inline Action Capture:** In Capture 19, `Action items` are presented near the top of the page (p. 27), while the `Capture this action item` button is detached at the bottom of the 8,478px scroll (p. 30)[cite: 27, 30]. Render the `Capture this action item` button directly inline inside each Action Item card[cite: 27, 30].
  - **Format Evidence Judgments:** Replace the raw JSON blocks (`{ "demo": true, "note": "..." }`) inside `Evidence judgments and uncertainty` disclosures with clean HTML text/badges[cite: 27, 28, 29, 30].
  - **Demote Token Telemetry & Empty Sections:** Move provider token/timing telemetry (`TypeSafe/Jev: 0 input tokens...`) into a collapsed `<details>` block at the bottom of the page, and collapse/omit empty finding categories (`Risks and blockers: No supported finding extracted`, `Suggestions: No supported finding extracted`)[cite: 26, 29].
- [ ] **3.6 Resolve Source Meeting UUIDs in Weekly Reviews (`/meetings/weekly/{id}`, `meetings/records.rs`):**
  - In Capture 20, `Source meetings` links display raw UUIDs (`Meeting 2bf0c268-b3d0-59c5-bf48-4657a40594d6`)[cite: 33]. Join or look up the meeting records so links display the actual meeting title and date (e.g., `Pilot review and next steps [DEMO] (Oct 19, 2026)`)[cite: 20, 33].

---

## Phase 4: Tasks & Commitment Pipeline (`tasks.rs`)

- [ ] **4.1 Fix Dropped Deadlines on Accepted Meeting Proposals:**
  - When a Debrief extracts a `stated deadline` (e.g., `stated deadline: by Friday` in Capture 19, p. 27), carry that deadline note into the Task proposal and display/pre-fill it on the resulting Task (`Capture 52`, p. 120) so deadline context is never silently lost when accepting an action into Tasks[cite: 27, 117, 120].
- [ ] **4.2 Compact Filter Bar & Top Proposal Banner on `/tasks`:**
  - Convert the vertically stacked `Search`, `Status`, `List`, and `Filter` controls (Capture 12, p. 113) into a single compact horizontal toolbar[cite: 113, 115].
  - When `Meeting actions to review` has pending proposals (Capture 34, p. 116-117), surface it above the `Task list` (or provide a top alert badge jumping to it) so pending commitments aren't buried below the fold[cite: 116, 117].
  - Add quick status badges and an inline completion toggle to each row in `Task list`[cite: 116].
- [ ] **4.3 Isolate Trash View (`/tasks?trash=true`):**
  - When viewing `/tasks?trash=true` (Capture 37), hide the `Capture a task` form, `Meeting actions to review` section, and `Create a list` form[cite: 126, 127, 128]. Display a clear `Trash` header showing only trashed tasks with inline `Restore task` actions[cite: 127, 129, 130].
- [ ] **4.4 Clean Up External Delivery Reconciliation (`/tasks/{id}`):**
  - On `/tasks/{id}` when external delivery is in an `uncertain` state (Capture 36, p. 124-125), remove the redundant triple `Provider` dropdowns; bind the reconciliation forms (`Attach verified existing remote task` and `Record absence and allow a fresh delivery`) to the provider of the uncertain delivery record (`asana` in Capture 36)[cite: 124, 125].

---

## Phase 5: Content Engine (`content/{models,views,routes}.rs`)

- [ ] **5.1 Collapse Static Brand Setup on `/content-scout`:**
  - On `/content-scout` (Capture 06, Capture 21), once a `Brand profile` revision has been saved (`Revision 1`), render `Brand profile` and `Source watchlist` inside collapsible `<details>` cards (or secondary tabs) with a compact summary header (`Brand: Northstar Notes [DEMO] · Revision 1 · 1 active source [Edit]`), bringing `Opportunity shortlist` and `Content projects` immediately above the fold[cite: 34, 37, 38, 39].
- [ ] **5.2 Auto-Collapse Completed Stage Gates on `/content/projects/{id}`:**
  - Add a visual horizontal step indicator at the top of `/content/projects/{id}` (`1. Evidence` -> `2. Outline` -> `3. Draft` -> `Export`) showing the current stage status[cite: 42, 43, 44, 50].
  - Inside `1. Evidence` (Capture 22, p. 43; Capture 23, p. 46), collapse the `Attach evidence in a new revision` form inside a `<details>` disclosure (`+ Attach manual evidence`) so it does not push the primary `I reviewed this evidence and approve it for generation` button down the page[cite: 43, 46].
  - When `1. Evidence` is already approved (Capture 23, Capture 51), auto-collapse the `1. Evidence` section by default so the user lands directly on `2. Outline` or `3. Draft`[cite: 45, 47, 50, 52]. Similarly, when `2. Outline` is approved and a draft exists (Capture 23, Capture 51), auto-collapse `2. Outline` into a summary card so `3. Draft` and `Download reviewed draft` are immediately visible without scrolling 5,000px[cite: 47, 48, 52, 53].

---

## Phase 6: Content Research & YouTube (`content/*`)

- [ ] **6.1 Compile Markdown & Citation Links in Research Reports (`/research/reports/{id}`):**
  - In Captures 46, 57, and 58, the report renders raw `#`, `##`, and `**` Markdown syntax and inline 36-character UUID citations (`[1e442dd0-4ef9-42c3-ab0b-f3df684c6366]`) inside a nested scroll box[cite: 57, 62, 63].
  - Pass the report body through the Phase 2.5 Markdown renderer so headings, lists, and bold text render as clean HTML[cite: 57, 62].
  - Replace inline source UUIDs (`[1e442dd0-...]`) with numbered superscript citation links (`<a href="#source-1">[1]</a>`) corresponding to numbered source cards (`#source-1`, `#source-2`) in `Captured public sources`, and remove/collapse the raw UUID subtitle on each source card[cite: 57, 59, 60, 61].

---

## Phase 7: Bloomberg Terminal — People & Companies (`people.rs`, `terminal/*`)

- [ ] **7.1 Fix Company Directory Parity & Discoverable Comparisons (`/terminal`, `/terminal/companies`):**
  - Add the `Add a company` collapsible form/modal directly onto `/terminal/companies` (Capture 11) so users do not have to navigate back to `/terminal` to add a company[cite: 68, 72].
  - Add a `Compare companies` section/form on `/terminal` and `/terminal/companies` (allowing selection of two companies, workflow type, and offering scope) so the comparison route `/terminal/comparisons/{id}` (Capture 33) has a discoverable UI entry point[cite: 4, 68, 72, 112].
- [ ] **7.2 Always Surface Completed Company Briefs (`/terminal/companies/{id}`):**
  - In Capture 45 (`/terminal/companies/80b0fdfa-...`), the completed Stripe research brief (Capture 49) is completely missing from the Company Profile because its Run recorded `ledger_valid: false` (Capture 47)[cite: 77, 78, 87, 138].
  - Update `/terminal/companies/{id}` to always list all saved research briefs for that company under `Full research`, displaying a `.badge-warning` (`Ledger warnings`) when `ledger_valid == false` rather than hiding the brief[cite: 78, 87, 138].
- [ ] **7.3 Lock Down Archived Profiles & Isolate Danger Zones (`/terminal/people/{id}`, `/terminal/companies/{id}`):**
  - On archived profiles (`Capture 56`), display a prominent top warning banner (`Archived Person — Restore this profile to edit fields or run new research`) and hide or disable the `Save identity`, `Save evidence`, `Research with selected model`, and `Run full research` forms until restored[cite: 98, 99, 100, 101].
  - Wrap the `Privacy deletion` section on Person and Company profiles (Captures 27, 31, 44, 45, 56) inside a collapsed `<details class="danger-zone">` block and style `Permanently delete ...` with `.btn-danger`[cite: 76, 79, 95, 101, 109].
- [ ] **7.4 Fix Person & Company Full Research Briefs (`/terminal/*/briefs/{id}`):**
  - **Fix Unbroken Prose Block:** In Capture 48 (p. 80-82), the 10-section Patrick Collison brief renders as a single massive paragraph with inline `##` markers[cite: 80, 81, 82]. Normalize newline spacing before `##` headers and render the brief through the Phase 2.5 Markdown parser[cite: 80, 81, 82].
  - **Collapse Irrelevant Collector Spam:** In Captures 48 (p. 85) and 49 (p. 90), the `Coverage` list dumps 15+ `not_applicable` and `bounded_empty` collectors (`sec_tickers: not_applicable`, `clinicaltrials_search`, `lever_jobs`, `greenhouse_jobs`, `openfda_search`, etc.)[cite: 85, 90]. Render only active/retrieved/partial/blocked collectors in the main `Coverage` list, and place all `not_applicable` and `empty` collectors inside a collapsed `<details>` toggle (`Show N skipped or empty collectors`)[cite: 85, 90].
  - **Humanize Ledger Warnings:** Replace raw zero-indexed array pointers (`coverage[0]: covered question needs source evidence`, `sources[9]: selected excerpts require inspection_details` in Captures 48 and 49) with the corresponding collector/source name[cite: 86, 91].
- [ ] **7.5 Replace Raw JSON & UUIDs in Company Comparisons (`/terminal/comparisons/{id}`):**
  - In Capture 33, replace the raw input UUIDs (`Inputs: 98cebcf2-2687-566a-abb1-cdbca285e501 v1 · 68bfeb54-c1b1-5420-89bd-0cc6372cda20 v1`) with the human company names (`Northstar Labs [DEMO] (v1) vs Harbor Systems [DEMO] (v1)`)[cite: 112].
  - Replace the raw JSON `<pre>` dump inside `Scorecards` with a formatted HTML table displaying each criterion (`Evidence strength`, `Need`, etc.), its score badge, and its reason[cite: 112].

---

## Phase 8: Settings & Runs (`settings.rs`, `settings/providers.rs`, `work.rs`)

- [ ] **8.1 Consolidate `/settings` Forms & Fix Contradictory Statuses (`settings.rs`):**
  - **Fix Jev Status Contradiction:** On `/settings` (Capture 13), `Evidence judgments` reports `Jev · typesafe/jev-1.14 · Configured` (p. 132), whereas `Other connections` reports `Jev (OPENROUTER_API_KEY is the fallback) | Not configured · JEV_API_KEY` (p. 134), and Meeting detail (Capture 16, p. 20) says `Debrief evidence checks are not configured`[cite: 20, 132, 134]. Unify the configuration check so `Evidence judgments` accurately reflects whether `JEV_API_KEY` or `OPENROUTER_API_KEY` is actually present in the environment[cite: 20, 132, 134].
  - **Compact Schedules Table:** Instead of 5 separate full-width forms each with its own `Interval in minutes` input and `Save schedule` button spanning 2,500px (Capture 13, p. 135-136), arrange the 5 schedules (`Calendar intake`, `Drive transcript intake`, `Content Scout`, `Content Research`, `YouTube observations`) into a compact table/grid where each row has the schedule name, enable checkbox, compact `Interval (min)` input, and inline save button (or a unified save handler)[cite: 135, 136].
- [ ] **8.2 Enrich `/runs` List & Auto-Refresh Running Jobs (`work.rs`):**
  - **Show Target Context in `/runs`:** In Captures 14 and 39, `/runs` shows only raw job types (`terminal.company_research`, `content.watch`, `meetings.debrief`) and raw timestamps[cite: 137, 139]. Extract the target label/entity name from the Run's input/result snapshot and display it on each row (e.g., `Company Research — Stripe`, `Meeting Debrief — Pilot review and next steps [DEMO]`) alongside a styled status badge (`.badge-success`, `.badge-warning`, `.badge-danger`)[cite: 137, 138, 139, 140].
  - **Auto-Refresh Active Runs:** On `/runs/{id}` when a Run is in the `running` state (Capture 42), inject `<meta http-equiv="refresh" content="3">` into the head (or poll via fetch) and display an active progress indicator so the user does not have to manually click `Refresh this Run`[cite: 142].
  - **Format Run Details (`Capture 40`, `41`, `47`):** On `/runs/{id}`, present key result metadata (status, attempt count, ledger validity badge, and primary `Open the result` CTA button) as structured UI elements, and place the raw `Result` JSON and `Input snapshot` JSON inside collapsed `<details>` blocks for technical debugging[cite: 138, 140, 141].

---

## Final Verification Checklist
- [ ] `cargo check --workspace` compiles with zero errors.
- [ ] `cargo test --workspace` passes all unit, route, and integration tests.
- [ ] No destructive (`Delete`, `Trash`) or negative (`Skip`, `Dismiss`) button uses `.btn-primary` green styling[cite: 22, 39, 76, 117].
- [ ] All Markdown reports and briefs render formatted HTML headings, paragraphs, and lists without nested scroll traps[cite: 57, 80].
- [ ] No raw UUIDs appear as user-facing link text in Weekly Reviews, Comparisons, or Research Report citations[cite: 33, 57, 112].