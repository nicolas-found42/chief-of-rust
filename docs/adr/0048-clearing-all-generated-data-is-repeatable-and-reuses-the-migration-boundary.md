# Clearing all generated data is repeatable and reuses the migration's boundary

The one-time reset ADR-0046 built runs once and then closes: its completion marker is the whole
point, and the Workspace it was written for no longer exists after the cutover. What the owner
needs afterwards is the ordinary operation the demo depends on — put the app back to empty, show it
to someone, do it again next week. Demoing is not migrating, but the question both actions must
answer is the same one: which bytes in the Workspace are data the products generated, and which are
the credentials, pointers and settings that make the app worth opening at all.

## Considered Options

- **Re-open the migration gate for a second run.** Rejected because the gate is one-time by
  construction: the marker is its only word that the reset finished, and a gate that can be
  re-armed stops being evidence of anything. It also holds the whole app at 503 while it waits,
  which is the right price for a cutover and the wrong one for a reset between demos.
- **Delete the Workspace directory and let boot re-create it.** Rejected for the reason ADR-0046
  already gave: it takes the credentials with it, and re-running OAuth is the one part of setup a
  person cannot redo from memory. Repeating the action weekly makes that cost weekly.
- **Write a second classification table for the repeatable action.** Rejected because two tables
  drift. The moment a new directory is named in one and not the other, the same Workspace entry is
  generated data on one path and a keeper on the other, and nothing in the build says which is
  wrong.
- **Delete the spreadsheets the app writes and let the next Run create new ones.** Rejected because
  the spreadsheet is a destination the owner shared, formatted and may have linked; its identity is
  configuration, not generated data. Replacing it silently re-homes the product's output.

## Decision

**The boundary is ADR-0046's classification tables, imported verbatim.** The repeatable clear
deletes exactly the directories and whole files those tables name and reads nothing else, so
`config.json`, `relay.json` and the migration's own bookkeeping are outside the action by
construction rather than by a second list that agrees with the first today. The tables are now
exported from the migration module and consumed by both paths: one audited line between generated
data and everything else, and a schema addition that misses it fails both actions the same way.

**Pointers are configuration and survive the wipe.** The YouTube Trends spreadsheet id lives in
`config.json`, which the boundary never touches; the Resonance Ledger's pointer lives inside
`content-research/people.json`, which the wipe deletes whole, so it is captured before the wipe and
re-seeded after. Losing it would not lose data — it would have the next Run create a second
spreadsheet beside the emptied one, which is the drift the destination-identity option above was
rejected to avoid.

**The Sheets rows are emptied through the provider, best-effort and per destination.** The local
wipe runs first and always; each spreadsheet's data rows are then physically deleted below the
header row, every tab including stale ones, and each destination reports `cleared`, `skipped`,
`missing` or `failed` with a reason. A dropped Google connection therefore costs the rows in the
cloud, never the reset itself, and re-running the action is how those rows get cleared later —
which is safe because deleting rows below a header is idempotent.

**What the provider owns beyond those rows is out of scope, and the exclusions are stated.** Google
Tasks, Gmail drafts and the transcripts Drive folder are untouched: Tasks and drafts by the owner's
explicit instruction, the folder because it is the seed the data was derived from, and every
credential because this is a data clear, not a sign-out. The card says so in the same disclosure
that says what goes.

**Resuming does not re-seed.** The Modules are quiesced only if they were running — stop taking
work, drain what is enqueued, then wipe — and restarted with the V1 watchlist seed withheld, so a
cleared Workspace holds no data rather than demo data. There is no completion marker: the action is
repeatable by definition, and its receipt is content-free in ADR-0046's sense, carrying names and
counts and never a stored value.

## Consequences

- The clear inherits the migration's maintenance obligation exactly. A new generated-data directory
  that nobody adds to the tables is silently preserved here and fails the migration closed there;
  the tables belong in the same change as the schema, now for two reasons.
- A destination that reports `failed` or `missing` leaves rows in a spreadsheet the local Workspace
  no longer knows about. The receipt names the destination and the reason, and the fix is to re-run
  the action or to clear the sheet by hand — there is no reconciliation pass, and a demo that reads
  those rows would read stale ones.
- The action sits behind the migration gate's `preHandler`, so a pre-cutover Workspace cannot reach
  it. The one-time reset stays the only thing that can run first, which is the intended order.
- The app has no authentication (ADR-0001, loopback-only), so the typed phrase is the whole guard.
  That is the same guard the destructive per-record actions already use, and it is the right one
  only for as long as ADR-0001 holds.
