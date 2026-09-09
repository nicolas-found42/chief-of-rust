# YouTube Trends measures on demand, not once a day

YouTube Trends originally refused a second manual Run on a day it had already recorded, throwing
`DayAlreadyRecordedError` and answering the route with HTTP 409. The reasoning was that one count per
video per day is what makes a trend, so a second Run that day could only be noise or a duplicate row.

**We now allow the manual trigger to repeat as often as a person likes.** View counts move through
the day, and that movement is real signal: a video that gains most of its views in the first six
hours behaves differently from one that accrues steadily, and a single morning measurement cannot
show the difference. Refusing the second Run threw that information away to protect a tidy
one-row-per-day shape that the trend never actually required.

## What changed, and what did not

The **automatic schedule is unchanged**: `dueNow()` still starts at most one Run per local day from
06:00, so a machine left running produces exactly one Run a day without anyone touching it. Only
`runNow()` — the **Record today** button — repeats. `DayAlreadyRecordedError` and the 409 branch that
handled it are gone, because nothing can raise them any more.

**Every Run is kept.** Prior Runs are not superseded or overwritten by a later Run on the same day;
each one is a measurement that happened, and discarding it would destroy exactly the intra-day
movement this change exists to expose.

## `measuredAt` orders the trend, not `day`

The trend is a Cross-Run index derived by scanning Run results ([ADR-0005](0005-cross-run-index.md)),
and it previously sorted those results by `day`. With repeats that ordering is ambiguous and the
points are indistinguishable, so `TrendPoint` now carries `measuredAt` alongside `day`, and
`TrendIndex` orders by `measuredAt`.

`YoutubeRunResult` already recorded `measuredAt`, so this exposes a fact the Runs were keeping rather
than inventing one. `day` remains on every point: it is still the right label for a daily series and
still what the Sheets ledger keys a row on.

The 7-day and 30-day change figures continue to compare against the newest measurement at least that
old, which stays correct when a day holds several points — it simply resolves to the most recent one.

## Cost accepted

More Runs mean more YouTube API calls and more rows appended to the spreadsheet, and a day with
several Runs will show several points where a reader may expect one. That is the intended trade: the
person choosing to press the button again is asking for exactly that resolution, and the automatic
once-a-day path is untouched for everyone who is not.
