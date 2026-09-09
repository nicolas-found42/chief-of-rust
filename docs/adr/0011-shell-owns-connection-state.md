# The Shell owns connection state; polling status is not proving the token

The Google connection is a Shell concern, so the Shell renders its banners — on every page, not on
Home only. Anyone who bookmarks `/transcript` (ADR-0010 expects the daily operator to) would never see
a banner that lived on Home, and duplicating it per Module is the arrangement ADR-0010 exists to undo.

One context provider owns the connection state and exposes `{ status, refresh() }`. Three places need
the same value — the Shell's banner, Home's standing identity line, and the Settings card, which
*mutates* it, since signing out returns a new status and **Check my setup** replaces it. Settings
writes through the provider rather than keeping its own copy: two copies of the connection is the
"two vocabularies" failure ADR-0008 was written to have fixed, and it grew a third caller last time.

The banner renders inside `<main>`, above the route outlet, in a `role="status"` region that is
**always mounted and empty when the connection is fine**. Both halves are load-bearing. Inside `<main>`
because the skip link targets `#main`, so a banner above it is exactly what a keyboard user skips
past. Always mounted because a live region only announces what arrives after it exists — mount it
conditionally and it re-announces on every navigation, rebuilding the repetition that hoisting the
banner out of one Module was meant to remove. `role="status"` rather than `"alert"` for the reason
`RunsPage` already had: this is a standing condition the user may have chosen, not an event, and an
assertive interruption on every page load would be hostile.

**The part a future reader will misread.** The client refetches `GET /api/google/status` on every tick
of whichever surface is polling `/api/runs`. That looks like the timer ADR-0008 forbids, and ADR-0008
says outright that a timer refreshing either answer "would need its own ADR". This is that ADR, and
the poll is not that timer. ADR-0008 forbids *proving* the token on a schedule — spending Google
round-trips to establish a fact that expires immediately. `/api/google/status` calls Google zero
times: `connected` and `expired` are remembered state, and `unconfigured` and `disconnected` are read
from stored configuration. Polling it refreshes the *client's copy* of an answer the server already
holds. Nothing re-asks Google, so nothing about ADR-0008's economics changes.

Riding the runs poll rather than a clock of its own is what keeps it honest. ADR-0008 enumerates the
four events that change the state: a settings save, a sign-in, a sign-out, and a grant rejected during
a Run. The first three force a remount or happen on Settings. The fourth is a Run failing — and the
runs poll is live in precisely that window, because it stops once every Run is terminal, and a Run
that cannot run cannot get a grant rejected.

## Considered Options

- **Refresh on window focus.** Sounds right for a connection that expires weekly, and buys nothing:
  the expiry estimate stays null until Google has actually refused a grant, which takes a Run. A week
  away with no Runs leaves nothing new to learn.
- **A timer of its own.** Needs a period chosen against nothing, and fires when no Run can change the
  answer. The runs poll already has the right liveness for free.
- **Let each page fetch its own status.** What happens today, and the reason a Module renders Shell
  chrome.

## Consequences

`RunsPage` loses its status fetch, its connection state, both banners and its local expiry threshold.

A Run can still start and fail while the page sits idle with its poll stopped — a watch-folder or
Fireflies Run needs nobody at the keyboard — and nothing then refreshes the status. That hole pre-dates
this decision and belongs to how Transcript polls, not to the connection.
