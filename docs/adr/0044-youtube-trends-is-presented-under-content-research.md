# YouTube Trends is presented under Content Research

The consolidation spec presents YouTube Trends under Content Research — its § Content
Research reads, verbatim: "YouTube Trends is presented at `/content-research/trends` and
keeps an independent measurement Run and spreadsheet output" — and this ticket's acceptance
criteria record the legacy top-level YouTube route as not required by the new product
journey. We moved the surface and removed `/youtube`; we did **not** merge the Module into
Content Research's own Module (ADR-0039 keeps that one watching Named People, with its own
Runs, result shape, checkpoints and retry receipts, and the spec line just quoted keeps
Trends' independent measurement Run and spreadsheet output).

## What changed

- **Presentation, not identity.** `ModuleDescriptor` gains `parent` — the id of the Module
  whose product surface presents this one. `youtube-trends` keeps its id, its
  `HostedModule` identity on the Shell (the Shell still holds a `HostedModule` and nothing
  more), and its own routes under `/api/youtube/*`. Only the address and the nav change:
  `path` becomes `/content-research/trends`, `parent` becomes `"content-research"`.
- **The tab bar renders live, top-level Modules.** A Module with a `parent` is announced on
  Home (its card links to the new path) and entered from its parent's page —
  `ContentResearchPage` and the Trends page both render the same `ContentResearchSubNav`
  (Resonance ↔ YouTube Trends), so the two routes read as one product with two sub-surfaces.
  This extends ADR-0014's membership rule: a planned Module leaves the tab bar because it
  holds no function; a presented-under Module leaves it because its function is promised by
  its parent's tab. Neither is announced by a second tab, and Home stays the surface where
  what exists is enumerated.
- **`/youtube` is gone, not deprecated.** This ticket's acceptance criteria record the
  legacy top-level route as not required by the new product journey, and the spec backs
  that from two directions: backward-compatible legacy product routes are out of scope
  (spec § Out of Scope), and the migration contract states "There is no old-route
  compatibility" (spec § Migration and Cutover). Nothing else links to `/youtube`, no
  tests assert it, and a deprecated route that 200s forever is exactly the second
  entrance to the same surface the spec's IA work removes. `/youtube` now answers with
  the Shell's own not-found page, which the accessibility suite already walks.

## What did not change

- The Module's Runs, `enumerate`/`fetch`/`publish` Stages, trend index, intake schedule,
  spreadsheet output, and retry receipts are untouched — the existing module-level and
  API-level suites still pass unchanged, and the new clean-output contract suite pins them.
- Settings keeps the spreadsheet setup card; the post-reset contract (clean new Sheets, no
  auto-restore of the old destination, writes only to the newly configured spreadsheet) is
  tested over the Module's own endpoints with a fake Sheets adapter that records every
  spreadsheet id it is ever asked to touch.

## Considered Options
- **A second tab at `/content-research/trends`.** Rejected: a top-level tab would present
  Trends as a sibling of Content Research rather than a part of its product, and the spec's
  product areas describe one Content Research surface.
- **Keep `/youtube` alongside the new route.** Rejected: the ticket's acceptance criteria
  mark the legacy route not required and the spec puts backward-compatible legacy product
  routes out of scope, so keeping it leaves two entrances where the product wants one, and
  route-not-found tests already cover the Shell's behavior for unknown addresses.
- **Serve the Trends page inside ContentResearchPage's route.** Rejected: the two pages
  have unrelated state and the Shell's route-not-found, focus-on-navigation, and
  aria-current contracts are per-route; nesting the components would couple them for no
  behavior either side needs.

## Consequences

- The nav loses one tab; Home's tiles do not change in count, and the tile for YouTube
  Trends links to `/content-research/trends`.
- Any future Module presented under another Module's surface gets the same seam: one
  `parent` field, no new mechanism.
- The e2e suite walks `/content-research/trends` in place of `/youtube` (route list, 44px
  target-size scan, journey test) and asserts the tab-bar membership and Home link paths.
