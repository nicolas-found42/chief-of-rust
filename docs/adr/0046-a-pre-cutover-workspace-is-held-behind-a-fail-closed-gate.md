# A pre-cutover Workspace is held behind a fail-closed migration gate

Issue #144 exposes the one-time Workspace reset that the consolidation cutover (ADR-0043) needs.
Every Workspace that predates the cutover holds product state the new products cannot read and
configuration that names destinations they must not reuse, mixed into the same files as the
credentials that must survive. The reset is destructive, runs once, and cannot ask a provider what
it is about to delete — so the whole design turns on how the boundary between "delete" and "keep"
is drawn, and on what happens when it cannot be drawn at all.

## Considered Options

- **Migrate the old state forward.** Rejected because the retired products' state has no meaning
  under the new contracts: a Content Pack is not a Content Project, and an Idea Engine Sheet row is
  not a Content Draft. Translating them would invent provenance the evidence gates exist to refuse.
- **Delete the Workspace directory and start over.** Rejected because it takes the credentials with
  it. Re-running OAuth and re-entering provider keys is the one part of setup a person cannot
  redo from memory.
- **Classify by prefix or by denylist — delete what matches, keep the rest.** Rejected because it
  fails open: a credential added later under a path nobody updated would be deleted, and a product
  value nobody classified would be preserved and silently re-adopted after the cutover.
- **Run the reset automatically on the first boot that detects a pre-cutover Workspace.** Rejected
  because a destructive one-time action with no undo is not one an app performs on its own.

## Decision

**The boundary is an explicit table, and anything it does not name ends the migration.** Every
directory, whole file, and — for `config.json` and `relay.json`, which mix credentials with product
state — every key is named in a table that mirrors the schema, down through the interior of records
and arrays. An unrecognized entry or key is not a default: it produces an `unsafe-mixed-state`
finding, and the preview and the reset both stop having changed nothing. Adding a key to
`ConfigSchema` without adding it to the table is therefore a caught error rather than a silent
deletion or a silent preservation.

**A pre-cutover Workspace does not run the product.** The gate is read at boot from the Workspace
itself, not from a flag: while it holds, no Module starts, no scheduler ticks, the runs directory
is not created and `config.json` is not normalized and rewritten — a boot that changed the
Workspace would break the promise that cancelling leaves it byte-for-byte unchanged. Normal `/api`
routes refuse with 503 behind one hook, and the Shell renders the gate in place of the product
rather than relying on that refusal.

**Nothing about the migration reaches a provider.** Validation reads the rewritten files back and
checks structure. It never asks whether a preserved token still works, and it never deletes a
remote record: local values that name a Sheet, a Drive folder or a Notion database are disclosed as
pointers, deleted as configuration, and the records they named are left exactly as they are.
Preserved credentials come back available but disabled, and no old destination is restored, so the
first thing that touches a provider after the cutover is a person choosing to.

**The receipt is content-free and the marker is the last write.** The reset writes counts — never a
path, a key name, or a stored value — then the marker whose existence is the only word that the
whole reset finished. An interrupted run leaves no marker, so the next attempt clears its own
bookkeeping and reclassifies from the Workspace as it now stands rather than trusting a stale
inventory.

## Consequences

- The classification tables are a maintenance obligation with teeth. A schema addition that misses
  them fails the migration closed on the Workspace of anyone who has stored that key — the failure
  is loud and safe, but it is a failure, so the tables belong in the same change as the schema.
- The preview must read past the migration's own directory rather than fail closed on it: the
  receipt of a finished or interrupted run is this module's bookkeeping, not Workspace state.
- Restart safety comes from the marker rather than from a journal. The reset is not resumable
  mid-flight; it is re-runnable from the top, which is what makes it idempotent without one.
