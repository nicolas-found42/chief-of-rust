# Common Crawl capture retrieval is excluded

Common Crawl capture retrieval is excluded from person research: no
`commoncrawl-capture` route is built, and the eligibility record carries the
route as excluded with its reason rather than as a gap awaiting a probe. The
`commoncrawl` entry stays exactly what it is — the CDX index catalogue's
reachability — because the catalogue answering says nothing about whether a
capture's content can be retrieved, which is the only thing that could
contribute evidence to a Profile.

The terms were read on 2026-09-07 (Terms of Use last updated March 7, 2024;
FAQ and Privacy Policy as served the same day). Section 2(l) prohibits using
or accessing the Service or Crawled Content for "collecting or harvesting any
personally identifiable information or personal information for use separately
from the Crawled Content". Section 3 requires every user of Crawled Content to
"RESPECT THE COPYRIGHTS AND OTHER APPLICABLE RIGHTS OF THIRD PARTIES IN AND
TO THE MATERIAL CONTAINED THEREIN", disclaims any reliance on the content, and
recommends legal counsel before any use. No clause grants a citation or
attribution exception, and the FAQ defers entirely to the Terms of Use ("The
terms we add ... are described on our Terms of Use page"). The Privacy Policy
confirms the narrow grant: Common Crawl itself does "not use the Personal
Data ... for any purpose whatsoever, other than making such Personal Data
available in Our data repositories".

Against this application's actual data flow that prohibition fits the
dossier, not an edge of it. `PersonDossierStore.retainSource` keeps the full
source text (up to 500,000 characters) as `person-source-documents` served
back through `source()` and `project()`; the research pipeline's
retain-extract-publish path then proposes per-result personal data
(`createPersonClaimExtractor`: role, current employer) and publishes
structured claims keyed by profile into `person-dossiers/<profileId>`, with
each citation carrying its quote and capture date. The hoped-for distinction
— retaining cited content versus building a separate extracted personal-data
store — collapses here because the pipeline does both inseparably: every
retained source feeds extraction, and the dossier's substance is personal
data served separately from the crawl. Citation and capture dating answer
provenance, not permission, and the generic readers retain with `rights: null`
— established no rights basis at all, which is not the same as free — while
these terms actively withhold one for separate personal-data use. Section 9
additionally attaches indemnity obligations to AI-system use of Crawled
Content, which is what extraction and synthesis over retained text are.

## Considered options

Retrieving captures anonymously (CDX index discovery, then byte-range reads
of WARC content) was rejected although it needs no key: the missing piece is
a rights basis, not a probe, and a probe answering 200 would establish only
reachability — the exact confusion this ticket names. Retaining cited text
while suppressing extraction was rejected too: retention without extraction
is not a mode the pipeline has, and the retained text itself names the
person, so it would still keep personal information separately from the
crawl.

The exclusion is reversible: if the terms gain an explicit allowance for
cited retention in per-person research dossiers, a follow-up re-runs this
assessment against the new text and builds the route then. Until that day the
guard test `person-research-commoncrawl-exclusion.test.ts` fails any attempt
to put a `commoncrawl-capture` route into production without revisiting this
record.
