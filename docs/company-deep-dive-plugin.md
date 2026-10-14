# company-deep-dive-plugin → chief-of-rust: capability map

_Researched 2026-10-14. Question: add all functionality of
`/Users/nicolas/Documents/github/agent-plugins/company-deep-dive-plugin` as its own
"bloomberg-terminal" tab, move the existing person profile into that tab, add a company
profile section beside the person profile that mirrors the deep-dive plugin, and extract
the parts of the plugin that also apply to person profiles. Repo commit: `4e304e9`._

_Path note: this repo has no `docs/research/` convention (it keeps `docs/agents/`,
`docs/meetings/`, `docs/teardown/`, `docs/ux/`), so this note lives beside the other
research notes at `docs/`. It is investigation only; no code was changed._

Sources: the plugin's own tree (version 4.3.7 per `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json`) and this repository's `crates/app`.

---

## Bottom line

- The plugin is **not a library the app can call**. It ships `SKILL.md` workflow
  instructions, 26 stateless public-records collectors behind a stdio MCP server or a
  Python CLI, four local JSON validators, and ~10 shared policy documents
  (`README.md:41-49`). Every behaviour the request names lives in one of those four
  layers, and each layer maps to a different kind of work in the Rust app.
- The current app already has the **person-profile half**: `crates/app/src/people.rs`
  contains identity, merge, evidence, dossier-with-exact-quote-check, HubSpot capture and
  privacy deletion. Its data model (`Person`, `Evidence`, `Claim`, `Dossier` —
  `people.rs:18-61`) is a strict subset of the plugin's entity/source/claim/coverage
  vocabulary, so "extract plugin functionality applicable to person profiles" is largely
  **extending this module**, not porting new code.
- There is **no company entity anywhere** in the app: the only occurrence of "company" in
  source is `Person.company` (a 200-char string field, `people.rs:23`). A company profile
  is new domain surface, not a re-skin.
- The retrieval half is the hard part. The plugin's collectors are Python and depend on
  bundled Protego/pypdf; the app is a single Rust binary whose runtime image ships no
  Python at all (`Dockerfile:17-22`), and no code under `crates/app/src` spawns a
  subprocess (only `crates/app/tests/public_research.rs:6` imports `std::process::Command`,
  to isolate test env). So "all functionality" means **reimplementing collectors in Rust**
  or adding an explicit out-of-process provider, and the note below measures exactly what
  would have to be reimplemented.

---

## 1. What the plugin is, in four layers

| Layer | Files | Nature |
| --- | --- | --- |
| Workflow instructions | `skills/*/SKILL.md` (19), `shared/*.md` (~14) | Prose procedures a host agent follows; not callable code. |
| Retrieval | `scripts/research.py` (2207 ln), `scripts/extensions.py` (304), `scripts/web_extract.py` (395), `scripts/pdf_extract.py`, `scripts/pdf_worker.py` | Credentialless public HTTPS collectors; one evidence envelope per call. |
| Deterministic checks | `scripts/workflow.py`, `ledger_check.py`, `schema_check.py`, `brief_check.py`, `scorecard_math.py`, `research_context.py`, `strict_json.py`, `package_check.py`, `build_package.py` | Standard-library-only JSON validators and arithmetic; no network. |
| Host surfaces | `scripts/mcp_server.py` (463), `.mcp.json`, `.codex-plugin/plugin.json` | stdio JSON-RPC MCP server exposing `research` + 26 typed `research_<action>` tools. |

Bundled third-party code, with license obligations: Protego 0.7.0 (robots),
pypdf 6.19.0 + typing_extensions 4.16.0 (selectable-text PDF) — `THIRD_PARTY.md:1-34`.

---

## 2. Skill inventory (the workflow the tab must reproduce)

Skills are composition instructions, not tools: `shared/retrieval-contract.md:3` says the
host invokes the `research_ACTION` tools (or the CLI) and the skills only describe when to
use them. `shared/workflows.json` assigns each of the 26 collector actions exactly one
owning skill and declares intent→assessment routing.

| Concern | Skill (`skills/<name>/SKILL.md`) | Output contract |
| --- | --- | --- |
| Scope, defaults, authorized sources | `intake` | Research context; defaults: intent `research`, history `unknown`, internal sources `none`, presentation `short`, depth `deep` (`intake/SKILL.md:9-20`). |
| Identity before merging facts | `entity-resolution` | Entity map; two compatible identity attributes per merge (`shared/entity-resolution.md:1-11`). |
| Coverage matrix + frontier | `research-plan` | Question/family matrix, ranked frontier, stop evidence. |
| Retrieval routing | `public-data` | Selects one of the four source-family skills. |
| Website/archive | `web-evidence` | Owns `fetch_url`, `discover_site`, `wayback`. |
| Identifiers/filings/procurement | `official-records` | Owns `sec_*`, `gleif_search`, `wikidata_*`, `usaspending_search`. |
| Passive signals | `public-signals` | Owns `rdap`, `dns`, `crtsh`, `github_search`, `hackernews_search`, `stackexchange_search`, `gdelt_news`, `lever_jobs`, `greenhouse_jobs`, `greenhouse_job`. |
| Scholarly/biomedical/regulatory | `sector-evidence` | Owns `crossref_search`, `europepmc_search`, `clinicaltrials_search`, `openfda_search`, `ror_search`. |
| Company synthesis | `company-profile` | Entity map, facts by topic, timeline, coverage, contradictions, unknowns (`company-profile/SKILL.md:1-28`). |
| Market synthesis | `industry-research` | Market boundaries, value chain, competitors, regulation (`industry-research/SKILL.md:1-31`). |
| Ledger maintenance | `evidence-ledger` | Linked entity/source/claim/coverage records + structural check. |
| Factual support | `claim-verification` | Per-claim clause check against actual excerpts, including absence claims. |
| Three assessments | `customer-fit`, `partner-fit`, `competitor-battlecard` | One 3-criterion, 0–3/U rubric each (`shared/rubrics/*.md:1-17`). |
| Score arithmetic | `scorecard-arithmetic` | Known subtotal, rated criteria, possible range out of 9. |
| Composition + validation | `research-brief`, `brief-validation`, `reference-checker` | Template headings, inline citation syntax, integrated corrections (`shared/brief-templates/short.md:5-26`, `long.md:5-33`). |

Notable product rules the app would have to carry, not just copy: presentation length is
independent of retrieval depth (`shared/research-protocol.md:3-7`); every applicable
source family needs evidence, a bounded empty search, an access failure, or a stated
not-applicable reason, and "marking everything not applicable to save effort fails the
protocol" (`research-protocol.md:29-31`); absence claims are scoped to inspected evidence
(`shared/evidence-contract.md:37`).

---

## 3. Retrieval surface: 26 actions

Dispatch and schemas: `scripts/mcp_server.py:249-263` builds one tool per action from the
registry at `mcp_server.py:15-124`. Transport is line-oriented JSON-RPC over stdin/stdout
supporting initialize / `tools/list` / `tools/call` (`mcp_server.py:446-463`,
`mcp_server.py:384-395`). CLI equivalent:
`python3 scripts/research.py ACTION --json '{…}'`,
compact JSON on stdout, exit 2 on `status == "error"` (`research.py:2180-2207`).

### 3.1 Envelope and transport policy (shared by all collectors)

Each result carries action, source, request/final URL, retrieval time, HTTP status,
`content_sha256`, status, truncation and applicable counts/cursors (`research.py:321-380`).
Transport defaults: 2 MB response cap, 18 s timeout, 5 redirects, ≥1 s between requests
(`research.py:28-36`). Public-HTTPS-only, DNS pinned per request, unsafe redirects and
credential-like query fields rejected (`research.py:43-164`); gzip, BOM/HTTP/meta charset
handled in `decode` (`research.py:382-407`). Rate/robots: `discover_site` reads
`/robots.txt` and applies Protego with crawler identity `company-deep-dive-plugin`,
withholding crawling when robots is unavailable or oversized except 404/410
(`research.py:1168-1237`).

Contact handling is a distinct subsystem: `SEC_ACTIONS` + `wikidata_*` +
`crossref_search` resolve an operator contact at runtime from `scripts/contact_config.py`
(parsed as a literal assignment, never executed), fail before network access with
position-only diagnostics, and redact echoes from output through up to two URL-encoding
layers (`contact_policy.py:10-22,73-194`; `contact_redaction.py:12-167`). The app has no
equivalent; its only outbound-identity convention is a fixed `User-Agent:
Found42-Chief-of-Staff/0.1` (`crates/app/src/integrations.rs:520`).

### 3.2 The actions

| Group | Actions | Endpoint / source; caps (from `shared/tool-guide.md` and the code) |
| --- | --- | --- |
| Web + archive | `fetch_url`, `discover_site`, `wayback` | Arbitrary public page; `max_bytes` 1,024–2,000,000; text slice 30,000 chars, 500 links, 100 JSON-LD (`research.py:807-859`). Same-host crawl `max_pages` 1–50 (default 20), 120 s deadline. Wayback CDX, `limit` ≤100, date bounds `YYYY[MM[DD]]`. |
| SEC | `sec_tickers`, `sec_submissions`, `sec_companyfacts`, `sec_companyconcept` | `data.sec.gov`; companyfacts pages by concept (default 20, max 100, `offset`/`next_cursor`), 20 MB upstream / 500 KB output (`research.py:1686-1826`). |
| Identity | `gleif_search`, `wikidata_search`, `wikidata_entity` | GLEIF LEI records; Wikidata entity search/entity JSON (both are contact-bearing for Wikidata). |
| Domain signals | `rdap`, `dns`, `crtsh` | rdap.org redirect; Google Public DNS (A/AAAA/MX/TXT/NS/CNAME); crt.sh JSON (explicitly experimental). |
| Developer/community | `github_search`, `hackernews_search`, `stackexchange_search` | Anonymous GitHub search (kind repositories/users/commits/issues), HN Algolia, Stack Exchange advanced search. |
| News | `gdelt_news` | GDELT DOC; `limit` ≤250, `timespan` 1–90 d, 5 s interval (`extensions.py:53-90`). |
| Hiring | `lever_jobs`, `greenhouse_jobs`, `greenhouse_job` | Public board GETs; Greenhouse splits enumeration from per-job descriptions (`extensions.py:116-153`). |
| Sector | `crossref_search`, `europepmc_search`, `clinicaltrials_search`, `openfda_search`, `ror_search` | Crossref polite pool (contact), Europe PMC cursor, ClinicalTrials v2 page tokens, openFDA allowed datasets (`skip` ≤25,000), ROR v2. |
| Spending | `usaspending_search` | POST spending_by_award across six award-type groups; reports per-group coverage and unqueried groups (`research.py:2030-2178`). |

### 3.3 Extraction internals worth knowing before reimplementing

`web_extract.py` is a dependency-free `HTMLParser` producing metadata (title, description,
canonical, language, Open Graph), main text, heuristic Markdown, links with raw +
`resolved_href`, and JSON-LD; `web_extract.py:18-88,250-393`. Continuation is
hash-guarded: any nonzero `text_offset`/`link_offset`/`json_ld_offset`/`pdf_page_offset`
requires `expected_sha256`, and a mismatch returns `content_changed` /
`restart_required` instead of mixing slices (`research.py:743-775`). PDF text runs in an
isolated worker (2 MB input, 8 s timeout, 6 s CPU, 8 MB stream limits; page offset
0–100,000, 1–20 pages, 10,000 chars/page) and reports partial access where Unix CPU
controls are absent (`pdf_worker.py:10-117`; `shared/scraping.md:23-29`).

---

## 4. Deterministic checks (pure functions the app can port verbatim)

| Helper | Interface | Semantics |
| --- | --- | --- |
| `workflow.py` | `plan PATH`, `ledger PATH`, `score S S S`, `brief PATH --presentation {short,long}` | JSON out; exit 0 valid / 1 invalid (`workflow.py:31-67`). |
| `research_context.py` | `plan(context)` | Applies intake defaults, validates explicit values, returns selected assessments + fixed stages (`research_context.py:11-48`). |
| `ledger_check.py` | `check(ledger)` | ID uniqueness, reference resolution, credential-free HTTP(S), excerpt-requires-inspection, coverage/count invariants (`ledger_check.py:12-27,29-149`). |
| `schema_check.py` | `validate(value, schema)` | Restricted JSON-Schema vocabulary, fails closed on unsupported keywords (`schema_check.py:12-48,50-144`). |
| `brief_check.py` | `check(text, presentation)` | Required headings exactly once in order (fenced blocks ignored) + inline URL syntax (`brief_check.py:11-65`). |
| `scorecard_math.py` | `calculate(scores)` | Exactly three 0–3/U values; known subtotal, rated criteria, possible range, max 9 (`scorecard_math.py:4-21`). |
| `strict_json.py` | `loads(text)` | Rejects NaN/Infinity and overflow floats (`strict_json.py:7-22`). |

The ledger vocabulary itself is the contract to port (`shared/evidence-ledger.schema.json`,
556 lines). Required root keys: `schema_version`, `context`, `entities`, `sources`,
`claims`, `coverage`, `frontier`. Closed value sets worth copying into Rust enums:

- access state: `retrieved`, `empty`, `blocked`, `error`, `partial`, `snippet_only`,
  `not_searched`, `skipped`, `not_applicable`;
- inspection scope: `full_returned`, `selected_excerpts`, `metadata_only`, `not_inspected`;
- source type: `official_disclosure`, `official_record`, `independent_reporting`,
  `research`, `community`, `user_context`, `internal`;
- claim status: `supported`, `self_reported`, `inference`, `user_context`, `unsupported`,
  `contradicted`, `unresolved`;
- coverage state: `covered`, `bounded_empty`, `partial`, `blocked`, `error`,
  `not_searched`, `skipped`, `not_applicable`.

`CODING_STANDARDS.md` ("Every declared value is reachable") applies directly here: each
of these enums needs a named writer, or the port will declare states it cannot produce.

---

## 5. Company-specific vs reusable for people

This is the split the request asks for. The plugin's own vocabulary is company-framed
("company", "entity", "issuer"), but most mechanics are subject-agnostic.

| Capability | Company-specific? | Reusable for a person profile | Evidence |
| --- | --- | --- | --- |
| Intake scope/defaults/routing | framing only | Yes — intent/depth/presentation/as-of defaults are subject-independent | `intake/SKILL.md:9-20`; `research_context.py:11-48` |
| Evidence envelope + hash-guarded continuation | no | Yes, unchanged | `research.py:321-380,743-775` |
| Ledger vocabulary + validators | no | Yes, unchanged | `evidence-ledger.schema.json`; `ledger_check.py` |
| Entity resolution (aliases, same-name, relationships) | mostly | Yes, and *more* needed: people have name collisions, handles and employers | `shared/entity-resolution.md:1-11` |
| Web/archive/PDF retrieval | no | Yes | `web-evidence/SKILL.md` |
| Public signals (DNS/CT/GitHub/HN/Stack Exchange/GDELT) | org-oriented usage | Partly — handle/repo/discussion signals apply to public figures with different interpretation caveats | `public-signals/SKILL.md` |
| Hiring boards (Lever/Greenhouse) | yes | No (person has no job board) | `extensions.py:116-153` |
| SEC filings/XBRL, GLEIF LEI, USAspending | yes | No as-is; the *shape* (official record with reporting period and entity scope) transfers | `official-records/SKILL.md` |
| Sector records (Crossref, Europe PMC, trials, openFDA, ROR) | sector-bound | Partly — author/affiliation search is a real person signal | `sector-evidence/SKILL.md` |
| Company profile synthesis sections | yes | Needs a person-shaped section set: roles, affiliations, public statements, dated activity, adverse records | `company-profile/SKILL.md:15-28` |
| Industry research | yes | No (optional context only) | `industry-research/SKILL.md` |
| Fit scorecards (customer/partner/competitor) | yes | No direct analogue; a person-fit rubric would be new design | `shared/rubrics/*.md` |
| Claim verification + absence-claim discipline | no | Yes, unchanged, and already partly implemented in the app | `claim-verification/SKILL.md`; `people.rs:674-810` |
| Brief templates | yes | Needs a person brief template | `shared/brief-templates/*.md` |
| Contact/robots/redaction policy | no | Yes | `contact_policy.py:173-194`; `research.py:1168-1237` |

Two boundaries the note takes seriously: hiring-board, SEC, LEI and procurement
collectors have **no person analogue** and inventing one would be a new capability, not a
port. Conversely the plugin has **no people-specific collector at all** — a person
profile's evidence in the app today comes from user-pasted excerpts plus one SearXNG
snippet search (`people.rs:705-724`).

---

## 6. Current app surface that the tab would touch

### 6.1 Navigation today (two hard-coded places, plus a test)

| Where | Content |
| --- | --- |
| `crates/app/templates/shell.html` (3 lines) | One `<nav aria-label="Products">` with five links: `/meetings`, `/content-scout`, `/content-research`, `/people`, `/tasks`. |
| `crates/app/src/routes.rs:47-82` | The home page card loop — the same five tuples `(url, title, detail, kind)` with a live record count per `kind`. |
| `crates/app/tests/web.rs:27,36,58` | Asserts `/people` → `People` and the nav's `aria-label`. |

Adding a tab therefore means editing the shell nav, the home-card loop, and the route
merges at `crates/app/src/routes.rs:24-30` (`crate::people::router()` is merged at line 28).
There is no tab/registry abstraction; five is simply enumerated three times.

### 6.2 Person profile: the existing implementation to move and extend

| Concern | Symbol / route | Line |
| --- | --- | --- |
| Records | `Person` (name, email, role, company, notes, profile_url, archived, merged_into, version, timestamps) | `people.rs:18-31` |
| | `Evidence` (title, url, text, kind ∈ manual/public/transcript, created_at) | `people.rs:33-41` |
| | `Claim` (text, source_id, quote), `Dossier` (person_version, question, claims, unknowns, evidence, run_id, search_coverage) | `people.rs:43-61` |
| Routes | `/people` (list + create), `/people/{id}` (detail + edit), `…/archive`, `…/restore`, `…/merge`, `…/privacy-delete`, `…/evidence` (+`/{source}` remove), `…/research`, `…/hubspot`, `…/dossiers/{dossier}` | `people.rs:65-75` |
| Identity merge | `merge()` moves evidence to the canonical person, appends an audit note, archives the duplicate | `people.rs:439-503` |
| Privacy | `privacy_delete()` purges persons, revisions, evidence and `people.%` job snapshots after a typed `DELETE` | `people.rs:360-434` |
| Research run | `people.research` job: optional SearXNG search → evidence → Mistral JSON → **exact-substring quote validation** → immutable `Dossier` | `people.rs:591-810` |
| CRM | `people.hubspot` job: requires exactly one exact-email contact; saves fields as `kind: "crm"` evidence | `people.rs:814-906` |
| Storage | kinds `person`, `person_evidence`, `dossier` in the shared `record`/`revision` tables | `people.rs:187-207,518-556,780-800`; `store.rs:6-8` |

The dossier logic is the closest existing analogue to the plugin's evidence contract: it
caps evidence at 400,000 chars, caps claims/unknowns at 40, rejects quotes that are not
exact substrings, and overwrites model-written claim labels with the source title so a
heading cannot smuggle an assertion (`people.rs:732-770`).

### 6.3 Cross-cutting infrastructure a company profile should reuse, not duplicate

| Need | Existing seam | Where |
| --- | --- | --- |
| Durable, revisioned records | `store::get/list/put/delete/purge` over `record` + `revision`; `Db` async wrappers | `store.rs:6-8,11-84` |
| Background Runs with lease, retry and immutable attempts | `work::enqueue` (dedup on `(kind, dedup_key)`), `claim`, `run_once`, `dispatch` by kind prefix | `work.rs:21-29,67-187,160-187` |
| Run UI | `/runs`, `/runs/{id}`, `/runs/{id}/retry` | `work.rs:188-302` |
| Model calls | `LlmProvider` trait (`complete`, `complete_json`, `complete_schema`), Mistral Large 4 + mock | `llm.rs:14-58,64-93` |
| Typed judgments | `Judge` trait, `TypeSafe` over OpenRouter `/v1/systemone`, `validate`, `probability` | `judgments.rs:29-33,74-83,213-224,309-317` |
| Public web fetch | `fetch_public` — HTTPS, DNS-pinned per redirect, no proxy, 2 MB, 30 s, 40,000-char text slice, script/style stripped | `integrations.rs:447-541` |
| Search | `search` over SearXNG JSON, ≤8 unique hits, snippet truncation at 6,000 chars, `SearchCoverage` facts | `integrations.rs:236-333` |
| Coverage display | `web::search_coverage` renders the deterministic collection facts | `web.rs:49-115` |
| Page chrome | `web::page` + Askama `shell.html`; `web::escape` for all interpolated text | `web.rs:14-33` |

Two structural facts matter for planning: (a) every route module returns hand-built HTML
strings through `web::page`, so "a company profile section beside the person profile" is
string composition in a new `company.rs`, not a template to add; (b) the worker dispatches
purely on the job-kind prefix (`work.rs:198-206`), so a `company.research` kind needs a
branch there plus an `execute` in the new module.

---

## 7. Mapping the request onto the app

### 7.1 The tab

The request's three moves are separable:

1. **New "bloomberg-terminal" tab.** Add one `(url, title, detail, kind)` tuple to
   `routes.rs:47-82`, one link to `shell.html`, one `merge` to `routes.rs:24-30`, and
   update the assertions in `tests/web.rs:27,36`. There is no existing precedent for a
   tab that aggregates other tabs, so "move existing person profile into that tab" is a
   product decision with two mechanical readings: (a) `/people` stays but the nav entry
   moves under the new tab's page, or (b) route prefixes change. Reading (a) leaves
   `work.rs` dispatch, stored kinds and every existing link valid; reading (b) touches the
   nav, the home card, `tests/web.rs` and `tests/people_tasks.rs`. The note records both;
   the cheaper one is (a).
2. **Company profile section beside the person profile.** New module paralleling
   `people.rs`: a `Company` record type (legal name, domain, jurisdiction, identifiers,
   aliases, relationships) plus `CompanyEvidence`, `CompanyClaim`, `CompanyProfile`
   revision — i.e. the plugin's entity/source/claim shape, whose Rust enums are listed in
   §4.
3. **Extract person-applicable plugin behaviour.** Per §5: hash-guarded retrieval,
   the ledger vocabulary, entity resolution for names/handles, claim verification with
   absence-claim discipline, source/inspection coverage disclosure, and a person-shaped
   brief. The app already implements a strict subset (exact-quote dossiers,
   `search_coverage`); the port extends rather than replaces it.

### 7.2 What "all functionality" costs, stated honestly

| Plugin capability | Nearest path in Rust | Cost / blocker |
| --- | --- | --- |
| Evidence envelope, hashing, continuation guard | Direct port; `content_sha256` already exists in spirit in `fetch_public` (no hash) — add one | Moderate |
| HTML main-text/Markdown/metadata/JSON-LD/link extraction | `scraper` + `html5ever` are already dependencies (`crates/app/Cargo.toml`); needs a Markdown heuristic and a JSON-LD pass | Moderate |
| Sitemap/feed discovery with robots | Protego logic would have to be reimplemented (robotstxt-style parsing is not in the dependency set) | Moderate–high |
| Selectable-text PDF | **Blocked as-is**: the app has no PDF dependency and the runtime image has no Python (`Dockerfile:17-22`) | New dependency or new provider |
| 17 JSON API collectors (SEC, Wikidata, GLEIF, DNS, CT, GitHub, HN, SE, GDELT, Crossref, Europe PMC, ClinicalTrials, openFDA, ROR, USAspending, Lever, Greenhouse) | Each is a bounded `reqwest` adapter feeding the same envelope; the plugin's per-action caps, cursors and status vocabulary are the specification | Large but mechanical; ~1 module per source family mirrors the plugin's skill split |
| Contact-bearing providers | Needs a runtime contact setting analogous to `contact_config.py`, plus the echo-redaction rule and a provider-host allowlist (`contact_policy.py:173-194`) | Small but must not be skipped |
| Ledger schema + validators | Port `evidence-ledger.schema.json` into typed records with `serde`, or keep the schema and port the restricted validator | Moderate |
| Skill prose (intake → brief, 19 skills) | Becomes prompts + deterministic gates, exactly as `meetings/debrief.rs` already turns prose procedure into `noul`/`choice`/`score` questions with `SUPPORT = 0.85` / `CONFIDENCE = 0.80` thresholds (`debrief.rs:11-27,254-275`) | Design work, not porting |
| Fit scorecards | Three 3-criterion 0–3/U rubrics; arithmetic is already a pure function to port (`scorecard_math.py:4-21`) | Small |

### 7.3 Prerequisites and boundaries this note refuses to blur

- No collector may be described as "ported" until it has its own envelope, caps, cursor
  and error vocabulary; the plugin's own documentation insists that a transport `ok` is
  not relevance, completeness or factual support (`shared/tool-guide.md:67-71`).
- Person-specific public research has no plugin collector. Adding one is new capability
  with its own sensitivity review; the plugin's subject is a business, and its source
  catalogue's excluded list (paid aggregators, login-only LinkedIn/Glassdoor) would bind
  person research even harder (`shared/source-catalog.md:45-51`).
- The app's existing public-web boundary is deliberately narrow — HTTPS/HTTP, public IPs
  only, no proxy, no credentials, text content types, 2 MB (`integrations.rs:447-541`).
  A ported `discover_site` must extend that boundary rather than weaken it.

---

## 8. Where to start, if this becomes a ticket

1. Freeze the evidence ledger port (§4) — everything else writes into it.
2. Add `crates/app/src/company.rs` mirroring `people.rs` routes/records, reuse `work`
   dispatch on a `company.` prefix, and put both pages under the new tab.
3. Extract the person-applicable plugin behaviours into shared helpers so `people.rs` and
   `company.rs` call one implementation. The two exact-quote checks (`people.rs:755-770`
   today) are the first candidates.
4. Split retrieval into one Rust module per source family, in the plugin's owner order
   (web → official → signals → sector), each behind the same envelope type.

## Sources

- Plugin: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.mcp.json`,
  `README.md`, `THIRD_PARTY.md`, `skills/*/SKILL.md` (19),
  `shared/{research-protocol,evidence-contract,entity-resolution,retrieval-contract,
  source-catalog,tool-guide,workflow-tools,scraping,semantic-checks}.md`,
  `shared/brief-templates/{short,long}.md`, `shared/rubrics/*.md`,
  `shared/{workflows.json,evidence-ledger.schema.json}`,
  `scripts/{research,mcp_server,extensions,web_extract,pdf_extract,pdf_worker,workflow,
  ledger_check,schema_check,brief_check,scorecard_math,research_context,strict_json,
  contact_policy,contact_redaction}.py`.
- App (read only): `crates/app/src/{routes,web,people,work,store,llm,judgments,
  integrations,settings,content}.rs`, `crates/app/templates/shell.html`,
  `crates/app/tests/{web,people_tasks,public_research}.rs`, `crates/app/Cargo.toml`,
  `Dockerfile`, `docker-compose.yml`, `AGENTS.md`, `CODING_STANDARDS.md`, `README.md`.

## Un-grounded claims

- No claim here rests on a secondary source. Every plugin statement is cited to the
  plugin's own files; every app statement to this repository's files at `4e304e9`.
- **[READ, NOT EXECUTED]** The plugin's collectors, MCP server, validators and PDF worker
  were read, not run, and no `python3 -m unittest` or network call was made (the assigned
  constraint forbade builds/tests).
- **[INFERENCE]** Effort labels in §7.2 ("moderate", "large but mechanical") are my
  judgement from the cited code and are not measured.
- Not determined: whether the plugin's `evals/` prompts (20 directories) are meant to ship
  to consumers or are maintainer-only; they are packaged in the ZIP per
  `build_package.py:28-79` but `shared/workflow-tools.md` never invokes them.

## 9. Deeper extraction review

Further source inspection and Jev deliberation distinguish functional parity from
copying collector names. Findings below are read-only; collectors and validators
were not executed.

### Shared semantics to preserve

- Track actual inspection separately from retrieval: `full_returned`,
  `selected_excerpts`, `metadata_only`, `not_inspected`. A fetched page is not
  necessarily inspected evidence (`shared/evidence-contract.md:13-29`).
- Review material claim clauses against subject, dates, metric scope, origin and
  contrary evidence; exact quote membership alone is insufficient
  (`skills/claim-verification/SKILL.md:8-18`).
- Resolve merges using two compatible identity attributes; names, redirects,
  certificates and registry-discovery hints are not standalone ownership proof
  (`shared/entity-resolution.md:3-11`).
- Supplied-only checks preserve an unexecuted frontier. Internal retrieval
  authorization does not automatically authorize sharing with a judgment provider
  (`shared/evidence-contract.md:5-9`; `shared/semantic-checks.md:5-7`).
- Preserve the iterative research frontier, alias/locale expansions, original
  citation follow-through, counterevidence, pagination and documented stopping
  boundaries (`shared/research-protocol.md:33-50`).
- Apply corrections to the actual saved brief and ledgers, then inspect the
  corrected draft; reference checking is not a decorative final section
  (`skills/reference-checker/SKILL.md:8-15`).

### Assessment semantics previously understated

The three fit workflows do not inherently require two researched companies.
They require supplied offering, target-buyer, capability or partnership context.
The user's two-company comparison requirement is a Terminal product decision,
not a prerequisite imposed by the plugin
(`shared/rubrics/{customer-fit,partner-fit,competitor-battlecard}.md:5-17`).

Persist comparison direction and this context, not merely two company IDs.
This is a design inference. Automatic comparison resynthesis should consume the
saved context and evidence without reopening external collection, as requested.

Unknown criterion scores are `U`, not zero. Exactly three criteria yield a known
subtotal, rated-criterion coverage and possible total range out of nine.
Competitor scores indicate competitive pressure, not suitability
(`scripts/scorecard_math.py:4-22`; `shared/rubrics/competitor-battlecard.md:5-17`).

Structural ledger validation and Markdown heading/link validation cannot establish
factual support, temporal availability or source independence
(`scripts/ledger_check.py:79-148`; `scripts/brief_check.py:11-65`).
Do not port these checks as a single "verified" badge.

### Retrieval parity beyond API adapters

- Discovery maintains page and sitemap queues, prioritizes relevant paths, reads
  feeds and reports unfinished work (`scripts/research.py:1113-1485`).
- Nonzero content offsets require an expected hash. Changed content returns
  `partial` with `content_changed` and `restart_required`, rather than combining
  incompatible slices (`scripts/research.py:744-775,1616-1636`).
- PDF extraction runs in an isolated worker with bounded input, CPU, wall time
  and stream decompression. A Rust parser alone is not equivalent isolation
  (`scripts/pdf_extract.py:10-54`; `scripts/pdf_worker.py:10-118`).
- Contact configuration is parsed without execution, and contact echoes are
  redacted through raw, singly and doubly encoded forms, including structured
  keys (`scripts/contact_policy.py:46-71,145-172`;
  `scripts/contact_redaction.py:12-167`).
- Continuation is provider-specific: SEC older filing shards and oversized
  concepts, Europe PMC cursor marks, ClinicalTrials tokens, openFDA skip, ROR
  pages, and saturated GDELT time windows are different unfinished-work contracts
  (`scripts/research.py:1686-1826`; `shared/tool-guide.md`).
- USAspending spans six award groups with group-specific financial fields and
  records unqueried groups after a blocked response
  (`scripts/research.py:2030-2178`).

### Maximum person-applicable extraction

These are proposed adaptations, not existing plugin person workflows:

- Evidence-backed role, employer, board and institutional affiliation graphs with
  effective dates (`skills/company-profile/SKILL.md:17`;
  `shared/evidence-ledger.schema.json:67-147`).
- Historical professional dossiers and dated changes, not just current summaries
  (`skills/company-profile/SKILL.md:19-22`).
- Scholarly authorship, attributable developer/public outputs and evidenced
  investigator roles, with identity and metadata/full-text distinctions
  (`skills/sector-evidence/SKILL.md:8-14`;
  `skills/public-signals/SKILL.md:8-16`).
- Industry context for evidenced professional roles, scoped adverse records and
  authorized relationship history without inferring personal needs or purchasing
  authority (`skills/industry-research/SKILL.md:8-18`;
  `skills/company-profile/SKILL.md:20,24`).
- Person-specific brief headings backed by the same complete evidence, coverage,
  correction and reference-check pipeline
  (`shared/brief-templates/{short,long}.md`;
  `skills/reference-checker/SKILL.md:8-15`).

Corporate filings, organizational registries and hiring data remain attributed to
organizations; linked affiliation context must not become personal facts.
Maximum extraction does not authorize personal-contact harvesting, breach-data
workflows or vulnerability scans (`shared/source-catalog.md:43`).

### Jev results and recommended design

Parent verification: four evidence/identity/scope claims verified, confidence
1.00, no review flags. Workflow scout: six findings verified, confidence
0.98–1.00, no review flags. Collector scout: five findings verified, confidence
0.80–1.00; encoded-redaction verification was the weakest (supports 0.87,
contradicts 0.02, says-nothing 0.11). These are judgments over supplied source
excerpts, not runtime proof.

Final `jev_decide` selected `shared_protocol_plus_typed_context`, confidence 1.00,
all three requirements supported and no warnings. Alternatives were literal
company cloning and collector-plus-summary extraction.

**Design recommendation:** one persisted research/evidence/inspection engine,
subject-specific adapters and briefs, provider-specific continuation and safety
contracts, retained semantic judgments and integrated corrections, plus distinct
company assessment/comparison context. This remains a design recommendation,
not an implemented or verified feature.
