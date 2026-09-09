# Meeting Briefs auto-send only to the owner

The Meeting Brief Generator's Gmail Output Adapter automatically sends each deliverable Meeting
Brief to the workspace owner's connected Google identity. This is a deliberate exception to the
app's draft-only Gmail policy: a briefing that waits unnoticed in Drafts does not preserve Relay's
proactive product promise. The recipient is fixed from the Google connection and cannot be supplied
by event data, Module input or model output; the Module never sends to External Guests.

The first completed Meeting Brief sends immediately. A revision waits for a five-minute quiet
period, reset by each newer material Calendar change; only the latest revision sends. When the
meeting starts within five minutes, the latest revision bypasses the wait and sends immediately.

## Consequences

The Google connection must request Gmail delivery authority in addition to the read authority that
enrichment requires, and the current structural ban on Gmail sending must be narrowed to Modules
that remain draft-only. The `deliver` Stage must recheck that the event is still an Eligible Meeting
and must make retries and revision delivery explicit so an automatic external write cannot silently
duplicate or send an obsolete brief.
