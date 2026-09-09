# A live Module may be headless: lifecycle and presence are separate axes

**Amended by:** ADR-0025 — the two axes below stand, but this ADR's worked example is withdrawn:
the YouTube Module was built and holds a tab, so no committed Module is headless. ADR-0025 also
closes the gap this one leaves open at the end, about where a headless Module's Runs are read.

ADR-0014 removed planned Modules from the tab bar and settled promotion in one sentence: a
planned Module "is promoted into the tab bar by becoming live, not by a second decision." That
rule carries an assumption nothing had tested yet — that every live Module has something for a
person to look at. The Weekly YouTube View Count Module does not. It reads a spreadsheet, asks
YouTube for view counts, and writes them back into the same spreadsheet; its entire output is a
column in a document the owner already opens, and it is the most-used Workflow of the five being
migrated. It is fully live and there is nothing to render.

So the two ideas ADR-0014 fused are separated here. **Lifecycle** is whether the Module is
built: it is `planned` until its Runs, Intakes and Output Adapters exist, and `live` once they
do. **Presence** is whether a person has anything to look at: a Module with something to show is
presented as a tab, and a live Module with nothing to show is **headless**. Becoming live
promotes a Module into the tab bar only if it has something to show. Headless is not a stage of
building and not a lesser kind of Module; a headless Module is finished.

ADR-0014's finding is untouched and is the reason this is an amendment rather than a reversal.
Hot Take's tab was a false promise because there was no function behind it — a navigation
destination whose entire content was "this does not exist yet." A headless Module is the
opposite case: the function is there and there is simply nothing to draw. Same absence of a tab,
different reason, and conflating them is what produced a rule that a working Module can break.
The membership lineage runs ADR-0006, ADR-0010, ADR-0014, and now this one. ADR-0014's invariant
survives intact: the Module list remains the one source both the tab bar and Home's cards read,
and it now carries whether a Module is headless, so the two still cannot disagree about what
exists.

The word for this is `headless`, not `surface`. This repo already spends "surface" twice — on an
area of a Google API in ADR-0008 and ADR-0016, and on Home's own role in ADR-0010 — and a third
meaning would collide with both.

## Considered Options

- **A third lifecycle state.** Planned, live, and some new state for a working Module with no
  tab. Rejected: it makes `live` mean two different things depending on which kind of Module
  holds it, which is the same fusion ADR-0014 made, relocated rather than removed.
- **A thin tab showing the last refresh and a link to the spreadsheet.** Cheapest in code, and
  it keeps ADR-0014's promotion rule literally true. Rejected: it rebuilds exactly the contract
  ADR-0014 dismantled — a navigation destination whose content is one sentence and an outward
  link — and it would make every future headless Module pay the same tax.
- **Deciding the YouTube Module is not a Module at all**, and putting it in the Shell as a
  scheduled job. Rejected earlier in the same design session: parsing a video URL and knowing
  which column holds a view count is specific to one workflow, and the Module definition keeps
  that out of the Shell.

## Consequences

Home's recent-activity feed becomes the only place a headless Module is visible at all. ADR-0014
added that feed and capped it deliberately, and the cap now carries more weight than it did when
every Module also had a tab of its own.

**This ADR creates a gap it does not close.** There is no Shell-level Runs list in this app: the
transcript Module's own tab at `/transcript` is the Runs list, and `/runs/:id` is a Run detail
reached from it. A headless Module has no tab, so its Run history has nowhere to live once it
scrolls past Home's cap. A Run is a Shell concept rather than a Module one, so presenting it is
the Shell's job, and the Shell has not needed to until now. ADR-0014 kept the `/hot-take` route
mounted while removing its tab, so a mounted-but-untabbed route is already precedent here if
that turns out to be the answer. Where a headless Module's Runs are read is left open.
