# YouTube Trends: the Runs are the record, the trend is a cached index

**Reaffirms:** ADR-0005 (No store: Google is the record, Runs are the log)

The Relay Workflow this Module replaces overwrote last week's number with this week's, so it could
say what a video had been watched in total and never whether it was growing. Keeping a trend means
keeping every day, which is the first thing in this app that looks like it wants a table.

It does not get one. **Each daily Run's result holds that day's counts**, and the Module's tab
renders a read-only view derived by scanning Run results — which is exactly what ADR-0005
prescribed for a view across Runs. The app gains no store.

**The index is derived on read and cached in memory, invalidated when the day's counts are
written.** One invalidator, which is also the only writer, so the cache cannot drift from the
Runs. A Module-scoped rollup file was rejected: ADR-0005 permits one, but it is a second copy of
the same numbers, which is the ambiguity that ADR ruled out. It becomes the right answer against a
measurement, never against a guess.

**One Run per calendar day, and the day travels on the Run.** The Intake decides the day and stamps
it on the Run record; nothing downstream re-derives it from a clock. A failed Run is retried in
place through the existing reopen path and never re-created, so nothing — Module, index or
spreadsheet — ever has to define "the latest Run for a day".

**A day the machine was off is a gap, and is never backfilled.** No API returns a past day's view
count. The chart draws a break rather than interpolating, because a straight line between Friday
and Monday is a number nobody measured. A trend built this way is only as continuous as the
machine's uptime, and that is a property of the design rather than a defect in it.

**The spreadsheet is an Output Adapter, not the record.** Its job is the operator's data outside
the app: chartable, shareable, and proof against this app disappearing. It is long, not wide — one
row per video per day, one tab per channel — because long appends in one call with no
read-modify-write, has no column ceiling, and is the shape every spreadsheet chart and pivot
expects. A dated column per day would reach three hundred and sixty-five columns a year and be
unreadable long before it broke. This Module appends and never updates, so the question of whether
a cell update and a row append are one Output Adapter or two does not arise here.

**Reading the spreadsheet live on each page view was rejected.** It would blank the tab whenever
the Google connection is expired, and under a weekly consent expiry that is not a rare state.

## Considered Options

- **A rollup file per Module** (`ctx.state`), updated as each Run finishes. Cheaper to read and
  genuinely permitted by ADR-0005. Rejected above, and it stays available the day a measurement
  says the scan is too slow.
- **The spreadsheet as the record**, as the Relay original had it. Rejected: it makes every page
  view a Google call, and it makes a weekly expiry look like data loss.
- **Backfilling a missed day** from anywhere. Impossible, not merely unbuilt.

## Consequences

Reading the trend costs one small file per Run of this Module, once, until the next Run completes.
A year is three hundred and sixty-five Runs — roughly seven times the entire recorded history of
the Relay Workflow it replaces — and that is the volume the Runs list's paging exists for. If it
ever bites, the answer is a retention rule on old Runs or the rollup file above, and both are
changes to make against a measurement.

The Shell reads inside none of this. `result.json` is the Run's own file, and the Runs list shows
only the one line the Module wrote when the Run ended.
