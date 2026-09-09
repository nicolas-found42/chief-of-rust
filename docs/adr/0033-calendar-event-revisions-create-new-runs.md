# Calendar event revisions create new Runs

Each Meeting Brief Generator Run binds to one version of one Calendar event. If a material change
arrives after that Run finishes but before the meeting starts, the Intake creates a new Run linked
to the earlier one; the new Run supersedes the earlier brief for presentation and delivery without
rewriting its history. Reopening a completed Run was rejected because its result and event log would
no longer describe the inputs from which the original brief was produced.

A change is material when it changes an input consumed by the brief or its delivery: title,
description, start or end time, location, conference link, attached Docs, organizer, guest identity,
guest list or invitation response. A Calendar version that changes only unused metadata does not
create a revision Run.

Cancellation is an eligibility change, not a material revision. The Intake removes a future
candidate without creating a Run; an active Run rechecks Calendar before its outward write and ends
`skipped`; a completed Run remains historical while the Module presents the meeting's current state
as cancelled.

## Consequences

The Module must record the Calendar event identity and version on every Run, deduplicate repeated
push notifications for the same version, and link a revision Run to the Run it supersedes. Runs and
their outputs remain readable, but Module views must identify the latest revision so a person does
not act on an obsolete brief.
