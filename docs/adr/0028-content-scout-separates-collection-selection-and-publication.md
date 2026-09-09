# Content Scout separates collection, selection and publication

Relay's Daily Hot Take family put a daily scan, one LinkedIn scraper, brand guidance, an emailed
shortlist, an indefinite reply wait, one draft and a Notion write into one opaque chain. The chain
was heavily used but never completed a Run: unanswered emails left 84 reference Runs waiting, and
removal of the LinkedIn scraper caused 31 consecutive failures. Rebuilding that ordering literally
would preserve the two faults its history makes visible — a source can disable the whole job, and
the person's decision has no durable first-class home.

The replacement is **Content Scout**, not Hot Take. One Intake Run has three explicit boundaries.
First, independent Source Adapters collect public Source Items and report field-level completeness;
an adapter is Available, Experimental or Coming later, and one failure cannot prevent the others
from running. Second, the Run produces an in-app shortlist and becomes durably `blocked` under
ADR-0020 until the person selects, skips or supersedes it. Third, each selection freezes one
Opportunity Brief and produces a complete, versioned Content Pack: 23 Content Drafts generated in
independent model requests, preserved locally as immutable Run artifacts, and published one-way to
one editable Notion page per draft. A Content Pack is not complete until both its local drafts and
Notion pages exist; partial success is retained and retry creates only missing work.

The Brand Profile follows the same ownership line. A bounded company-site crawl may propose it, but
the canonical value is versioned local Markdown edited by the person. Future crawls propose a
three-way diff and cannot overwrite it. Source Discovery may propose Source Targets from that
profile and approved sources, but scheduling a suggestion always requires explicit approval.

## Considered Options

- **Keep Hot Take as a link/transcript-to-LinkedIn Module.** Rejected: that planned placeholder was
  written before the Relay family was examined and describes neither the recurring Intake nor the
  human decision that made the workflow useful.
- **Rebuild Relay with email selection and one replacement LinkedIn scraper.** Rejected: the app has
  a human surface and a durable wait design, while Relay's history proves that an indefinite email
  wait and a single scraper are not incidental implementation details.
- **Finish collection, then start a second Run when a person selects.** Rejected: the shortlist,
  evidence, decision and output are one piece of work. ADR-0020 exists to preserve that identity
  across a restart without holding an in-memory promise.
- **Generate one canonical draft and adapt it into the other formats.** Rejected: every derivative
  would inherit the first format's framing and mistakes. The shared Opportunity Brief is the reuse
  boundary; Content Drafts are siblings, not a pipeline.
- **Make the app the content editor or synchronize Notion edits back.** Rejected: immutable local
  artifacts make Runs reproducible, while Notion is already the chosen editable calendar. Two-way
  synchronization would introduce conflicts without improving generation.
- **Automatically monitor discovered sources.** Rejected: similarity is a ranking signal, not proof
  that a source is valuable or appropriate. Source Suggestions remain reversible human decisions.

## Consequences

Content Scout is a live Module with a tab and replaces the planned Hot Take identity. It requires
ADR-0020's durable wait and restart recovery to be implemented before its Intake can be correct. It
also introduces a shared Source Adapter contract, but not a universal scraper: RSS/web/YouTube may
be Available while less reliable platforms remain visible as Experimental or Coming later.

The complete-pack promise is intentionally expensive — up to 69 isolated draft generations from
one three-opportunity submission. Bounded concurrency, immutable Opportunity Briefs, idempotency and
missing-only retries contain that cost; silently emitting a smaller format set does not. Adding or
changing a Draft Target changes a versioned product contract.

Notion becomes an Output Adapter rather than the record. ADR-0027 supplies the connection model;
local Runs keep the original drafts and evidence, and Notion owns subsequent editorial changes.

Public source material is untrusted evidence. It cannot change Module instructions, invoke tools,
alter the Brand Profile or destination, or cause arbitrary browsing. Authenticated social sessions,
cookie import, shared scraper accounts and CAPTCHA bypass remain outside the design.
