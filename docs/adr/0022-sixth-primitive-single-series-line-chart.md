# A sixth UI primitive: the single-series line chart

**Amends:** ADR-0015 (Five local UI primitives, no design system)

ADR-0015 named five CSS classes the whole UI composes from and said plainly that "a sixth
primitive is a considered change like any other." YouTube Trends is the first Module whose
question — is this growing? — is a shape rather than a number, so the sixth arrives here and
this is the consideration.

**The primitive is a single-series line chart**, used at two scales: a channel's total views
over time, and one video's when its row is expanded. It is an inline `<svg>` with one
`polyline` per unbroken run of measured days, `role="img"`, and a label that states the whole
chart as a sentence for anyone who cannot see it. There is no axis furniture: the numbers are
in the table beside it, and the chart says the one thing the table cannot.

**Single-series is the load-bearing word.** One line per video on a two-hundred-video channel is
a smear, and the fix for a smear is a legend, a colour scale and a series picker — which is
exactly where a charting library gets adopted. ADR-0015 exists to resist that, so the resistance
is spent here rather than later: a second series is not a bigger version of this primitive, it is
a different decision, and it needs its own ADR.

**The gap rule belongs to the primitive, not to the caller.** A day the machine was off has no
measurement and never will, because no API returns a past day's view count. The line is broken
across such a day rather than drawn through it: a straight segment between Friday and Monday is a
number nobody measured. The geometry is a pure function (`apps/web/src/chart.ts`) precisely so
that rule is testable without a browser.

The expanding row that reveals a video's line is not new — it is the fifth primitive, the
disclosure, applied to a table row.

**A Module's sub-navigation is not a seventh primitive.** YouTube Trends renders one sub-tab per
channel, and ADR-0015 asks that new chrome be a considered change rather than an accident, so the
consideration is here. The sub-tab strip is the header's own navigation pattern one level down:
a `<nav>` of controls, the current one marked with `aria-current` and distinguished by border and
weight rather than by colour alone, exactly as the tab bar marks the current page. It reuses that
pattern rather than inventing chrome, and it stays inside the Module's page — the Shell's tab bar
gains exactly one entry per Module (ADR-0006) and does not model a Module's internal sections. If a
second Module wants sub-navigation, it gets this; if one wants something else, that is an ADR.

## Considered Options

- **A charting dependency.** Rejected on the same grounds ADR-0015 rejected a component library:
  the surface is one Module's tab, the requirement is one line, and a dependency arrives with a
  theme, a bundle and an upgrade treadmill for a shape that is forty lines of arithmetic.
- **A sparkline in the table cell instead of a chart.** Tempting, and genuinely smaller. Rejected
  because the channel-level line is the one a person actually reads, and it wants width; a
  primitive used at two scales is one primitive, while a sparkline plus a chart would be two.
- **No chart in phase 1 at all.** This is what shipped in movement 4, and it was right then: a
  chart over three days teaches nobody anything. It stops being right the moment there is a
  fortnight of data, which is the day this lands.

## Consequences

`ADR-0015`'s count is now six, and its rule is unchanged: every new surface composes these before
inventing new chrome. The chart's colours are the existing `--accent` token, so a design system
adopted later still maps names rather than unwinding a framework.

A second Module wanting a chart gets this one or writes an ADR. In particular, "the same chart but
with two lines" is not a reuse of this primitive.
