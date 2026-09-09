# Transcript → Tasks is retired

Issue #142 retires Transcript → Tasks, the app's founding Module, together with the remaining
surfaces of the Idea Engine, whose product was already retired at the consolidation cutover
(ADR-0043). Until #142 wired the Transcript Catalog's production composition, Transcript → Tasks
was still the only reader of the transcripts Drive folder; the Catalog and Meeting Debrief now
cover what it did, so keeping it left a duplicate intake and an unreviewed write path to Google.

## What changed

- **The Transcript Catalog is the sole private-transcript intake writer.** It reads the same
  transcripts Drive folder through one client path, keeps the ledger of what has been seen, and
  processes on demand. Transcript → Tasks' own poller and `/api/drive/sync` are gone; the intake
  surface the Settings page drives is the Catalog's.
- **Meeting Debrief is the only private-transcript → drafts workflow.** A mined transcript
  becomes a retrospective — decisions, action items, open questions, coaching — waiting for
  review before any outward write, per ADR-0038, rather than an unreviewed creation of Google
  Tasks and Gmail drafts.
- **The neutral parts survive as shared interfaces.** Text conversion, including the
  transcript-file-name meeting-date helper, and the draft-only Google output adapters belonged to
  the Module by accident, not by nature: they move to shared ground rather than dying with it.
  The Idea Engine's `modules["idea-engine"]` configuration key lingers in the config schema only
  until the one-time migration deletes it.
- **Retired routes fall to normal not-found.** The Module's page and API routes answer with the
  Shell's own not-found behavior, as `/youtube` does since ADR-0044 — no deprecated route 200s
  forever.

## Consequences

- Four Module tabs remain, and the Shell's cross-Module Runs list at `/runs` is the only Runs
  list there is; no Module keeps one of its own.
- Runs previously attributed to `transcript-tasks` keep their raw identifier in the Runs list —
  history does not disappear because a Module was removed.
- Any future private-transcript consumer registers with the Transcript Catalog rather than
  reading the Drive folder itself: the single-intake rule now has exactly one keeper.
