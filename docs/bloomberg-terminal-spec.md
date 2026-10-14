## Problem Statement

The Workspace currently offers Person Profiles with canonical identities, saved evidence, question-driven research dossiers and CRM capture, but no Company Profiles. Company research requires a separate company-deep-dive plugin. Its broad collection, iterative investigation, evidence accounting and verification practices are not available through either profile type in the app.

The user wants one Bloomberg Terminal product area that unifies person and company research and ports the maximum meaningful functionality of the plugin into each profile type. A collector list or generated report template is insufficient: the feature must preserve the research protocol, provenance, inspection, uncertainty, continuation, corrections and assessments that make the plugin useful.

## Solution

Replace the standalone Person Profiles product entry with Bloomberg Terminal. Its landing page presents adjacent Person Profiles and Company Profiles sections, adapting sensibly on narrow screens. Terminal routes become canonical; old person routes are removed without redirects. Existing Workspace records and person capabilities remain usable through the new routes.

Implement the functionality natively in Rust. Both profile types offer an explicit Run full research action backed by durable Runs and a shared persisted research engine. Company research accounts for all 26 plugin collector actions and executes every applicable non-comparison workflow. Person research uses the maximum applicable collection and synthesis capabilities with person-specific questions, identities, relationships and brief sections. Corporate evidence may supply affiliation context but must never be misattributed as a personal fact.

Research iterates over a persisted frontier, preserves original sources and actual inspection scope, follows material references and provider continuation, checks contradictory evidence, and produces corrected briefs with detailed evidence and coverage artifacts. Concise presentation does not reduce research depth.

Comparison workflows are requested explicitly with two Company Profiles. Comparisons preserve direction and assessment context. Saving either company automatically regenerates affected comparisons from the latest saved profile and evidence snapshots without starting external collection. Missing facts remain unknown.

## User Stories

1. As a Workspace user, I want a Bloomberg Terminal top-level tab, so that company and person intelligence is available in one product area.
2. As a Workspace user, I want adjacent Person Profiles and Company Profiles sections, so that I can move between related research without switching products.
3. As a Workspace user, I want the terminal usable on narrow screens and by keyboard, so that the richer research interface remains accessible.
4. As an existing user, I want my saved people, evidence, dossiers and CRM history available under canonical terminal routes, so that the move does not lose data.
5. As a Workspace user, I want every app-generated profile link to use terminal routes, so that navigation, meeting context and Run results remain usable after old routes are removed.
6. As a researcher, I want persistent Company Profiles, so that identity, evidence and research history survive restarts.
7. As a researcher, I want to create and edit a company's name, website, jurisdiction, identifiers and known aliases, so that research has meaningful identity anchors.
8. As a researcher, I want profile edits checked against their saved version, so that concurrent saves do not silently overwrite changes.
9. As a researcher, I want to retain separate same-name candidates and dated relationships, so that unresolved identity does not contaminate a dossier.
10. As a researcher, I want brands, products, legal entities, parents and subsidiaries distinguished, so that facts stay attached to their actual subjects.
11. As a person-profile user, I want existing identity editing, search, archive/restore, duplicate merge and privacy deletion retained, so that expanded research does not remove existing capabilities.
12. As a person-profile user, I want saved excerpts and exact-email CRM capture retained, so that my existing evidence remains usable.
13. As a researcher, I want an explicit Run full research action on either profile type, so that I control when broad external collection begins.
14. As a researcher, I want an ordinary profile save not to start external collection, so that editing identity is not a hidden network operation.
15. As a researcher, I want research questions, geography, depth, presentation, dates and scope saved with each Run, so that I can understand its purpose later.
16. As a researcher, I want short and long briefs independent of quick, deep and exhaustive research depth, so that a concise output can still rest on broad evidence.
17. As a researcher, I want as-of research to separate evidence available after the cutoff, so that historical dossiers do not accidentally use future information.
18. As a researcher, I want user-supplied history and offering context attributed rather than silently corroborated, so that my inputs are not presented as independent facts.
19. As a company researcher, I want every plugin collector action accounted for, so that missing collection cannot hide behind a successful summary.
20. As a company researcher, I want all applicable non-comparison research and synthesis workflows included in a full Run, so that I do not have to invoke each plugin skill manually.
21. As a researcher, I want official websites, legal pages, product documentation, pricing, feeds and sitemaps explored, so that primary evidence is not limited to search snippets.
22. As a researcher, I want archived pages and dated changes investigated, so that enduring history and changed claims remain visible.
23. As a researcher, I want selectable-text PDF evidence with page locators and extraction limits, so that filings, reports and CVs can support inspectable claims.
24. As a company researcher, I want official identifiers, filings, financial concepts and procurement evidence, so that legal and financial research is based on appropriately scoped records.
25. As a company researcher, I want public domain, developer, news, community and hiring signals, so that operational research extends beyond marketing pages.
26. As a sector researcher, I want scholarly, biomedical, trial, regulatory and institutional sources where relevant, so that industry-specific evidence is included.
27. As a person researcher, I want attributable public websites, archives, publications, developer work, discussions and news investigated, so that a profile reflects professional evidence rather than a single search summary.
28. As a person researcher, I want namesakes, aliases, handles and publication authors disambiguated, so that another person's work does not become part of this profile.
29. As a person researcher, I want roles, employers, board memberships and institutional affiliations represented with evidence and dates, so that current and historical relationships are not conflated.
30. As a person researcher, I want relevant investigator roles and scholarly affiliations retained only when attributable, so that organization-level research is not assumed to describe an individual.
31. As a person researcher, I want company evidence displayed as explicitly linked affiliation context, so that an employer's finances or hiring do not become personal facts.
32. As a person researcher, I want industry context adapted to evidenced professional roles, so that I understand the environment without invented personal needs or authority.
33. As a researcher, I want aliases, native-language names and jurisdiction branches explored where applicable, so that identity and coverage are not English-name-only.
34. As a researcher, I want material citations followed to original sources, so that repeated copies of a release do not masquerade as independent corroboration.
35. As a researcher, I want counterevidence, corrections and incompatible versions retained, so that synthesis does not hide contradictions.
36. As a researcher, I want allegations, announced transactions, forecasts and observed facts distinguished, so that wording reflects evidential status.
37. As a researcher, I want financial values to retain subject, reporting period, currency, units and calculation inputs, so that incompatible metrics are not combined.
38. As a researcher, I want event, publication, update, capture, reporting and retrieval dates distinguished, so that newly fetched content is not assumed current.
39. As a researcher, I want each source's access state, origin, hash, limits and actual inspection scope retained, so that retrieval success is not mistaken for complete review.
40. As a researcher, I want exact excerpts and locators linked to atomic claims, so that I can inspect what supports each assertion.
41. As a researcher, I want self-report, inference, user context, unsupported, contradicted and unresolved claims distinguished, so that uncertainty is not flattened into a single score.
42. As a researcher, I want successful empty queries distinguished from blocked, failed, skipped and unattempted searches, so that a failed search is not reported as absence of records.
43. As a researcher, I want every applicable source family to show its actual search boundary, remaining work and stop reason, so that a brief cannot imply universal completeness.
44. As a researcher, I want unfinished leads, pages and cursors persisted and resumable, so that partial Runs retain useful progress.
45. As a researcher, I want content changes detected between continuation slices, so that evidence from different source versions is never silently combined.
46. As a researcher, I want bounded discovery batches to remain distinct from research completion, so that a page cap does not prematurely close a family.
47. As a researcher, I want Jev screening, support checks, source comparisons, identity selection, lead ranking, extraction audits and uncertainty checks used at their appropriate steps, so that semantic decisions are evidence-aware.
48. As a researcher, I want actual judgment distributions, warnings, failures and corrections retained, so that a tool verdict does not erase uncertainty or become invented confidence.
49. As a researcher, I want unsupported material clauses corrected, qualified or removed from the saved brief and ledgers, so that final output reflects the checks actually performed.
50. As a researcher, I want structurally valid ledgers and usable public citations, so that research artifacts are consistent without pretending structural validation proves truth.
51. As a researcher, I want absence claims limited to the inspected dataset, query and period, so that incomplete research is not presented as a clean bill of health.
52. As a company researcher, I want company, industry, history, offering, financial, operational and adverse-evidence synthesis, so that the full dossier is richer than the concise brief.
53. As a person researcher, I want person-appropriate profile, professional timeline, public-work, affiliation, contradiction and unknown sections, so that company templates are not applied mechanically to people.
54. As a researcher, I want short/long briefs and detailed dossier, entity, source, claim, coverage and frontier exports, so that presentation remains concise without losing retained evidence.
55. As a researcher, I want source excerpts and metadata kept only to the extent needed for support, so that the Workspace does not become an unbounded copy of third-party content.
56. As a researcher, I want customer-fit, partner-fit and competitor workflows preserved, so that the original decision-support functionality remains available.
57. As a researcher, I want to explicitly request comparison workflows with two company profiles, so that relational analysis has clear subjects.
58. As a researcher, I want comparison direction and offering, buyer or partnership context saved, so that the intended question survives automatic updates.
59. As a researcher, I want criterion evidence and unknown scores visible, so that missing facts are not scored as failure or hidden through normalization.
60. As a researcher, I want known subtotal, rated coverage and possible score range preserved, so that unknown criteria remain unknown.
61. As a researcher, I want competitive-pressure scores distinguished from customer or partnership suitability, so that opposite meanings are not collapsed into one ranking.
62. As a researcher, I want affected comparisons automatically rewritten after either company is saved, so that I do not manually refresh relational analysis.
63. As a researcher, I want comparison regeneration to use saved evidence without new external collection, so that profile saves do not trigger broad research requests.
64. As a researcher, I want pending or failed comparison regeneration visible and previous output clearly marked, so that old output is not presented as current after an update.
65. As a Workspace administrator, I want to configure the research operator contact, so that contact-bearing providers can be used according to their policies.
66. As a researcher, I want a missing contact to block only affected collectors, so that unrelated research still proceeds with explicit coverage gaps.
67. As a Workspace administrator, I want credentials and contact echoes excluded from evidence, errors and judgment inputs, so that configuration is not exposed by research.
68. As a researcher, I want robots restrictions, provider quotas, backoff and login/paywall boundaries respected, so that breadth does not mean bypassing access controls.
69. As a researcher, I want private-network targets, unsafe redirects and credential-bearing URLs rejected, so that collected links cannot escape the public-web policy.
70. As a researcher, I want supplied-only review to leave additional research unexecuted, so that missing evidence does not silently expand authorized scope.
71. As a researcher, I want authorization to retrieve internal evidence distinguished from permission to send it to a model provider, so that private source handling remains deliberate.
72. As a person-profile user, I want privacy deletion to remove newly retained personal research artifacts and Run snapshots as well as existing ones, so that expanded research does not undermine deletion.
73. As a Workspace user, I want durable Run status, failure details, retry and partial research progress, so that long research remains inspectable across restarts.
74. As a Workspace user, I want stale research fenced when its profile changes, so that output from outdated identity snapshots does not silently become the latest profile.
75. As a Workspace user, I want offline fixtures clearly distinguished from live research and missing judgment configuration disclosed, so that simulated results cannot be mistaken for verified facts.

## Implementation Decisions

### Product and existing-contract cutover

- Bloomberg Terminal replaces the standalone Person Profiles navigation and home entry; person and company sections are adjacent on the terminal landing page.
- Canonical terminal URLs are the only profile routes. Remove old person routes without redirects, aliases or compatibility handlers. Migrate all app-generated links, forms, Run result destinations, meeting references and relevant test/smoke contracts.
- Preserve existing person records and record identifiers rather than recreating identities. Existing identity correction, search/filter, archive/restore, merge, evidence, CRM capture, historical dossier access and privacy deletion remain functional.
- Saved research snapshots retain their original evidential contents. Where persisted destinations require migration, update routing references without rewriting historical source evidence.

### Module and execution design

- Extend the existing product router and forms-first HTML shell with a Terminal module and Company Profile module. Extend the Person Profile module rather than replacing its capabilities with a second implementation.
- Use one shared deep Research module for context, subject identity, evidence, inspection, coverage, frontier, verification and synthesis. Company and person adapters own subject-specific applicability, questions, relationships and presentation.
- Reuse the SQLite Workspace's revisioned records, durable Run queue, worker dispatch, Run UI, model provider and typed judgment interfaces. Do not introduce a parallel queue or a plugin subprocess dependency.
- Implementation is Rust-native. Port collection and deterministic behavior; plugin skills become research orchestration, prompts and checked state transitions, not unexecuted prose.
- Full research starts explicitly. Profile creation/editing does not start external collection. Company saves do trigger the separately specified saved-evidence comparison regeneration.
- Full research is more than one pass: establish identity and coverage, collect and inspect evidence, rank and expand important leads, follow material originals/cursors, synthesize, check, correct and retain unresolved work. Persist progress sufficient to resume safely after interruption.
- Use quick/deep/exhaustive depth and short/long presentation independently; deep/short are defaults. Exhaustive does not promise complete internet knowledge. Record two successive distinct nonproductive expansions when using the plugin's saturation stopping rule; unvisited important families/leads still prevent an unsupported saturation claim.

### Persistent research contract

- Add Company Profile records with canonical identity, website/domain, jurisdiction, identifiers, aliases, relationship references, notes, version and timestamps; provenance is retained for researched fields rather than silently overwriting user identity.
- Persist research context: subject and version, questions, research/as-of dates, geography, depth, presentation, user-history provenance, authorized-source scope and offering/target context.
- Persist an entity map, dated relationships, source ledger, atomic claim ledger, family/question coverage ledger and unresolved frontier. Each artifact has stable identifiers and typed references.
- Sources retain request/final URL, publisher/origin lineage, source type, actual retrieval time, other known date types, hash, transport result, access state, counts/limits, excerpts/locators and actual inspection scope/details. Unknown dates remain unknown.
- Claim statuses retain supported, self-reported, inference, user context, unsupported, contradicted and unresolved distinctions. Numeric claims retain period, currency, unit, entity and estimate/calculation scope; unknown values are not zero.
- Access states distinguish retrieved, empty, blocked, error, partial, snippet-only, not-searched, skipped and not-applicable. Coverage states distinguish covered, bounded-empty, partial, blocked, error, not-searched, skipped and not-applicable. These derive from actual work and reasoned applicability, not planned requests.
- Inspection is independently recorded as full-returned, selected-excerpts, metadata-only or not-inspected. Retrieved counts do not imply inspected counts. Unread material remains visible as unfinished work.
- Preserve provider cursors, queries, dataset/jurisdiction/time boundaries, retrieved/total counts when known, remaining leads, next actions and stopping reasons. Covered means the recorded question has usable evidence within its boundary, not universal completeness.
- Fence research publication against changed, merged, deleted or inactive subjects. Preserve completed historical artifacts while clearly separating them from current research.
- Extend person privacy deletion to all new retained personal research records, revisions and Run snapshots under the existing deletion contract. Do not expand deletion into unrelated meeting history or accepted Tasks.

### Collector parity and applicability

- Preserve all 26 action capabilities: fetch_url, discover_site, wayback; sec_tickers, sec_submissions, sec_companyfacts, sec_companyconcept; gleif_search, wikidata_search, wikidata_entity; rdap, dns, crtsh; github_search, hackernews_search, stackexchange_search; gdelt_news; lever_jobs, greenhouse_jobs, greenhouse_job; crossref_search, europepmc_search, clinicaltrials_search, openfda_search, ror_search; usaspending_search.
- Every full company Run accounts for every action. Execute eligible actions and dependent follow-ups with resolved parameters. Do not submit meaningless requests just to claim all actions ran. Missing identifiers, absent boards, unsuitable sectors and unavailable contacts produce precise applicability, unresolved-prerequisite or access states, not invented successes.
- All applicable non-comparison company workflows run: identity, planning, public retrieval, company synthesis, industry research, evidence maintenance, claim verification, brief composition, structural/citation validation and reference checking. Preserve customer/partner/competitor assessments as described below; relational workflows are explicitly requested rather than forced into every neutral profile.
- Person full research shares web/archive/PDF extraction, attributable Wikidata, public news, developer/community and scholarly evidence, and evidenced investigator roles where applicable. Organizational registries, financials, hiring, regulatory/product and procurement records remain scoped to their organizations or products, including when used as affiliation context.
- Retain source-catalog branching to appropriate official sector/jurisdiction sources and original references. The named collectors are not a justification to discard relevant public primary evidence reachable through safe web retrieval.
- Discovery preserves page and sitemap queues, feeds, path priorities, caps and unfinished work. Bounded batches are not the research completion boundary.
- Extraction preserves relevant HTML text, metadata, links, structured data and selectable PDF text with locators and honest truncation/extraction states. Do not claim OCR or rendered browser content where none was extracted.
- Content continuation is hash-guarded. Nonzero offsets require the expected content hash; mutation requires restart rather than mixing slices.
- Preserve provider-specific continuation and response behavior: recent versus older filing shards, oversized XBRL concepts, cursor marks/tokens, offset/page limits, saturated time windows, ATS listing versus job detail, API error-versus-empty semantics and procurement award-group coverage.
- Preserve timeout, response/output, discovery, page and extraction resource caps, provider pacing/backoff and Retry-After behavior. Broader Rust concurrency must not evade provider pacing.

### Evidence quality, judgments and correction

- Identity merges require compatible evidence anchors; matching names, redirects, domain records or certificates alone do not prove identity/ownership. Keep conflicting candidates separate and relationships dated.
- The family matrix covers identity/ownership, site/offerings, financials, people/operations, hiring, commercial evidence, technology, history, industry/competition, sector/regulation, adverse evidence, community and authorized internal history, adapted meaningfully for people.
- Follow material references to originals and preserve source lineage. Copies of one origin are not independent corroboration. Search counterevidence and retain compatible-versus-incompatible versions rather than averaging contradictions away.
- As-of research excludes later-available evidence from historical factual support and records later discoveries separately. Retrieval dates do not stand in for publication or event dates.
- Exact quote membership and reference resolution remain deterministic. Every material factual claim also receives scoped support review, including subject, dates, metrics, source origin and contrary evidence.
- Use the existing typed Jev judgment capability for the plugin's screening, verification, comparison, selection/ranking, classification, bounded extraction/audit, decision and uncertainty semantics. Persist actual questions, evidence references, distributions, warnings, failures, checked scope and integrated corrections; probabilities are not facts or invented presentation certainty.
- Screening pass does not prove truth. Flagged directives are not followed. Blocked evidence is not used pending human resolution; malformed/failed judgments are visible operational limits, not clean passes. Unchanged valid judgments are not rerun merely to seek a preferred answer.
- Audit model-written fields against source text; extraction/audit does not prove unseen pixels or inaccessible documents. Preserve no-match and ambiguity outcomes.
- Integrate material corrections into saved briefs and ledgers, then check the corrected output. Unsupported claims are qualified/removed or explicitly unresolved; no verified badge is inferred from structural success.
- Port schema/reference/count invariants, strict JSON behavior, valid URLs, nonfinite-number rejection and score arithmetic. Separate structural, citation and semantic check results.
- Preserve absence-claim boundaries, nonprofit/free-offering distinctions, allegations versus findings, announced versus closed events, forecast versus observed values and self-report versus independent evidence.

### Person-specific synthesis

- Add evidence-backed professional role/affiliation graphs, historical professional timelines, attributable public statements/work, scholarly/developer outputs, relevant industry context, contradictions and scoped adverse records.
- Give person briefs appropriate headings rather than company product/buyer headings. Keep person identity ambiguity and attribution visible throughout synthesis.
- Existing saved-evidence question research and CRM capture remain available alongside full research; maximal extraction is additive to real user capabilities, not permission for personal-life surveillance.
- An employer's customers, revenue, hiring or sector footprint cannot establish the person's needs, authority, finances, conduct or skills. Company context remains labeled and linked.

### Assessments and automatic comparison updates

- Preserve the plugin's customer-fit, partner-fit and competitor-battlecard workflows and three-criterion 0–3/U rubrics. Preserve each criterion's evidence and company/industry contributions; missing offering or relationship context limits scores rather than blocking neutral research.
- Request relational/comparison workflows explicitly with both companies. Persist ordered subjects, selected workflow(s), offering scope, relevant target buyers/capabilities or proposed partnership, and provenance of supplied context. Do not silently infer purchasing authority, budget, capacity, certification, commitment or transaction timing.
- Customer/partner scores describe rubric suitability/evidence; competitor scores describe competitive pressure. Marketing alone does not warrant strongest evidence scoring. Do not create new personal fit/reputation rubrics.
- Exactly three scores yield known subtotal, rated coverage and possible range out of nine. Unknowns are never converted to zero or normalized away; deterministic arithmetic does not choose scores.
- Saving either company atomically schedules automatic regeneration of all affected comparisons from the latest saved profile/evidence snapshots and retained comparison context. The worker performs synthesis and checks only; it does not call collectors.
- Record input versions and publish only output matching the current comparison inputs. A newer save supersedes obsolete queued/in-flight results; the eventual comparison must use the latest saved subjects. Existing durable-queue conventions handle this rather than a second scheduler.
- While regeneration is pending or failed, distinguish previous output from current output and disclose its input versions. Do not discard the last readable report or label it current; expose failure and existing Run retry behavior. Retain revision provenance while replacing the displayed comparison automatically on success.

### Safety, configuration and delivery

- Add configurable research operator contact through app settings. Missing/invalid contact affects only providers that require it. Keep contact configuration outside research/judgment evidence and redact raw/encoded echoes from retained results and errors.
- Maintain the public-network perimeter, per-request DNS safety and redirect validation, credential-bearing URL rejection and no proxy/access-control bypass. Preserve robots behavior and provider limitations without weakening existing fetch protection.
- PDF parsing runs behind an isolated, bounded execution mechanism in the Rust deployment. A native parser without equivalent fault/resource isolation is not parity.
- Requested internal retrieval uses only authorized, available sources and records each source's actual status. Retrieval authorization and permission to share with a judgment provider are distinct.
- Supplied-only checks use only explicitly supplied evidence and retain additional work as an unexecuted frontier. Missing evidence never expands scope automatically.
- Deliver short/long cited briefs plus inspectable/downloadable dossiers, entity maps, timelines, source/claim/coverage ledgers, reference checks and unresolved frontiers. Preserve minimal supporting excerpts/metadata rather than unlimited third-party content.
- Missing real model/judgment configuration is disclosed. Existing explicit offline-test mode remains visibly a fixture, never a live-research or verified-fact substitute.

## Testing Decisions

- Primary seam: public Terminal HTML/HTTP workflows backed by a real temporary SQLite Workspace, with admitted Runs executed through the existing worker. This exercises user-facing admissions, persistence, transitions and outputs without adding a test-only product interface.
- Prefer existing router/Workspace/worker/model/judgment seams; do not introduce test-only product interfaces. Controlled provider transport responses are allowed for deterministic behavior and failure cases, but assertions must cover user-visible outcomes rather than echoing mocks.
- Test Terminal/Profile/Research/Comparison behavior through this seam: canonical route cutover with old routes absent; preservation of existing person data/capabilities; company create/edit and stale saves; explicit collection admission; scope/applicability; saved progress and resume; corrected source-linked output; privacy purge; comparison request, automatic resynthesis, input-version fencing and no external recollection on save.
- Research tests cover plausible consumer-visible bugs: ambiguous identities, company-to-person attribution, snippets misrepresented as full evidence, unread content misrepresented as inspected, empty versus error/blocked, truncation and remaining cursors, changed-content continuation, source-origin duplication, as-of boundaries, incompatible metrics, unsupported clauses, judgment failures and integrated corrections.
- Comparison tests cover required context, direction, U versus zero, range arithmetic, competitive-score meaning, saves of either company, concurrent/superseding saves, regeneration failures and truthful presentation of previous output.
- Use focused lower-level tests only for hard security/parser boundaries unsafe or impractical to express through HTTP: public-target/redirect rules, encoded secret redaction, malformed/oversized inputs, hash guards, PDF worker isolation, strict schema/count invariants and deterministic arithmetic. Keep them at the highest real module interface that exposes the behavior; do not test private helper layout.
- Existing prior art includes router-backed person lifecycle/evidence tests, queued research tests with controlled public-provider HTTP responses, model/judgment doubles and temporary Workspace persistence tests. Preserve their behavior while migrating route contracts; remove incidental wording/wiring assertions rather than repinning them.
- Permanent tests must be deterministic, isolated, full-suite-safe and assert meaningful outputs/invariants. No tests for copied source text, arbitrary lengths, bare not-throw or forwarding alone.
- Completion also requires an actual browser smoke of both profile types and comparison updates, with observed final UI and retained artifacts; tests alone do not prove the surface. Exercise live public collection under permitted configuration and label which provider/judgment behavior was real versus controlled. Do not call unexercised collectors verified.
- Run Cargo formatting, workspace check, warning-denying Clippy and tests with the lockfile before pushing. Dependency/container changes additionally require a production image build, boot and isolated Workspace persistence smoke.

## Out of Scope

- Recreating the plugin's separate MCP server, CLI interfaces, packaging helpers or maintainer evaluation harness as app features.
- Python/plugin-runtime dependencies or a hidden external plugin provider; the approved implementation is Rust-native.
- Old person route compatibility, redirects or aliases.
- Automatic external collection on profile saves or comparison regeneration.
- Automatically running comparison workflows without an explicit request naming both companies.
- Paid/login-only aggregators, CAPTCHA/paywall bypass, unauthorized internal evidence, contact harvesting, breach-data workflows, vulnerability scanning or sensitive personal-life surveillance.
- New person fit, reputation or purchasing-propensity rubrics; copying company rubrics unchanged onto individuals.
- OCR or dynamic browser rendering advertised as extracted evidence when not supported by the ported functionality.
- Guaranteed complete internet coverage, invented certainty, treating missing values as zero, or presenting structural validation as proof of factual truth.
- Unrelated meeting, Tasks or Content Engine redesign; integration changes are limited to preserving affected profile links and evidence consumers.

## Further Notes

- This is the approved conversation's maximum-applicable-extraction specification, not a reduced collector-first subset. Completion requires the workflows, subject adaptations, safety and evidence semantics above; any later reduction requires explicit user approval.
- Investigation used the plugin's primary local source and the current Rust app. Detailed source citations and Jev findings are recorded in the repository's company-deep-dive-plugin research note, including its deeper extraction review. Collectors and validators were read, not executed during that investigation.
- Jev advised a shared protocol plus typed subject/assessment context. Its judgments are advisory source/design evidence, not proof of runtime parity.
- The plugin does not inherently require a second company for its fit rubrics; explicit two-company requests are the user's Terminal rule. Preserve rubric inputs and semantics within that rule.
- Named caps, statuses, schema behavior and provider continuation must be traced to the plugin implementation during porting. Preserve behavior rather than copying known validator limitations into misleading completion claims.
- Native parser/robots dependencies must be selected for actual required behavior, included in the lockfile and license-reviewed. Their existence alone does not satisfy the extraction contract.
- No prototype was produced. No implementation code changes, feature tests or smoke verification have been performed for this specification.
- The feature spec is published as GitHub issue #18 with `spec` and `ready-for-agent` labels. Existing domain issue #11 records the settled Rust workspace product direction; the detailed plugin capability map and deeper extraction review are in `docs/company-deep-dive-plugin.md`.
