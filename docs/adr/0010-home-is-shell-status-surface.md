# Home is a Shell status surface at `/`; Transcript moves to `/transcript`

Supersedes [ADR-0006](0006-home-is-shell-tab-host.md).

ADR-0006 made Home the Shell's tab bar and gave `/` to the Transcript Module. That is reversed here.
`/` becomes a Shell-owned page called Home — a status surface, not a launcher — and Transcript moves
to `/transcript`. `/runs/:id` does not move.

The reason 0006's reading no longer holds is not that its hop-counting was wrong. It is that the cost
landed somewhere 0006 was not looking. A Module owning the front door means the front door's concerns
become that Module's to render, and they did: the Google connection banners live in `RunsPage`, for no
better reason than that `RunsPage` is what you see when you open the app. The connection is a Shell
concern by CONTEXT.md and ADR-0008, and a Module was drawing it. That is structural rather than
untidy — any Shell concern that needs to greet the user has to enter through whichever Module holds
`/`, and the next one will land in the same place.

0006 rejected a dashboard home on three grounds. Each gets an answer rather than a pass.

**The extra hop is real, and we are paying it.** Dropping a transcript is the app's most-used action
and it is now one hop from the front door. There is no mitigation in the design; the daily operator is
expected to bookmark `/transcript`. What makes the hop worth paying is that Home is not a launcher: it
states where the workspace stands, across every Module, which is a thing the tab bar cannot do at any
hop count. A launcher would have bought nothing, and 0006 was right to refuse one.

**"Modules are tabs" is not contradicted, because Home is not a tab.** Home has no workflow of its
own, so by CONTEXT.md it is not a Module. It does not appear in `<nav aria-label="Modules">`; the app
title links to it instead. The tab bar keeps exactly the membership 0006 gave it.

**The bookmark argument does not survive ADR-0001.** One instance per person, on `127.0.0.1`, with
three users. A bookmark to `/` now opens Home rather than Transcript: nothing breaks, the wrong page
appears, and the cost is one person correcting one bookmark once. There is no redirect, because `/` is
not vacated — Home occupies it.

Home shows a sentence stating where you stand, a quiet line confirming the connection when it is
healthy, an attention rail of things needing action that is omitted entirely when empty, and one card
per Module. It deliberately shows no Runs list (that is Transcript's, and a short copy of it beside
the real one is worse than a link), no metrics (a fresh workspace renders them as zeroes, at the one
moment Home matters most to someone new), and no drop target (Intake is a Module concern; a dropzone
here would make Home into Transcript with different chrome).

The tab bar and Home's cards render from one shared Module list in the web app, so the two cannot
disagree about what exists. It does not drive the route table, and it is not the server-side registry
of ADR-0002 — it is a seam that registry can slot behind later without either caller changing.

## Considered Options

- **Hoist the Shell concerns out of `RunsPage` and leave `/` alone.** The strongest alternative: it
  fixes the seam violation with no new page and no extra hop. Rejected because it leaves nothing
  answering "where do I stand" across Modules, and leaves the front door belonging to whichever Module
  was built first — an arbitrary fact that only gets stranger as Modules are added.
- **Home as a launcher** (0006's dashboard): an extra hop for a list the tab bar already renders.
  Still rejected, for 0006's own reason.
- **Redirect `/` to `/transcript` to preserve bookmarks.** Not available: `/` is Home. Keeping the
  redirect means not having Home, which is the option above.

## Consequences

What survives of 0006: Hot Take stays mounted at `/hot-take` as a real Module route rather than a
special-cased Shell page, Settings stays in the header rather than the tab bar, and `/runs/:id` stays
where it is.

Transcript keeps its drop target, its Runs list and its Intakes; Home links into them and owns none of
them. Adding a Module still means two edits — a route and a Module-list entry — so ADR-0003's "adding
a Module needs no change to the Shell" remains not yet true.
