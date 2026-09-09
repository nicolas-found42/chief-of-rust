# Primary credit and institutional evidence validation

Inspected 2026-09-06 for issue #228. This is a bounded source assessment, not a
corpus edit or proof of live production discovery. No keys, login, imported
cookies, proxies, or access-control workarounds were used.

## Academy: accessible information, unavailable retained evidence

The [Academy's 2020 ceremony page](https://www.oscars.org/oscars/ceremonies/2020)
rendered substantive text through anonymous web retrieval. Its event date is
February 9, 2020. The directing winner block identifies Bong Joon Ho for
Parasite; the original-screenplay winner block identifies Bong Joon Ho and Han
Jin Won as screenplay writers, with story credited to Bong. This supports a
shared-credit distinction, but does not make the route eligible for this
benchmark's acquisition and retention.

The [Academy legal landing page](https://www.oscars.org/footer/legal) links to
the [Terms of Use](https://www.oscars.org/legal/terms-of-use), both inspected
anonymously. Terms section 2 limits content use and prohibits copying by
automated devices or manual processes except public-search indexing. A short
diagnostic quotation from that section is: “The content of this Site is for
information and personal use only and not for commercial exploitation.” The
page displays a 2021 copyright notice but supplies no separate revision date.

**Disposition: unavailable for intended automated acquisition and retained
benchmark evidence without permission.** No Academy credit excerpt is supplied
for corpus retention. A 25-word excerpt ceiling is not itself permission to
ignore these terms. Do not mark this route `public-record` or count it as a new
usable creative-record source. No further Academy acquisition was attempted
after the restriction was observed.

## Cary Fowler: usable government testimony

The [Senate Foreign Relations hearing page](https://www.foreign.senate.gov/hearings/global-food-security)
identifies the March 6, 2024 Global Food Security hearing and names Dr. Cary
Fowler as the State Department's Special Envoy for Global Food Security. Its
Fowler testimony link resolves to a three-page primary document:

- [Official testimony download](https://www.foreign.senate.gov/download/10/02/2024/030624_fowler_testimony1).
- [Resolved PDF](https://www.foreign.senate.gov/imo/media/doc/0a63ba71-93fa-f089-be57-fa00af74aad5/030624_Fowler_Testimony1.pdf).
- Document date: March 6, 2024, printed on page 1. The October date in the download
  route is not the testimony's date.
- Anonymous direct Python `urllib.request.urlopen` returned HTTP 200, a PDF
  signature, and 128,433 bytes. SHA-256 of the received PDF:
  `5e9cc0f6f0ad866176f1708be8a7d6107a6f35714b5dde904269ceac93607b6e`.
- Web retrieval independently parsed all three pages. Page 1 contains the
  first-person role statement below; this is substantive evidence, not an
  endpoint smoke success.

Exact short excerpt, page 1, with PDF line breaks normalized (21 words):

> As the Deputy Coordinator for Diplomacy for the global Feed the Future initiative, I lead the diplomatic agenda

Supported candidate fact: **In his March 6, 2024 Senate testimony, Fowler
identified himself as Deputy Coordinator for Diplomacy for the global Feed the
Future initiative and described leading its diplomatic agenda.** This is a
dated self-report about personal responsibility, strengthening the existing
career evidence with a concrete additional role. It does not establish his
current role in 2026, sole ownership of Feed the Future, or personal credit for
the entirety of U.S. food assistance. Suggested family: `professional-records`;
source class: `self-report`, preserving Fowler's authorship despite the Senate
host. This is submitted written testimony; do not describe it as independently
verified words spoken in the hearing or a fetched audio transcript.

The [committee privacy policy](https://www.foreign.senate.gov/privacy-policy)
was inspected and does not impose a copying prohibition or require login. It
is not a reuse license. The rights basis is the document's identification as
an official-duty statement by a federal official, assessed against
[17 USC sections 101 and 105, published by the Copyright Office](https://www.copyright.gov/title17/92chap1.html#105).
Section 105's relevant exact text is: “Copyright protection under this title is
not available for any work of the United States Government”. This supports
`public-record` retention for this official statement in the United States;
it is not a blanket license for third-party material, photographs, seals,
or every item on senate.gov. No contrary copyright notice appeared in the
three-page testimony. Only the bounded textual excerpt is retained here.

## Rejected discovery route: State Department archive

Search surfaced the State Department's
[testimony page](https://2021-2025.state.gov/testimony-for-senate-foreign-relations-committee-hearing/)
and [copyright information](https://2021-2025.state.gov/copyright-information/),
but opening both returned a technical-difficulties/forbidden response. A direct
anonymous request for the testimony returned HTTP 200 and 188,863 bytes of HTML
without either the person's name or the opening testimony text. This is **not**
a successful source acquisition. Search snippets were discovery leads only;
no archived State Department text is retained as corpus evidence or counted as
an additional independent source. The eligible Senate publication above was
reached through its own public hearing page, not by circumventing the archive.
