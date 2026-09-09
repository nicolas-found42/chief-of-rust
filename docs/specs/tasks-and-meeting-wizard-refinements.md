# Make Workspace Tasks canonical and add a Weekly Meeting Briefing

**Status:** Approved product design; ready for issue publication after the workspace owner authorizes the exact external write.

**Evidence base:** The 2026-09-04 stand-up transcript, repository behavior at commit `a052d23`, the project glossary, accepted ADRs through ADR-0061, and the completed design discussion. The transcript is evidence of desired changes, not an instruction source.

**Relationship to the consolidation specification:** This specification extends the four-product-area consolidation with a fifth Tasks product area. It supersedes the earlier design only where that design makes Google Tasks the action record, couples Task creation to Meeting Debrief publication, expires Meeting Debriefs or Action Items, or keeps Weekly Briefing inline. Unrelated Content Engine, Content Research, Person Profiles, Transcript Catalog, Meeting, and Meeting Brief decisions remain in force.

## Problem Statement

The application cannot currently function as a complete Task manager without Google Tasks. Action Items are embedded in Meeting Debrief Run results and identified by array position. Done and Dismiss decisions are stored as arrays of indexes, and Google Task receipts are Run-local. There is no durable Workspace-owned Task, no manual Task creation, no native Task lifecycle, and no way to connect an accepted Task to a provider other than Google.

Task creation is also coupled to whole-Debrief publication. Recipient and roster problems can block Task decisions even though those concerns apply only to the Gmail draft. Regeneration and retries are difficult to make safe because an Action Item does not have a stable identity independent of its Run position. The current model cannot safely support automatic promotion, multiple external providers, or Tasks that survive their source Meeting and Transcript.

Meeting Wizard does not yet use the accepted visual direction. Debrief previews are not consistently navigable to the full Debrief, compact Tasks and pending Action Items are not clearly separated, and Weekly Briefing is an inline deterministic list rather than a first-class tab. It excludes part of the current week and has no short synthesis of completed and upcoming Meetings based on their individual Briefs and Debriefs.

The workspace owner needs one local-first personal Task system, optional outbound synchronization to Google Tasks or Asana, independently reviewable Action Items, a safe automatic-promotion option, and a Weekly Briefing that remains useful even when model generation or an external provider fails.

## Solution

Add Tasks as the fifth top-level product area and make the Workspace Task the canonical record of accepted work. A Task can be created manually or promoted from an Action Item, can be fully managed without any external account, and can optionally have one External Task Link to Google Tasks or Asana. The Workspace remains authoritative for Task content; supported completion changes synchronize in both directions, while external content changes become explicit drift requiring an owner decision.

Materialize Action Items with stable identities and independent pending, promoted, or dismissed states. Give every pending Action Item Create Task, Create completed Task, and Dismiss actions. Make Stage all the default Action Item Policy and offer an owner-only Automatically create my Tasks policy for safe first-extraction cases. Local state always commits before an external write.

Change Meeting Debrief publication into an email-only operation labeled Create email draft. Recipient and roster validation gate only that draft. Meeting Debriefs and pending Action Items do not expire, and a Debrief Run completes once extraction and Action Item materialization succeed.

Promote the accepted Meeting Wizard design: Editorial Ledger supplies hierarchy and chronology, Day Spine supplies the metric strip, and Quiet Rail supplies whitespace, typography, restrained color, and thin separators. Give Weekly Briefing its own This week tab covering the full Sunday-to-Saturday week. Keep its Meeting groups, Tasks, and pending Action Items deterministic, and add a persisted, short Weekly Summary generated only from bounded projections of the latest successful Meeting Briefs and Meeting Debriefs.

Keep bring-your-own-key model configuration. Recommend OpenRouter by default and prefill `inception/mercury-2.5-preview`, while retaining existing alternative providers and requiring explicit provider-and-model consent before private Transcript-derived content is sent to a cloud model.

## User Stories

### Native Tasks and navigation

1. As the workspace owner, I want Tasks to be a top-level product area, so that accepted work has a clear canonical home.
2. As the workspace owner, I want the Tasks product to work without Google, Asana, or any other external account, so that external services are optional.
3. As the workspace owner, I want to create a Task manually, so that work that did not originate in a Transcript can still be managed.
4. As the workspace owner, I want Quick Add to require only a title, so that capturing a Task is fast.
5. As the workspace owner, I want a newly created Task to receive sensible defaults, so that I do not have to configure every field.
6. As the workspace owner, I want to add notes to a Task, so that the required context travels with the work.
7. As the workspace owner, I want an optional date-only due date, so that a Task can be scheduled without inventing a time.
8. As the workspace owner, I want none, low, medium, and high Task Priority values, so that I can distinguish urgency without a complex scoring system.
9. As the workspace owner, I want every Task to belong to exactly one Task List, so that organization stays simple and predictable.
10. As the workspace owner, I want Inbox to exist automatically, so that every Task always has a valid destination.
11. As the workspace owner, I want to create and rename Task Lists, so that I can organize work around my own categories.
12. As the workspace owner, I want safe handling when deleting a non-empty Task List, so that its Tasks are not silently lost.
13. As the workspace owner, I want to record a Responsible Person, so that responsibility is visible even though the application is single-user.
14. As the workspace owner, I want a Responsible Person to be the owner or a confirmed Person Profile, so that responsibility uses canonical identity.
15. As the workspace owner, I want Responsible Person to grant no access or notification rights, so that the field does not imply collaboration that does not exist.
16. As the workspace owner, I want to edit every mutable Task field, so that accepted work can evolve independently from its source.
17. As the workspace owner, I want to complete and reopen a Task, so that changing work state is reversible.
18. As the workspace owner, I want deleted Tasks to move to Trash first, so that accidental deletion is recoverable.
19. As the workspace owner, I want to restore a Task from Trash, so that its prior state and context are preserved.
20. As the workspace owner, I want permanent deletion to require an explicit action from Trash, so that destructive removal is deliberate.
21. As the workspace owner, I want open Tasks grouped into Overdue, Today, Upcoming, and No due date, so that the default view supports daily prioritization.
22. As the workspace owner, I want to search Task titles and notes, so that I can find work from remembered context.
23. As the workspace owner, I want to filter by Task List, Task Priority, Responsible Person, and External Task Link state, so that I can focus the view.
24. As the workspace owner, I want completed and trashed Tasks separated from open work, so that active planning remains uncluttered.
25. As the workspace owner, I want a Task to survive deletion of its source Meeting, Debrief, or Transcript, so that accepted work is not lost with evidence cleanup.
26. As the workspace owner, I want an unavailable source to be identified honestly, so that a broken source link is not mistaken for missing Task data.

### Action Item review and promotion

27. As the workspace owner, I want an Action Item to remain distinct from a Task until a decision is made, so that model suggestions are not silently promoted to commitments.
28. As the workspace owner, I want every Action Item to have a stable identity, so that regeneration and reordered model output do not corrupt review decisions.
29. As the workspace owner, I want to review a pending Action Item before creating a Task, so that I can correct model-inferred fields.
30. As the workspace owner, I want to edit the proposed title, notes, due date, priority, Task List, Responsible Person, and Task Destination during review, so that the promoted Task reflects my decision.
31. As the workspace owner, I want Create Task to produce an open Task, so that accepted future work enters my active list.
32. As the workspace owner, I want Create completed Task to record work that was already finished, so that the historical commitment is preserved without appearing open.
33. As the workspace owner, I want promotion to link the Action Item to exactly one Task, so that retries cannot create duplicates.
34. As the workspace owner, I want a promoted Task to snapshot the accepted proposal, so that later Debrief changes cannot rewrite it.
35. As the workspace owner, I want to edit a promoted Task independently, so that it can evolve without changing historical Debrief text.
36. As the workspace owner, I want a promoted Action Item to remain promoted even if its Task is later trashed or deleted, so that history is not rewritten.
37. As the workspace owner, I want to dismiss an Action Item immediately, so that irrelevant suggestions leave my pending queue quickly.
38. As the workspace owner, I want an Undo affordance after dismissal, so that an accidental review decision is recoverable.
39. As the workspace owner, I want dismissed Action Items visible in Debrief history, so that review decisions remain auditable.
40. As the workspace owner, I want to restore a dismissed Action Item to pending from its history, so that I can revisit a decision.
41. As the workspace owner, I want regenerated Action Items staged for review, so that regeneration never causes an automatic external write.
42. As the workspace owner, I want previous promoted and dismissed decisions preserved across regeneration, so that rerunning the model does not erase history.
43. As the workspace owner, I want a possible duplicate warning based on normalized title, Responsible Person, and due date, so that obvious duplicate work is visible.
44. As the workspace owner, I want duplicate detection to warn rather than block, so that I retain final control.
45. As the workspace owner, I want Action Item review available from Tasks, Meeting Wizard, and full Meeting Debrief, so that I can act from the context I am using.

### Automatic promotion

46. As the workspace owner, I want Stage all Action Items to be the default policy, so that enabling automation is deliberate.
47. As the workspace owner, I want an Automatically create my Tasks policy, so that high-confidence personal commitments can bypass staging.
48. As the workspace owner, I want automatic promotion limited to the first extraction for a Transcript, so that regeneration cannot duplicate Tasks.
49. As the workspace owner, I want automatic promotion limited to Action Items confidently assigned to my confirmed owner Profile, so that another person's work does not become mine.
50. As the workspace owner, I want unassigned and ambiguously owned Action Items to remain pending, so that uncertainty is reviewed rather than hidden.
51. As the workspace owner, I want other-person Action Items to remain pending, so that their commitments are not written into my external account automatically.
52. As the workspace owner, I want automatic promotion to create only open Tasks, so that automation does not invent completion.
53. As the workspace owner, I want possible duplicates to remain pending, so that automation cannot create an obvious duplicate.
54. As the workspace owner, I want automatic promotion to be retry-safe, so that restarts and transient failures do not create multiple Tasks.
55. As the workspace owner, I want the local Task committed before any external delivery, so that a provider outage cannot lose accepted work.
56. As the workspace owner, I want a warning before automatic promotion targets an external provider, so that automatic outbound writes are explicit.

### Meeting Debrief

57. As the workspace owner, I want a Debrief Run to complete after extraction and Action Item materialization, so that it does not remain artificially open for human review.
58. As the workspace owner, I want Meeting Debriefs to remain available indefinitely, so that historical meeting context does not expire.
59. As the workspace owner, I want pending Action Items to remain actionable indefinitely, so that age does not silently make a commitment disappear.
60. As the workspace owner, I want Debrief publication labeled Create email draft, so that the operation describes its actual effect.
61. As the workspace owner, I want the interface to state that creating a Gmail draft neither sends email nor creates Tasks, so that consequences are unambiguous.
62. As the workspace owner, I want recipient and roster validation to gate only the email draft, so that email uncertainty does not block Task review.
63. As the workspace owner, I want Task promotion to work without Gmail, so that local work management remains independent.
64. As the workspace owner, I want a successful draft action to offer Open draft in Gmail, so that I can finish and send it manually.
65. As the workspace owner, I want a failed Gmail draft operation to leave Task and Action Item state unchanged, so that unrelated state is not rolled back or duplicated.
66. As the workspace owner, I want Meeting and Debrief-index summaries to open the full Debrief, so that details are easy to reach.
67. As a keyboard user, I want clickable Debrief summaries and visible Open full Debrief links, so that navigation does not depend on pointer behavior.

### External Task Links

68. As the workspace owner, I want each Task to have at most one External Task Link, so that synchronization authority remains understandable.
69. As the workspace owner, I want Local only to be the default Task Destination, so that an external write never happens by accident.
70. As the workspace owner, I want a Task List to have an optional default Task Destination, so that repeated provider choices are convenient.
71. As the workspace owner, I want to override the destination during Task creation or promotion, so that exceptions do not require reconfiguring a list.
72. As the workspace owner, I want local title, notes, due date, and completion changes pushed to the linked provider, so that external views reflect the canonical Task.
73. As the workspace owner, I want external completion and reopening reflected locally when there is no competing change, so that checking off work in either supported surface is useful.
74. As the workspace owner, I want external title, notes, or due-date changes identified as External Task Drift, so that outside edits do not silently replace canonical content.
75. As the workspace owner, I want to restore the app version after drift, so that I can reassert canonical content.
76. As the workspace owner, I want to accept external values after drift, so that a deliberate provider-side edit can become canonical.
77. As the workspace owner, I want competing completion changes identified as a Task Link Conflict, so that neither side wins silently.
78. As the workspace owner, I want to resolve a Task Link Conflict with the app status or external status, so that the choice is explicit.
79. As the workspace owner, I want to remove an External Task Link without deleting either Task automatically, so that synchronization can end safely.
80. As the workspace owner, I want an externally deleted record marked missing while the local Task remains intact, so that provider deletion cannot erase local work.
81. As the workspace owner, I want to recreate a missing external record, so that synchronization can resume.
82. As the workspace owner, I want trashing a linked Task to ask whether the external record should also be deleted, so that destructive scope is explicit.
83. As the workspace owner, I want deleting the external record preselected when trashing a linked Task, so that the canonical Workspace decision is reflected by default.
84. As the workspace owner, I want an external deletion failure retained on the Task, so that I can retry without pretending it succeeded.
85. As the workspace owner, I want per-Task retry and Retry all failed links, so that transient failures are recoverable.
86. As the workspace owner, I want synchronization at startup, when Tasks opens, after local changes, every five minutes, and on Refresh, so that links stay useful without webhooks.
87. As the workspace owner, I want one failed link not to block another, so that provider problems stay isolated.
88. As the workspace owner, I want authentication failures to wait for reconnection instead of retrying continuously, so that the app does not create noise or provider load.

### Google Tasks and Asana

89. As the workspace owner, I want Google Tasks to be optional within the Google connection, so that Gmail, Calendar, Drive, YouTube, and Sheets do not require the Tasks scope.
90. As the workspace owner, I want the Google Tasks permission requested only when I enable that destination, so that authorization remains least-privilege.
91. As the workspace owner, I want denying Google Tasks permission to leave other Google capabilities connected, so that one optional feature does not break the rest of the app.
92. As the workspace owner, I want to choose a Google Task List as a destination, so that linked Tasks appear in the right external container.
93. As the workspace owner, I want the app to avoid importing unrelated Google Tasks, so that connection does not change the local source of truth.
94. As the workspace owner, I want to connect Asana with a personal access token, so that the first Asana version is usable without a managed OAuth application.
95. As the workspace owner, I want Check connection to identify my Asana user and available workspaces, so that configuration can be verified before use.
96. As the workspace owner, I want to select an Asana workspace, project, and optional section, so that outbound Tasks have a precise destination.
97. As the workspace owner, I want my Asana token hidden after storage and redacted from errors, so that credentials are not exposed.
98. As the workspace owner, I want Responsible Person to remain a local concept rather than an automatic Asana assignee mapping, so that identity is not guessed across systems.

### Meeting Wizard and briefings

99. As the workspace owner, I want Meeting Wizard to combine Editorial Ledger hierarchy, Day Spine metrics, and Quiet Rail restraint, so that the surface is information-rich without feeling like an admin console.
100. As the workspace owner, I want Today and This week as internal Meeting Wizard tabs, so that daily and weekly preparation are related but distinct.
101. As the workspace owner, I want Today at `/meetings` and This week at `/meetings/weekly`, so that each view is directly navigable and refresh-safe.
102. As the workspace owner, I want Today to show Today, This Week, Pending, Open, and Overdue metrics, so that the current workload is legible at a glance.
103. As the workspace owner, I want Tasks and pending Action Items displayed as separate groups, so that accepted work is not confused with proposed work.
104. As the workspace owner, I want compact surfaces capped at eight Tasks and eight Action Items with accurate totals and View all links, so that summaries stay concise without hiding scope.
105. As the workspace owner, I want Daily Briefing to read canonical Tasks and materialized pending Action Items, so that it no longer reconstructs a mixed action list from Runs.
106. As the workspace owner, I want Weekly Briefing to cover Sunday through Saturday in the Workspace timezone, so that the whole current week is represented.
107. As the workspace owner, I want Meetings grouped as Completed, In progress, and Upcoming by time, so that the weekly chronology is deterministic.
108. As the workspace owner, I want cancelled Meetings excluded, so that the briefing reflects real commitments.
109. As the workspace owner, I want Meetings with unavailable Briefs or Debriefs to remain visible with an honest source state, so that missing generation never hides the Meeting.
110. As the workspace owner, I want overdue Tasks, Tasks due this week, and pending Action Items in separate weekly sections, so that operational work remains deterministic and actionable.

### Weekly Summary and delivery

111. As the workspace owner, I want a short Weekly Summary, so that I can understand the week's meeting arc without reading every artifact.
112. As the workspace owner, I want completed Meetings summarized from their latest successful Debriefs, so that decisions and outcomes reflect retrospective evidence.
113. As the workspace owner, I want in-progress and upcoming Meetings summarized from their latest successful Briefs, so that the remaining week reflects current preparation.
114. As the workspace owner, I want the model input limited to approved Brief and Debrief projections, so that raw Transcripts and unrelated private evidence are not sent unnecessarily.
115. As the workspace owner, I want raw Transcripts, coaching, effectiveness evidence, full Person Profiles, diagnostics, Tasks, Action Item queues, and earlier Weekly Summaries excluded, so that the summary is bounded and does not recursively amplify sensitive content.
116. As the workspace owner, I want one paragraph of at most four short sentences and approximately 100 words, so that the Weekly Summary remains concise.
117. As the workspace owner, I want the deterministic Meeting groups to remain visible even when summary generation fails, so that the page is never model-dependent.
118. As the workspace owner, I want no model call when no qualifying Brief or Debrief exists, so that the app does not spend money to manufacture an empty summary.
119. As the workspace owner, I want the Summary persisted with its source revisions and fingerprint, so that unchanged input does not trigger repeated paid calls.
120. As the workspace owner, I want generation on first visit, at the start of Monday, after a quiet period following relevant changes, and on explicit regeneration, so that the Summary stays current without thrashing.
121. As the workspace owner, I want Task and Action Item changes not to regenerate the Weekly Summary, so that deterministic operational state does not cause model spend.
122. As the workspace owner, I want the last successful Summary preserved and marked stale when replacement fails, so that transient errors do not remove useful content.
123. As the workspace owner, I want an explicit Retry or Regenerate action, so that I can recover from a failed update.
124. As the workspace owner, I want the Monday owner-only email to include the current Summary and upcoming Meeting list, so that the weekly view reaches me proactively.
125. As the workspace owner, I want at most one successful weekly email, so that later changes do not create duplicate messages.

### Model configuration and migration

126. As the workspace owner, I want OpenRouter recommended by default, so that one key can access models from multiple providers.
127. As the workspace owner, I want `inception/mercury-2.5-preview` prefilled as the recommended model, so that setup has an explicit starting choice.
128. As the workspace owner, I want to edit the model or select another supported provider, so that bring-your-own-key remains flexible.
129. As the workspace owner, I want the exact provider and model disclosed before private Transcript-derived content is sent, so that cloud processing is informed.
130. As the workspace owner, I want model failures surfaced without silent provider or model fallback, so that cost and privacy boundaries do not change unexpectedly.
131. As the workspace owner, I want Ollama available under Advanced local-model settings, so that local processing remains possible without dominating first-run setup.
132. As the workspace owner, I want mock model behavior limited to tests and explicit demo mode, so that production cannot silently use fabricated output.
133. As the workspace owner, I want unhandled legacy action values migrated to pending Action Items, so that existing review work is retained.
134. As the workspace owner, I want dismissed legacy action values retained as dismissed history, so that prior decisions survive the cutover.
135. As the workspace owner, I want locally Done legacy action values migrated to completed native Tasks, so that completed work remains recorded.
136. As the workspace owner, I want app-created Google Task receipts migrated into native Tasks with External Task Links, so that existing provider records remain connected.
137. As the workspace owner, I want migration to ignore unrelated Google account Tasks, so that the new local store is not populated from an external inbox.
138. As the workspace owner, I want old Run files preserved as historical records, so that migration does not rewrite unrelated artifacts.
139. As the workspace owner, I want migration to be idempotent and restart-safe, so that interruption cannot create duplicate Tasks or Action Items.
140. As the workspace owner, I want one production cutover without legacy dual-write, so that there is only one post-migration source of truth.

## Implementation Decisions

### Domain ownership and terminology

- The product remains a local-first, single-user Workspace. Responsible Person records expected responsibility; it does not create another application user.
- Task is the durable, canonical Workspace record of accepted work.
- Action Item is a generated proposed commitment that remains distinct from a Task until promotion.
- Task List is the one named local collection to which each Task belongs.
- External Task Link is the relationship between one canonical Task and one Google Tasks or Asana representation.
- Task Destination is the optional external container used when creating an External Task Link.
- Task Link Conflict means both sides changed completion state since the last successful synchronization.
- External Task Drift means the external title, notes, or due date changed without being accepted by the Workspace.
- Action Item Policy is either Stage all Action Items or Automatically create my Tasks.
- Weekly Summary is the bounded model-generated paragraph inside Weekly Briefing, not the entire Weekly Briefing.
- Home is not called a dashboard. Task is not used as a synonym for Run or Action Item. Responsible Person is not called an assignee in the Workspace domain.

### Information architecture

- The five top-level product areas are Content Engine, Content Research, Person Profiles, Meeting Wizard, and Tasks.
- Tasks uses `/tasks`. Home remains `/`; Settings remains `/settings`; technical Run surfaces remain outside normal product navigation.
- Tasks has Open, Action Items, Completed, Trash, and Task Lists views.
- Meeting Wizard has route-backed Today and This week tabs. Today uses `/meetings`; This week uses `/meetings/weekly`.
- The This Week metric on Today links to the full weekly route. Today may show a compact weekly preview but does not duplicate the full weekly view.
- Full Tasks views are not capped. Home and Meeting Wizard projections show at most eight Tasks and eight Action Items, preserve accurate totals, and provide View all links.

### Task schema and behavior

- Every Task has a stable identity, title, notes, open or completed status, optional date-only due date, Task Priority, one Task List, optional Responsible Person, optional source, optional External Task Link, and relevant created, updated, completed, trashed, and deleted timestamps.
- Task Priority is none, low, medium, or high. It remains local and is not mapped to provider-specific priority fields.
- Dates are interpreted as calendar dates in the Workspace timezone.
- Inbox always exists and is the default Task List.
- A Task List may define one default Task Destination. Local only is the default.
- Changing a list default affects newly created or promoted Tasks only. An individual Task may override the destination during creation or promotion.
- Manual Tasks default to Inbox, the confirmed workspace owner, no priority, no due date, and the selected Task List's destination.
- Quick Add requires only a title; an expanded form exposes all supported fields.
- A completed Task may be reopened. Deletion first moves a Task to Trash. Permanent deletion is available only from Trash after explicit confirmation.
- A non-empty Task List cannot be deleted ambiguously; the owner must move or delete its Tasks.
- Search covers title and notes. Filters cover Task List, priority, Responsible Person, and External Task Link state.
- Open Tasks group as Overdue, Today, Upcoming, and No due date. Within a group, due date sorts first, then high, medium, low, and no priority, then oldest creation time.
- An exact normalized title, Responsible Person, and due-date match produces a Possible duplicate warning but never blocks a manual decision.
- A Task snapshots accepted fields and survives source deletion or Clear generated data. When the source is gone, its source link reports that it is unavailable.

### Action Item lifecycle

- Extraction materializes Action Items with stable identities independent of array position.
- Each Action Item retains its source Meeting, Meeting Debrief, Transcript, extraction revision, evidence references, proposed Task fields, state, decision timestamps, promotion link, idempotency identity, and duplicate-comparison fields.
- Action Item states are pending, promoted, or dismissed.
- Each pending Action Item exposes Create Task, Create completed Task, and Dismiss.
- Both creation actions open the same review panel and allow every Task creation field to be edited before confirmation.
- Promotion atomically creates one local Task and records its stable identity on the Action Item. Repeating the same request cannot create another Task.
- Create completed Task starts the local Task completed. If externally linked, the provider create-and-complete sequence remains one recoverable synchronization operation.
- A promoted Action Item cannot be unpromoted. Trashing or deleting its Task does not rewrite Action Item history.
- Dismiss is immediate and offers a temporary Undo. Dismissed Action Items remain visible and can later be restored to pending from Debrief history.
- Regeneration creates or reconciles proposal revisions without editing or deleting a promoted Task. New regenerated proposals always remain staged.

### Automatic promotion

- Stage all Action Items is the default policy.
- Automatically create my Tasks applies only to the first extraction for a Transcript and only when Responsible Person resolves confidently to the confirmed owner.
- Automatic promotion creates an open Task only, uses the configured Task List and destination, commits locally before external delivery, and is idempotent across retries.
- Unassigned, ambiguously owned, other-person, regenerated, and possible-duplicate Action Items stay pending.
- Enabling automatic promotion for a list with an external destination requires an explicit warning and confirmation.

### Meeting Debrief refinements

- A Debrief Run completes after successful extraction and Action Item materialization. It does not remain blocked on later human review.
- Meeting Debriefs and pending Action Items never expire. Age may alter visual emphasis only.
- Creating the Gmail draft remains an explicit, recipient-gated operation indefinitely.
- The operation is labeled Create email draft. Supporting copy is: “Creates a Gmail draft for the confirmed recipients. It does not send the email or create Tasks.”
- Success exposes Open draft in Gmail.
- Recipient and roster validation gate only email-draft creation. Task review and promotion are independent of Gmail and recipient state.
- Email-draft creation never creates, changes, completes, or dismisses a Task.
- The old Publish draft and Tasks wording and its bulk Task side effect are retired.
- Debrief summary blocks on the Meeting page and Debrief index open canonical Debrief detail and retain a visible Open full Debrief link.

### Persistence and service boundaries

- Tasks, Task Lists, Action Items, External Task Links, and Weekly Summaries are atomic file-backed Workspace resources. This release introduces neither a database nor a Task event log.
- The Tasks module owns Task CRUD, query, promotion, list management, Trash, and connector semantics behind one deep application interface.
- Meeting Debrief produces Action Items but does not own promoted Tasks.
- Meeting Wizard owns the Weekly Briefing reader across Meetings, Meeting Briefs, Meeting Debriefs, Tasks, and Action Items. It does not acquire ownership of those records.
- The Shell retains provider credential custody and production composition responsibilities.
- Provider SDK and request types do not enter the Task domain.
- The assembled application API is the primary behavioral test seam. The file store, connector adapters, and browser are narrower boundary seams used only for guarantees that the API seam cannot establish well.

### External Task Link semantics

- A Task has at most one External Task Link.
- The connector contract supports create, update title/notes/due date, set open/completed state, read supported content and state, detect missing records, delete, and return provider identity, URL, sanitized failures, and change metadata.
- Local Task persistence always completes before an external provider mutation is attempted.
- Local title, notes, due date, and completion changes push outward.
- External completion or reopening updates the local Task only when there is no competing local status change.
- External title, notes, or due-date changes produce External Task Drift and expose Restore app version, Use external values, and Remove link.
- Competing completion-state changes produce Task Link Conflict and expose Use app status, Use external status, and Remove link.
- Drift and conflict remain unresolved until the chosen operation succeeds.
- An externally missing record leaves the local Task intact and exposes Recreate and Remove link.
- Trashing a linked Task asks whether to delete the external record or preserve it and unlink. Delete external record is preselected.
- External deletion failure leaves the Task in Trash with failed link state and retry. Permanent local deletion remains possible after explicit warning.
- Removing a link or provider connection never deletes the local Task or remote record implicitly.
- Link states are waiting, synchronized, failed, missing, conflicted, and changed externally.
- Synchronization runs at application startup, when Tasks opens, after a linked local change, every five minutes while relevant links exist, and on explicit Refresh.
- Polling is limited to active links and recently changed completed links. The application never scans an entire provider account.
- Authentication failures pause automatic retry until reconnection. Other transient failures remain background- and manually-retryable. One failed link never blocks another.

### Google Tasks

- Google Tasks is optional within the existing Google connection.
- Other Google surfaces work without the Tasks scope. That scope is requested only when Google Tasks is enabled as a Task Destination.
- Denied or missing Tasks permission is destination-specific state, not a general Google disconnection.
- The owner selects a Google Task List destination.
- Google External Task Links implement the common create, read, update, complete, reopen, missing, delete, retry, drift, and conflict behavior.
- Connecting or refreshing never imports unrelated account Tasks.

### Asana

- The first Asana integration uses a person-supplied personal access token. OAuth is deferred.
- The full token is stored through the existing credential boundary, is never returned to the UI after storage, and is redacted from logs and diagnostics.
- Check connection identifies the authenticated user and accessible Asana workspaces.
- An Asana Task Destination selects workspace, project, and optional section.
- Asana implements the same observable connector contract as Google Tasks.
- Responsible Person is not mapped to an Asana assignee. When responsibility belongs to another person, their name may be included in notes without changing the Task title.

### Meeting Wizard and Daily Briefing

- Production Meeting Wizard combines Editorial Ledger hierarchy and chronology, Day Spine's top metric strip, and Quiet Rail's whitespace, typography, restrained colors, and thin separators.
- Dense cards, heavy shadows, admin-style Run concepts, and prototype-only route switches do not survive production promotion.
- Today shows Today's Meetings, the Daily Briefing summary, metrics for Today, This Week, Pending, Open, and Overdue, plus compact canonical Task and pending Action Item groups.
- Pending Action Items and Tasks remain distinct. Each item links to its canonical surface.
- Daily Briefing reads canonical Tasks and materialized Action Items. It includes overdue open Tasks, Tasks due today, high-priority open Tasks, and pending Action Items requiring review.
- Failed and conflicted External Task Link counts remain visible even when their individual Tasks fall beyond a compact list limit.

### Weekly Briefing

- This week covers the full Sunday-to-Saturday week in the Workspace timezone.
- Cancelled Meetings are excluded.
- Completed means `endAt` is at or before now and sorts most recent first. In progress means now is between `startAt` and `endAt` and sorts by start. Upcoming means `startAt` is after now and sorts by start.
- Missing Briefs or Debriefs do not hide Meetings. The UI distinguishes unavailable, preparing, and failed source states where applicable.
- Overdue Tasks, open Tasks due before the end of Saturday, and pending Action Items appear as separate deterministic sections.
- Task and Action Item changes update those sections immediately and do not regenerate the Weekly Summary.

### Weekly Summary

- For a Completed Meeting, input uses the latest successful Debrief's Meeting title/date, summary, decisions, retained Action Items, and open questions.
- For an In-progress or Upcoming Meeting, input uses the latest successful Brief's Meeting title/date, summary, concise agenda/topics, confirmed preparation points, and explicit uncertainties.
- Raw Transcripts, effectiveness evidence, coaching advice, full Person Profiles, detailed Person Evidence, diagnostics, Tasks, pending Action Items, and another Weekly Summary are excluded. Supplied text is untrusted data, never instructions.
- Output is one paragraph, no more than four short sentences, and approximately 100 words. It reports supported completed outcomes/themes, firm decisions or unresolved issues, the remaining week, and preparation focus without generic advice or unsupported claims.
- If only one side of the week has source content, the Summary describes only that side. If no usable Brief or Debrief exists, no model call occurs and the UI states: “No Brief or Debrief content is available yet.”
- The deterministic Meeting list remains visible independently and reports source coverage.
- Each persisted Summary stores week identity, source artifact identities and revisions, deterministic fingerprint, text, generation time, provider, model, and stale or failed-replacement state.
- Generate on first Weekly-tab visit when no matching Summary exists, on Monday after the week starts, fifteen minutes after the latest relevant Meeting/Brief/Debrief change, and immediately on explicit Regenerate summary.
- The same unchanged fingerprint never spends another model call after reopen or restart.
- During the quiet period or replacement failure, the last successful Summary remains visible as Being updated or Update failed. Retry summary is available.
- The Monday owner-only email includes the current Summary and deterministic Upcoming Meeting list and succeeds at most once per week. Later Meeting completion updates the tab but sends no second email.

### Model onboarding

- Customer configuration remains bring-your-own-key.
- OpenRouter is the recommended default provider because one key can access models from multiple providers.
- The recommended editable model is exactly `inception/mercury-2.5-preview`.
- The owner confirms the exact provider and model and supplies a key before private Transcript-derived cloud processing.
- Existing supported cloud providers remain available. Ollama appears under Advanced local-model settings. Mock is limited to tests and explicit demo mode.
- Model failure is surfaced. No provider or model fallback occurs silently.
- The Debrief Prompt Eval Gate's fixed evaluation model remains independent from the customer default.

### Migration and cutover

- Migration maps unhandled legacy action values to pending Action Items, dismissed values to dismissed Action Item history, locally Done values to completed native Tasks, and app-created Google receipts to native Tasks with Google External Task Links.
- When Google is available, migration refreshes current status for app-created receipts. When it is unavailable, the local record is still created with recoverable link state.
- Migration never lists or imports unrelated Google account Tasks.
- Old Run files remain unchanged and readable.
- Migration is idempotent and restart-safe and cannot create duplicate Tasks, Action Items, or external records.
- Promoted Tasks survive source deletion and Clear generated data.
- Production performs one cutover. New writes use canonical Task and Action Item stores; legacy positional Done, Dismiss, drop alias, bulk Google creation, and receipt dual-write paths are retired.

### Failure and accessibility behavior

- A local Task operation succeeds or fails based on the Workspace write, never on an external provider.
- Provider credentials and raw provider response bodies are never exposed as UI errors.
- A failed Task promotion write changes neither the Action Item nor an external provider.
- A failed Weekly Summary generation leaves deterministic data and the last good Summary usable.
- A failed email draft never rolls back Task decisions.
- All Task and Action Item controls are keyboard reachable. Review panels move focus to the first field and return it to the originating item on close.
- Status changes use polite live regions; immediate actionable errors use alerts. Color is never the only status indicator.
- Tabs use consistent accessible tab or route-link semantics. Loading, empty, stale, failed, missing, and disconnected states include explanatory text.
- Destructive external and permanent local deletion choices require clear confirmation.

## Testing Decisions

Tests assert observable behavior and durable contracts, not internal helper calls, private data shapes, CSS implementation, or provider SDK mechanics. The primary seam is the assembled Fastify application through `app.inject`, using a real temporary Workspace and deterministic fake LLM, Gmail, Google Tasks, and Asana boundaries. Direct store tests are reserved for atomicity, corruption, restart, and migration properties. Shared adapter conformance tests prove provider mappings. A small Playwright suite proves only essential routed and accessible user journeys.

Existing Fastify injection tests for people, migration, Google connection, and Weekly Briefing are the API prior art. Existing temporary-Workspace repository tests are the persistence prior art. Existing injected provider adapters and deterministic `CompleteJson` tests are the connector and model prior art. Existing Meeting Wizard browser, accessibility, and reflow suites are the user-journey prior art.

### Assembled API seam

#### Native Tasks

- Create a minimal manual Task and verify Inbox, owner, open state, no due date, no priority, stable identity, source, and timestamps.
- Create a fully specified Task and verify every supported field survives application restart.
- Reject blank title, invalid date, priority, Task List, or Responsible Person without partial persistence.
- Edit each mutable field while preserving stable identity, source, creation time, and external-link identity.
- Complete and reopen idempotently with correct completion timestamps.
- Trash, restore, and permanently delete through the allowed states only.
- Create and rename Task Lists; preserve Inbox; reject ambiguous non-empty-list deletion.
- Apply Task List defaults to Quick Add and promotion while allowing an explicit per-Task override.
- Search title and notes and combine Task List, priority, Responsible Person, and link-state filters.
- Classify Overdue, Today, Upcoming, and No due date correctly in the Workspace timezone, including date-only values near UTC boundaries.

#### Action Items and policy

- Materialize stable Action Item identities independent of array position.
- Return editable proposed fields without mutating original Debrief text.
- Promote to one open or completed Task and make repeated promotion requests idempotent.
- Snapshot accepted source fields and preserve the Action Item-to-Task relationship across Task edits and restart.
- Prevent unpromotion while retaining history after Task Trash or deletion.
- Dismiss, Undo, and later restore without creating a Task or provider record.
- Regenerate without changing promoted Tasks or prior decisions; stage all new proposal revisions.
- Detect the exact normalized duplicate tuple, stage it with a warning, and allow explicit override.
- Verify Stage all as the default.
- Under Automatically create my Tasks, promote only first-extraction, confirmed-owner items to open Tasks.
- Keep unassigned, ambiguous, other-person, regenerated, and possible-duplicate items pending.
- Prove local-first automatic promotion when the external provider fails.

#### Meeting Debrief decoupling

- Complete the Run immediately after extraction and Action Item materialization.
- Preserve Debriefs and pending Action Items without time-based expiry.
- Prove Create email draft calls Gmail without any Task or Action Item mutation.
- Gate only Gmail on invalid recipients or roster state while leaving Task actions available.
- Return a Gmail draft identity for Open draft in Gmail and never report the draft as sent.
- Preserve Debrief and review state after Gmail failure and retry without duplicate Task effects.
- Keep old Runs readable while preventing legacy publication endpoints from recreating bulk Task behavior.

#### Shared External Task Link contract

- Enforce at most one link per Task.
- Persist locally before provider creation and retain a failed local Task when creation fails.
- Store provider identity, destination, remote identifier, URL, synchronization baseline, and link state after success.
- Retry a failed link without creating a second local Task or duplicate remote record.
- Push supported local content and completion changes outward.
- Apply external completion and reopening when only the external side changed.
- Detect external content drift without silently overwriting local content.
- Resolve drift using Restore app version, Use external values, and Remove link.
- Detect competing completion changes and resolve with app status, external status, or link removal.
- Preserve the local Task after remote deletion and support Recreate and Remove link.
- Exercise both linked-Task Trash choices and external-deletion failure recovery.
- Verify startup, Tasks-open, post-local-change, five-minute, and explicit Refresh triggers share idempotent behavior.
- Prove Retry all affects failed links only and that one link failure does not block others.

#### Google Tasks

- Connect and use non-Tasks Google surfaces without the Tasks scope.
- Request the additional scope only when Google Tasks is enabled.
- Preserve other Google connections after Tasks permission denial or disablement.
- Validate and use the chosen Google Task List.
- Prove that connection, refresh, and synchronization never import unrelated account Tasks.
- Refresh app-created legacy receipts only.

#### Asana

- Store and redact a personal access token and never return it in settings or diagnostics.
- Check a valid connection and enumerate the authenticated user and accessible workspaces.
- Return an actionable invalid-token error without affecting local Tasks.
- Scope Projects to Workspace and sections to Project, and reject a destination that becomes inaccessible.
- Map supported title, notes, due date, and completion fields through the shared contract.
- Prove Responsible Person does not become an implicit Asana assignee.

#### Daily and Weekly deterministic reads

- Read canonical Tasks and distinct pending Action Items instead of legacy Run receipts.
- Compute Home Open, Overdue, Pending, and failed/conflicted counts while excluding completed, dismissed, and trashed records as appropriate.
- Enforce compact eight-item limits while preserving totals and View all targets.
- Compute a full Sunday-to-Saturday week in multiple Workspace timezones.
- Classify Completed, In progress, Upcoming, and cancelled Meetings at exact start/end boundaries.
- Keep Meetings visible with explicit missing, preparing, or failed source states.
- Select the latest successful Brief or Debrief rather than a newer failed Run.
- Return overdue Tasks, due-this-week Tasks, and pending Action Items as separate sections.
- Update deterministic sections immediately without scheduling a Summary because Task state changed.

#### Weekly Summary and email

- Record the exact bounded projection sent for completed and upcoming Meetings.
- Prove raw Transcripts, coaching, effectiveness evidence, full Profiles/evidence, diagnostics, Tasks, pending Action Items, and prior Summaries are absent.
- Enforce one paragraph, four-sentence, approximately 100-word result constraints through the established strict result policy.
- Skip the model call and return the specified empty state when no qualifying artifact exists.
- Persist source IDs/revisions, fingerprint, generation time, provider, and model.
- Generate on first visit, Monday, after the fifteen-minute quiet period, and explicit regeneration.
- Reuse an unchanged fingerprint across reopen and restart.
- Ignore Task and Action Item changes when computing the Summary fingerprint.
- Retain the last successful Summary and mark it stale after timeout, provider error, malformed output, or invalid output.
- Prove explicit provider/model selection and no silent fallback.
- Require and persist exact provider/model consent before private Transcript-derived cloud requests.
- Verify the Monday email is owner-only, includes the Summary and upcoming list, succeeds at most once, and remains retryable after failure.

### Persistence and migration seam

- Round-trip every Task, Action Item, Task List, External Task Link, and Weekly Summary field across process restart.
- Prove stable identities do not depend on ordering or current source presence.
- Simulate successful atomic replacement and failed writes that preserve the previous valid state.
- Treat invalid persisted data as explicit corruption rather than an empty store.
- Preserve Tasks when a source is unavailable or generated data is cleared.
- Preserve Action Item state and promotion relationships across restart without rewriting extracted text.
- Persist synchronization baselines and every link state without storing provider secrets in Task records.
- Migrate unhandled, dismissed, locally Done, and Google-receipt legacy fixtures separately.
- Exercise Google available, unavailable, open, completed, missing, and authentication-failure migration cases.
- Prove unrelated provider Tasks are never listed or imported.
- Preserve old Run files byte-for-byte.
- Run migration twice and resume a partially interrupted migration without duplicate local or external records.
- Prove post-cutover Task changes do not write legacy positional review or receipt state.

### Adapter conformance seam

Run one shared provider contract against Google Tasks and Asana fakes:

- canonical create mapping;
- supported content update mapping;
- remote complete and reopen;
- supported content/status read projection;
- missing-record classification;
- remote deletion;
- provider identifier and URL preservation;
- authorization, rate-limit, validation, network, and not-found error classification;
- credential and sensitive-header redaction;
- side-effect-free repeated reads;
- no provider call for an unlinked Task.

Provider-specific tests cover only provider-specific destination fields, permissions, and error payloads.

### LLM contract seam

- Use a recording deterministic fake rather than live OpenRouter calls.
- Verify exact included and excluded Weekly Summary inputs.
- Verify configured provider and exact model reach the completion boundary.
- Reject malformed structured output and content outside the bounded shape.
- Preserve the last good result after every replacement failure category.
- Make no model call when source material is empty or the fingerprint is unchanged.
- Run the existing Debrief Prompt Eval Gate only if the Debrief extraction prompt, Result Shape, or Goldens change.

### Browser journey seam

- Navigate to Tasks at `/tasks`, refresh safely, and verify the Open, Action Items, Completed, Trash, and Task Lists structure.
- Quick Add a title-only Inbox Task with keyboard-accessible focus behavior.
- Edit full Task details, complete it, find it in Completed, reopen it, Trash it, and restore it.
- Combine search and filters and clear them.
- Review a pending Action Item, edit proposed fields, promote it to an open Task, and reach the resulting Task.
- Promote another Action Item to a completed Task.
- Dismiss and Undo an Action Item and expose a possible-duplicate warning without implying automatic creation.
- Open full Debrief from both required summary surfaces.
- Block email draft creation on invalid recipients while leaving Task promotion usable.
- Verify the exact Create email draft copy and Open draft in Gmail success action.
- Navigate and refresh the Today and This week routes with accessible tab or route-link semantics.
- Verify Today metrics, separate compact Task/Action Item groups, limits, totals, and View all links.
- Verify Weekly Summary, Meeting groups, Task sections, Action Item section, missing-source states, stale-summary state, regeneration, and empty-source copy.
- Verify Home Task counts and links.
- Configure Google Tasks opt-in without disturbing other Google surfaces.
- Configure and redact Asana connection settings.
- Switch Action Item Policy with the required external-write warning.
- Verify OpenRouter and `inception/mercury-2.5-preview` defaults and exact cloud-consent disclosure.
- Cover keyboard access, focus restoration, live regions, non-color status indicators, narrow viewport behavior, and explanatory empty/error states.

### Required verification gates

- Run the narrowest relevant Vitest files while changing each seam.
- Run `npm run typecheck` after shared contract changes.
- Run `npm run check` before each completed implementation slice.
- Run `npm run check:all` for the completed product flow.
- Build and boot the production image and verify `/api/health`, because server composition, web assets, provider configuration, and runtime dependencies change.
- Run the Debrief Prompt Eval only when its prompt, Result Shape, or Goldens change.

## Out of Scope

- Multi-user accounts, permissions, shared Workspace state, or collaborative editing.
- Provider-account identity mapping for Responsible People.
- Subtasks, recurring Tasks, reminders, attachments, dependencies, comments, time estimates, Projects, or tags.
- General bulk editing; only Retry all failed links is included.
- A general-purpose integration framework beyond the narrow Task connector contract.
- Trello in the first release. It remains a possible later adapter after Google and Asana prove the contract.
- A generic Intake Wizard, automation builder, or changes to the app's existing fixed automations.
- Model-based semantic Task deduplication.
- Automatic model switching or fallback.
- Provider webhooks or a hosted webhook relay.
- Full bidirectional synchronization of external title, notes, due date, container, project, or assignee changes.
- Importing arbitrary Google Tasks or Asana Tasks.
- A new database or Task event log.
- A Friday recap email or repeated Weekly Briefing emails as Meetings complete.
- Live Google, Asana, or OpenRouter credentials in automated CI.
- Deterministic assertions about Mercury prose quality.
- Pixel-perfect screenshot assertions for the Quiet Rail influence.
- Broad load testing beyond preventing duplicate concurrent synchronization operations.

## Further Notes

- This specification intentionally changes the previously accepted Google-as-system-of-record decision. ADR-0052 through ADR-0061 record the new canonical Task, promotion, persistence, migration, synchronization, automatic policy, cutover, Weekly Briefing, and non-expiry decisions.
- The implementation may be delivered in internal slices, but it is not complete until the native Task lifecycle, Action Item cutover, Debrief decoupling, Weekly Briefing, Google contract, Asana contract, model onboarding, migration, and production-composition gates pass together.
- The recommended implementation order is: shared contracts; atomic stores; migration; local Task API and UI; stable Action Items and policy; Debrief decoupling; canonical Daily Briefing reads; Meeting Wizard visual promotion; Weekly Briefing and Summary; optional Google Tasks; Asana; model onboarding; final cutover and legacy retirement.
- Issue #117 remains authoritative for unrelated consolidated-product behavior. This specification supersedes its Task-output, Debrief-expiry, product-count, and inline-Weekly-Briefing decisions.
- The pending live Workspace cutover must not run until this specification is implemented, verified, and separately authorized by the owner.
- No application implementation is authorized merely by creating or publishing this specification.
