# A Brand Profile revision history is append-only; restoring appends too

The Brand Profile surface (ADR-0039, ADR-0041) keeps one accepted revision at a time and treats
revisions as immutable, but until now a person could not see the revisions they had accepted or
get an earlier one back without a scan. Acceptance is the product's most consequential undo-free
action: a rescan reviewed and accepted in thirty seconds replaces voice sections a person curated
over weeks. Immutability protects history from the server; it does nothing for a person who is
the one who made the mistake.

## Considered Options

- **Let revisions be edited in place, with the previous text recoverable from the scan.** Rejected
  because it breaks the contract every consumer relies on: a revision id names the exact Markdown
  the meeting products quote, and rewriting a record to change it is the drift ADR-0037 refuses.
- **Keep the history hidden and rely on rescans to recover.** Rejected because a rescan produces
  website evidence, not the person's own edited prose; the text a bad acceptance overwrote is in
  no scan.
- **Restore by copying the old revision's fields into a mutable "current" record.** Rejected
  because it reintroduces the one mutable record the append-only design removed: the current
  revision would no longer be an append, and its id could name two different texts over time.

## Decision

**Every acceptance is retained, and the current revision is whichever one was appended last.** The
Workspace state file already kept the full revision array; the product now exposes it. The state
projection lists every revision's summary — id, timestamp, note, changed sections — oldest first,
bodies unloaded, and a per-revision endpoint serves one revision's Markdown on demand. Listing
metadata eagerly and bodies lazily keeps the state payload bounded by the number of revisions, not
by their size.

**Restore is an accept whose note says where the text came from.** The restore endpoint does not
move a pointer or rewrite anything: it re-runs the same accept path with the stored revision's
Markdown and source scan, appending a new revision with note `Restored from <id>`. The restored
revision becomes current; the revision it came from, and every revision between, remain exactly
as they were. History therefore never changes shape after the fact — it only grows — and "the
current revision" stays a pure function of the append order.

**The editor binds to the revision it opened on.** The Brand Profile page syncs its textarea to
the current revision whenever the current revision's id changes — an acceptance or a restore. A
stale textarea holding pre-acceptance text, one "Accept new revision" away from silently
overwriting the acceptance, is the failure mode this surface must not invite; edits made within
one revision are still preserved.

## Consequences

- Restoring a three-revisions-ago state produces a fourth revision rather than rewinding to the
  first. Diff-based consumers see a change; provenance consumers see where the text came from in
  the note. Anyone wanting the id of the "original" must follow the note chain.
- The revision array is load-bearing forever: no compaction or pruning can exist without breaking
  the restore promise. For a single-user local-first Workspace whose acceptances are
  person-paced, this is acceptable; a multi-tenant store would need a different answer.
- The shared composer (`acceptedProposalMarkdown`) now lives in `packages/shared` so the review
  UI can preview exactly the Markdown the server will write. The two can no longer drift.
