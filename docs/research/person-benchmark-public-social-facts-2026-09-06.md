# Public-social reference facts for the person-research benchmark (issue #241)

Authored 2026-09-06 for issue #241 (child of #228). Scope is the six-person
partition for this issue: Timnit Gebru, Maria Ressa, Arvind Krishna, Michelle
Gass, Cristiano Amon, Doug McMillon. Five gained dated public-social reference
facts; Doug McMillon is left honest (see below). Corpus version after these
additions plus the review rounds (corrections entries, Amilien doc rename,
Gass/Amon pair-scope corrections): `135a02dce2b7fed7`. Gebru, Gass and Amon
stand at `2026-09-06.3` with corrections entries recording each change;
Krishna and Ressa remain at `2026-09-06.2`. The diff is additive-only (no
pre-existing reference removed or weakened).

## Method and retention

Every excerpt below was actually fetched on 2026-09-06; nothing was invented.
X blocks anonymous page fetches, so retention uses endpoints that
really work, recorded honestly per document (LinkedIn public post pages, by
contrast, fetch fine for an anonymous reader):

- LinkedIn public post pages ARE fetchable by an anonymous reader, and their
  embedded JSON-LD (`SocialMediaPosting.datePublished`) dates the post to the
  second. Excerpts retain the author's post text verbatim; trailing
  comment-count chrome was omitted (noted per document).
- X posts are retained via the platform's public oEmbed endpoint
  (`publish.twitter.com/oembed`), which returns author, text and date;
  linked-media stubs were omitted (noted per document).
- Bluesky posts are retained via the public API (`app.bsky.feed.getPosts`,
  plus `getAuthorFeed`/`getQuotes` for discovery); pointers are the canonical
  `bsky.app/profile/.../post/...` URLs (noted per document).

All new facts carry `acquisition: beyond-current-coverage`: no current
collector reads public social timelines (on LinkedIn specifically see
`docs/research/linkedin-reading-options.md`). That is the point — these are
acceptance targets, not currently acquirable sources.

## The two required distinctions, as testable pairings

**Original vs repost.** (a) Krishna: fact `lightwell-original-vs-reshare`
cites Krishna's 28 May 2026 original (`linkedin-lightwell-post`) alongside
Alain J.'s same-day reshare (`linkedin-lightwell-reshare-alain`), which embeds
the original beneath Alain's own commentary — and unjustified conclusion
`lightwell-reshare-as-announcement` (kind `wrong-person`) fails any dossier
that treats the reshare as the announcement itself. (b) Gebru: fact
`gebru-original-vs-quote` cites her 5 Sept 2026 original
(`bsky-spatial-apartheid-post`) alongside nonpareil's quote-post
(`bsky-apartheid-quote-nonpareil`); unjustified `gebru-quote-as-statement`
(`wrong-person`) fails any dossier that attributes the quoter's hashtags to
Gebru.

**Self-statement vs independent account.** Three same-proposition pairs: the
person's own post (`sourceClass: self-report`) plus a third-party account of
the same matter (`sourceClass: independent-account`) —
`lightwell-announcement`/`lightwell-independent-reception` (Krishna, both on
the 28 May 2026 Lightwell announcement),
`lie-told-credo`/`nobel-account` (Ressa, credo and press-freedom record),
`spatial-apartheid-review`/`biased-review-independent` (Gebru, the same
peer-review pattern, adjacent days, with Gebru's post embedding Chanda's) —
with explicit `r20` pairing facts (`lightwell-original-vs-reshare`,
`ressa-self-vs-independent`, `gebru-original-vs-quote`) plus
`unsupported-inference` unjustified conclusions failing any dossier that cites
a self-report as independent verification
(`gass-posts-as-verification`, `amon-announcement-as-verification`,
`ressa-self-as-verification`). Honest limitation (CodeRabbit review on PR
#265): for Gass and Amon the retained records do NOT form same-proposition
verification pairs — Gass's 2023 brand-moment post and Phil W.'s 2026
performance assessment are different propositions, as are Amon's event-plan
post and Amilien's keynote-parameter account. The earlier
`gass-self-vs-independent` pairing fact was therefore removed and `r20`
dropped from `summit2025-keynote-independent` (now `r9`/`r14` only); each
underlying record and fact stands on its own, and the two
`unsupported-inference` guards stay because a dossier could still cite the
self-report as verification of the independent claim.

## Per-person summary

| Person | +Docs | +Facts | +Unjustified | Sources and dates |
| --- | --- | --- | --- | --- |
| Arvind Krishna | 2 | 3 | 1 | Own LinkedIn post on Project Lightwell, 2026-05-28; Alain J. LinkedIn reshare with commentary, 2026-05-28 |
| Michelle Gass | 2 | 2 | 1 | Own #liveinlevis LinkedIn post (Sheeran jacket), 2023-09-22; Phil W. LinkedIn post on her Levi's performance, 2026-04-09 (different propositions; no verification pair claimed) |
| Cristiano Amon | 2 | 2 | 1 | Own LinkedIn post announcing Snapdragon Summit 2025, 2025-09-18; Céline Amilien LinkedIn post on his distributed-AI keynote, 2025-09-24 (different propositions; no verification pair claimed) |
| Maria Ressa | 2 | 3 | 1 | Own X post ("A lie told a million times…"), 2019-12-09; @NobelPrize X post on her record, 2021-10-08 |
| Timnit Gebru | 3 | 3 | 1 | Own Bluesky post on the spatial-apartheid paper's peer review, 2026-09-05; Chanda Prescod-Weinstein Bluesky post on biased review, 2026-09-04; nonpareil Bluesky quote-post, 2026-09-05 |

## Left honest

- **Doug McMillon** — untouched. His public social record is
  Instagram/Facebook-first (@dougmcmillon; e.g. associates posts quoted in
  press), and neither surface yields a fetchably retainable post (Instagram is
  login-walled; the Facebook post endpoint returns a login shell). Independent
  LinkedIn tributes to him exist (e.g. John Furner's post on his mentorship),
  but without a retainable self-post there is no honest self/independent pair,
  so no padded one-sided facts were authored.

## Verification

- `pnpm exec tsx scripts/person-research-benchmark.mts --corpus-coverage`:
  zero REJECTED lines; corpus `135a02dce2b7fed7` (after CodeRabbit pair-scope
  fixes; was `c122ce22b340a5cf` before).
- `pnpm --filter @chief-of-staff-demo/tests exec vitest run
  tests/src/modules/person-benchmark-collection.test.ts
  tests/src/modules/person-benchmark.test.ts`: green.
- `pnpm run check`: green (before PR).
- Partition note: only the six files listed in the issue partition were
  touched, and of those only the five above; no other `people/*.json` file
  was modified.
