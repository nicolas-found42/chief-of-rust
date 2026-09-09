# The Workspace owns a durable Meeting

The Meeting Wizard linked a Meeting Brief to a Meeting Debrief only at read time, and could not
link them at all in practice: nothing in production ever associated a Transcript with a Calendar
occurrence, and Calendar was read forward only, so the app had forgotten a meeting by the time its
transcript arrived. We will instead make the Meeting a durable Workspace resource. Every timed
Calendar occurrence with at least one other attendee becomes a Meeting; a Meeting survives after
its start time passes and after Calendar stops reporting the event; and a Meeting may exist with no
Calendar occurrence at all, when only a Transcript attests that the meeting happened.

The Meeting has its own identity. The Calendar occurrence key is an attribute it carries, never its
address, because a Meeting created from a Transcript has no occurrence key to be addressed by.

This supersedes one line of ADR-0043 and no more. That ADR rejected "merge Brief and Debrief into
one meeting lifecycle" because "prospective Calendar preparation and retrospective transcript
actions have different inputs, waits, outputs and retry behavior". That reasoning still holds and
is preserved: the two Runs stay separate, retry separately and wait separately. What merges is the
record of the meeting and the surface that presents it, not the workflows that fill it.

## Considered Options

- **Keep the read projection and join at read time.** Rejected on the evidence: Calendar's forward
  window is now to now plus ninety days, and the occurrence is not retained once it is past. A
  projection over Calendar has nothing to read from at exactly the moment a Debrief needs it.
- **Give the Meeting a lifecycle status that both Modules write.** Rejected twice over. Most of
  such a status is derived from Run state, so it would duplicate a fact and then drift from it; the
  rest invites two Runs on different schedules to race for one field. The Meeting therefore holds
  only what no Run owns: the occurrence facts, the participants, and what a person supplies.
- **Create a Meeting only for an Eligible Meeting.** Rejected because it manufactures the duplicate
  it was meant to prevent. A meeting the owner declined but attended is ineligible, so no Meeting
  would exist; its Transcript would then create a second, calendar-less Meeting for an event
  Calendar knew about all along.

## Consequences

Eligible Meeting stops naming a kind of thing and becomes a test a Meeting passes to earn a Meeting
Brief. An ineligible Meeting is still a Meeting, and its page states which test it failed.

Calendar history must be collected backwards, once, as far as the oldest Transcript reaches. The
existing `calendar.readonly` scope already permits this and the Transcript Catalog already computes
the bound, so the data sets its own horizon rather than a chosen number. Meeting history therefore
begins at the oldest Transcript, and the app must say so rather than show empty weeks before it.

Associating a Transcript with a Meeting is new work, not a wiring-up of something that already
runs. The signal available is weaker than it first appears: real transcript exports carry a title
and speaker names, and may carry no timestamp at all, so the match rests on title, speaker names
and file modification time rather than on a start time.

A Meeting that no Transcript and no Calendar occurrence can be matched to is a real state, and the
app resolves it by offering the near-miss occurrences for merge rather than by asking anyone to
search.
