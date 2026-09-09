# A Meeting Debrief waits for a person, and expires rather than sending

An Executive Assistant Run holds its Meeting Debrief and writes nothing outward until the workspace
owner approves it. The Run goes `blocked` against a wait record, resumes when the person approves or
regenerates, and expires after thirty days. Expiry ends the Run as `skipped`; it never sends
anything the person did not look at.

This is the first time `blocked` is spent on a human. ADR-0004 pre-authorised it in as many words —
"if a Module ever needs 'stopped, waiting for a human', `blocked` is added to this shared set as a
considered change" — and ADR-0020 then designed the wait itself, with two ways to resume and no
third mechanism. A person approving in the app resumes by the second way: the Module tells the Shell
to resume the Run.

## Considered options

- **Finish the Run and create the Gmail draft immediately, editable afterwards.** Rejected: the
  Gmail draft adapter creates and does not update, so this needs a new outward-writing capability,
  and between creation and review the draft in Gmail disagrees with the debrief in the app.
- **Finish the Run, write nothing, and make delivery a separate button.** This is Content Scout's
  shape for Source Suggestions, and it was rejected here for a different reason than it was accepted
  there: a Source Suggestion accumulates across Runs in a persistent view, whereas a Meeting Debrief
  belongs to exactly one Run. Leaving it as an unstarted button also makes the Module wholly passive
  — nothing ever reaches the person unless they remember to go and look.
- **Wait indefinitely.** Rejected on the evidence ADR-0020 already gathered: 84 of 115 Daily Hot Take
  Relay executions ended parked at "Wait started" because the pause was configured never to time out.
  That is forgotten configuration, not design intent, and repeating it here would fill Home with
  debriefs nobody will ever act on.
- **Send on expiry rather than skipping.** Rejected: it reintroduces the unreviewed outward write
  that the whole approval step exists to prevent, and it does so precisely when the person has
  demonstrated they are not paying attention.

## Consequences

Expiry is cheap because it destroys nothing. Runs are the log, so an expired Run still holds its
Meeting Debrief and it stays readable in the Module's tab; what expiry withholds is the Gmail draft
and the Google Tasks, not the work. A person who returns after a month finds the debrief, just not a
draft they never asked for.

Because delivery and action items are both outward writes gated on the same approval, they run as
two Stages rather than one, and the Gmail draft goes first. A single Stage that created the draft and
then failed on Tasks would have already written outward while reporting failure. Split and ordered
this way, the common partial failure leaves the debrief in the person's inbox and a retryable Stage
behind it; the reverse order would leave them Google Tasks for a debrief they never received.

Thirty days is a number, not a principle. It is long enough to survive a holiday and short enough
that "awaiting review" on Home stays a list worth reading, and it is the part of this decision most
likely to want changing once real debriefs are waiting in it.
