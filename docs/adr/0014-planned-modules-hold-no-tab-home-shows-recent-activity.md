# Planned Modules hold no tab; Home shows recent activity

Two clauses of the Home settlement are revised together, because they fail for the same reason:
they made silence and absence mean the same thing.

**Planned Modules leave the tab bar.** A tab promises function; a `Planned` card promises future
function. Those are different contracts, and the tab bar was signing the stronger one on Hot Take's
behalf — a navigation destination whose entire content is "this does not exist yet." A planned
Module is announced on Home instead, and is promoted into the tab bar by becoming live, not by a
second decision. This amends the membership rule this lineage has stated since ADR-0006 and
reaffirmed in ADR-0010 ("the tab bar keeps exactly the membership 0006 gave it"). The `/hot-take`
route stays mounted; the Module list remains the one source both the tab bar and Home's cards read,
so the two cannot disagree about what exists.

**Home shows recent activity.** ADR-0010 deliberately gave Home no Runs list — "a short copy of it
beside the real one is worse than a link" — and that reasoning was about *attention*: a second list
to scan for problems. What it conflated was attention with activity. `All quiet. Nothing needs
you.` minutes after four runs completed reads as abandonment, not quiet, because attention = zero
got rendered as activity = zero. Home gains a short recent-activity feed — the last few finished
Runs with their outcomes — capped, and linking to the Module's own list for everything else. The
attention rail keeps its rule: omitted entirely when empty. The quiet state becomes "All caught
up" plus what happened anyway, which is the distinction that makes a background tool feel alive.

**What survives ADR-0010 untouched:** Home is a status surface at `/`, not a launcher; it shows no
metrics and no drop target; the standing identity line stays. The identity line was proposed for
removal on "healthy infrastructure disappears" grounds and kept — an unwarned page is
indistinguishable from a check that never ran, and this connection expires about weekly. One muted
sentence is the cheapest possible insurance against that ambiguity.

## Considered Options

- **Keep the Hot Take tab with its stub page.** The status quo. Rejected: discoverability is
  already Home's job, and the tab spends the strongest navigation contract the app has on a
  promise.
- **"Since your last visit" as the activity heading.** Requires persisting a last-visit watermark
  to make the claim true, and it goes stale the moment the operator keeps two tabs open. The feed
  says what it is — recent activity — rather than promising a delta it cannot compute.
- **An uncapped Runs list on Home.** The thing ADR-0010 actually rejected, and still correctly: it
  duplicates Transcript's list instead of summarizing it.

## Consequences

The tab bar renders live Modules only; adding a Module still means the same two edits, but a
planned one no longer edits the nav. The e2e and accessibility suites assert the current tab
membership and Home's quiet-state copy and are updated with the change. A fresh workspace with no
finished Runs shows the caught-up sentence with an empty feed — the state ADR-0010's "fresh
workspace renders zeroes" argument warned about does not arise, because a count is never shown.
