# No store: Google is the record, Runs are the log

Relay carried five tables, so the obvious move is to give the Shell an equivalent table concept.
We read the exported tables before deciding: `Company Strategy` holds a single `"test"` row and was
never used; `Google Tasks` (~377 rows) and `Chief of Staff: Transcript Actions Log` have identical
columns and are append-only logs of extracted tasks keyed by transcript; both `Email Drafts from
Dictation` tables are logs of drafts with a link to the Gmail draft. None of them is shared state
that one workflow wrote for another to read.

So the Shell gets no store. Google remains the system of record for Tasks and drafts, `runs/` stays
the log, and a Module that needs memory gets a scoped `ctx.state` file — as the transcript Module
already does for ingested Fireflies ids. The one genuinely useful thing those tables provided, a
view across Runs, is rebuilt as a read-only index derived by scanning Run results, not as writable
rows.

## Consequences

There is no place for state shared between Modules, and that is deliberate: a writable table
alongside Google recreates Relay's ambiguity about which copy of a task is true. If shared
reference material becomes real (a strategy document several Modules read), the honest home is a
Google Doc that the Shell holds a pointer to, which costs a Drive read scope and is a decision for
its own day.
