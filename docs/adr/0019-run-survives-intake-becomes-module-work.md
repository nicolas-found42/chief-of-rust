# Run survives; Intake, Stage and Output Adapter are redefined

Three terms in `CONTEXT.md` were written while the app hosted one Module, and the question was
whether **Run** should survive at all — the position put was that a log recording everything a
workflow does fits these workflows better than a record called a Run. It survives. What was wrong
was the definitions, in specific clauses, and this ADR records which and why.

**Run keeps its concept and its name.** A Run is a scope; a log is a history; they are not
alternatives, and the app already holds both files — `meta.json` is the scope, `events.jsonl` is
the log. Every question a person asks is scoped: "did Tuesday's file work", "do it again", "what
needs me". The evidence offered against Run turns out to argue for it. Of the 430 Relay executions
in the export, 249 still say `IN_PROGRESS`: 91 genuinely wait, but 90 ended in failure, 49 never
went past the start, and 13 finished. Relay's status was wrong about half the time because Relay
wrote the status apart from the history, which is the exact fault ADR-0009 removed here. And the
Module cited as least Run-shaped — Weekly YouTube View Count, no file, no transcript, no task — has
48 Relay executions, all completed, the cleanest set in the corpus. The name stays because
`execution` is on Run's own _Avoid_ list, and a rename would touch `CONTEXT.md`, ADRs 0003, 0004
and 0009, `runs.ts` and every route under `/api/runs` while buying no function.

Three clauses go. "A persisted result" was the transcript Module's result: a Module supplies its
own shape, the Shell stores it closed, and the Module supplies one summary line for the Runs list.
The definition implied a Run ends; ADR-0020 lets it wait instead. And "one execution" hid a rule
that was never in Run at all — the one-file-one-Run rule lives in `DriveIntake.startRun`, not in
`Runs.create`, so it was Intake's fault and it moves there.

**Intake becomes Module work.** Its definition named the Drive poll as the concept itself, claimed
the Shell schedules and retries it (false for the sixteen Relay Workflows a person starts by hand),
and welded an arrival to exactly one Run. Under ADR-0018 the Shell watches nothing, so there is no
Shell machinery and no arrival record to name: an Intake is the part of a Module that finds work to
do, and it starts zero, one or many Runs as that Module decides.

**Stage survives untouched in concept.** The recount in ADR-0018 removed the argument that
concurrency breaks it, and the code had already falsified the rest: `createOutputs` runs per-item
try/catch, counts `taskErrors` and `draftErrors`, and finishes the Run `done`, so a Stage already
tolerates partial failure and always did. A Stage is a named span of a Run that the Module opens
and the Shell records. The retry sentence leaves the glossary, because ADR-0009 already owns that
split: the Shell records which Stage a Run failed in, and the Module decides what re-running means.

**Output Adapter survives, unwelded from Google.** Its definition used "step", which is on Stage's
_Avoid_ list, and "a Run's result", which is now gone. It keeps the term because the term does two
jobs nothing else does: it carries the rule that outward writes go through the Google connection
(ADRs 0008, 0011, 0016), and it is one third of the test for a live Module (`CONTEXT.md`,
ADR-0017). The rule is narrowed to what is true: **a Google** Output Adapter comes from the
connection or not at all. The Relay corpus writes to Notion more than forty times, so a non-Google
adapter is likely and the old phrasing would have made it a contradiction.

## Considered Options

- **Replace Run with one continuous activity log per Module.** Rejected above. The strongest form
  of the case is a headless Module like Weekly YouTube View Count, where nobody wants 48 rows and
  everybody wants one line — but that is an argument about the Runs list and Home's feed, not about
  whether the record exists, and it is settled where that list is designed.
- **Rename Run to Execution, and Intake to Source and Signal**, as an outside proposal
  recommended. Rejected on the glossary: `execution` is on Run's _Avoid_ list, `source` and
  `trigger` are on Intake's, and `source` additionally collides with `RunSourceType`, which
  already means which Intake produced a Run.
- **Add a durable Operation primitive** and make it the retry boundary instead of Stage. Rejected
  for now: the only thing it buys over a Stage is not repeating a completed side effect after a
  restart, and there is no restart recovery to consume it. Today a Run caught `running` by a
  restart stays `running` forever and `retryRun` refuses it, because the queue is an in-memory
  promise chain and nothing recovers it at boot. Fix that first; name the Operation when it has
  something to do.
- **Demote Output Adapter to "a Module side effect"**, with the Google helpers as a library.
  Rejected: it dissolves the connection rule and the live-Module test for no gain.

## Consequences

`RunSourceType` stops being a one-value union and becomes which Intake produced the Run.
`RUN_EVENT_TYPES` opens to a plain string: it is a closed union of fifteen with eight entries owned
by the transcript Module, and ADR-0009 pre-authorised exactly this. `ExtractionResult`,
`transcript.txt` and `taskCount` leave the Shell, and `RunMeta.fileName` stops being mandatory.

A Module may append an event at Module scope, outside any Run, so a Module that checks and finds
nothing can say so. `state.ts` already holds `lastPollAt` and `lastPollOutcome`, which is this idea
with one Module and one field.

**Relay execution** enters the glossary as a term. The argument against Run leaned on "84 Runs
still parked", and those are Relay's records, not Runs — this app has never had a parked Run.
Keeping the two words apart is what let the question be answered.

**The Runs already on disk are discarded rather than migrated.** Fifteen existed when this ADR was
written — ten created inside a five-second burst, seven from files named `"Copy of …"` — so they
are Runs made to watch the app work, which is what ADR-0012 meant by discardable test data. The
discard is cheap because of ADR-0005: the 96 Google Tasks and 2 Gmail drafts they produced live in
Google and survive it, and only the local log is lost. No compatibility layer was ever required —
`readMeta` is an unvalidated `JSON.parse`, so an old `meta.json` reads cleanly under the new shape;
ADR-0004's read-time default would have been needed only for the two fields this format change
*adds* (`module`, `moduleVersion`), and there is now nothing old to default. One operator note
belongs with the deletion: `state.json` holds `drive.ingestedIds`, so removing it alongside the Run
directories would make the next poll re-ingest every file and duplicate all 96 Tasks.
