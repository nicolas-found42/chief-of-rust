# Content and meeting products share Workspace resources without sharing workflow state

The consolidation introduces four product areas—Content Engine, Content Research, Person Profiles
and Meeting Wizard—while keeping each workflow's Runs and result shape separate. Person Profiles
and the Transcript Catalog are Workspace-owned resources behind shared interfaces; Content Project,
Content Research, Meeting Brief and Meeting Debrief consume exact revisions or decisions without
owning canonical identity or transcript processing. Product navigation is therefore explicit rather
than derived from the Module registry.

## Considered Options

- **Put Content Research and Person Profiles inside Content Engine.** Rejected because monitoring
  policy and canonical identity are reusable outside content creation, especially in meetings.
- **Merge Brief and Debrief into one meeting lifecycle.** Rejected because prospective Calendar
  preparation and retrospective transcript actions have different inputs, waits, outputs and retry
  behavior.
- **Retain Content Packs and Idea Engine as legacy modes.** Rejected because the pre-access cutover
  deliberately removes their local state and replaces their output contracts rather than carrying
  two generations of product behavior.

## Consequences

The cutover deletes all local product state and non-authentication configuration while preserving
provider authentication. Content Scout's independent Source Adapter collection and opportunity
discovery survive, but its 23-output Content Pack and Notion publication contract do not; this
supersedes those portions of ADR-0028 and ADR-0041 while retaining their immutable shared-input and
independent-sibling principles. ADR-0034's owner-only Meeting Brief delivery remains, with Eligible
Meetings expanded to internal meetings that include another attendee. ADR-0037, ADR-0038, ADR-0039
and ADR-0042 remain binding.
