## Problem Statement

Person Profiles are intended to help a Workspace owner understand anyone they look up, regardless
of the owner's industry or the person's profession, organization, location, or public footprint.
Today, the presence of a dossier schema, passing fictional fixtures, registered search providers,
or valid quoted passages does not establish that the application found the right person, recovered
important available information, represented it accurately, or produced useful meeting preparation.

The recorded live research canaries demonstrate this gap: research can stop with little or no
extracted evidence. Current search and reading limits can discard useful discoveries or leave
formats unread. Relevant evidence may exist in video, audio, social posts, PDFs, presentations,
professional directories, institutional records, or archives that the Person Profiles research
path cannot yet use. Sparse output can therefore mean either sparse public evidence or a failure
of discovery, acquisition, reading, attribution, or synthesis; developers cannot reliably tell
which from coarse failure messages.

Workspace owners should receive a Profile immediately and see it improve as one continuous
research operation works to completion. They should not need repeated enrichment actions or
later resumptions because an arbitrary short research allowance expired. Developers need a
repeatable, demanding benchmark that exposes what the application missed and explains failures
well enough to improve production research. Research data acquisition must require no payment,
API key, or sign-in; the application's existing configurable LLM providers remain available.

## Solution

Deliver a developer-only Person Research Benchmark and improve the production Person Profiles
research pipeline in the same effort. The benchmark contains 30 independently researched public
people spanning industries, roles, geographies, languages, and different evidence footprints.
Its reference dossiers represent strong research outcomes, including supported information the
application cannot yet acquire. The references must not be generated from the system's current
answers or weakened to match its limitations.

Measure factual reliability, completeness, meeting-preparation usefulness, and operational
reliability separately, without an initial overall score. Evaluate both live discovery from
realistic Identity Signals and interpretation of fixed reference documents. Use deterministic
integrity checks and a separately configured semantic judge, with evidence behind judgments and
reviewable uncertainty.

Production research starts broadly, then adapts parallel search and reading batches to evidence
and unanswered questions. Every user has access to the same eligible source collection. Expand
free anonymous discovery and reading across web, social, video/audio, documents, archives, and
specialist records. Create or reuse the canonical Person Profile immediately, publish evidence
progressively, and keep the same operation active until it has investigated its coverage and
actionable leads and further expansion yields no useful evidence. Account for inaccessible
sources with precise failures, not an invented claim that no information exists.

## User Stories

1. As a Workspace owner, I want to look up people from any industry, so that my own profession does not restrict whose Profile I can create.
2. As a Workspace owner, I want the same source collection available to every user, so that research quality does not depend on selecting an industry during setup.
3. As a Workspace owner, I want to start from the application's supported Identity Signals, so that I do not have to assemble a research dossier myself.
4. As a Workspace owner, I want an existing matching Person Profile reused, so that repeated lookups do not create duplicate identities.
5. As a Workspace owner, I want ambiguous identities kept distinct, so that a same-name person's accomplishments are not assigned to the person I mean.
6. As a Workspace owner, I want the Profile created immediately, so that I can read it while research continues.
7. As a Workspace owner, I want supported evidence published progressively, so that I can benefit from completed work before all research finishes.
8. As a Workspace owner, I want one research operation to continue until completion, so that I do not need to press resume or trigger another enrichment pass.
9. As a Workspace owner, I want new discoveries to guide further searches, so that interviews, work, organizations, and public accounts lead to deeper evidence.
10. As a Workspace owner, I want sparse early results to trigger broader exploration, so that an initial profession guess or weak search does not restrict my Profile.
11. As a Workspace owner, I want no source subscriptions, API keys, or sign-ins required, so that the application works with anonymous public sources.
12. As a Workspace owner, I want to keep my configured LLM provider, so that free data acquisition does not force a different inference provider.
13. As a Workspace owner, I want relevant public video captions and transcripts researched, so that spoken accounts of work are included.
14. As a Workspace owner, I want podcast and radio material investigated, so that relevant interviews outside conventional biographies can contribute evidence.
15. As a Workspace owner, I want public social posts and their relevant attachments investigated, so that work announcements and current focus are not missed.
16. As a Workspace owner, I want PDFs, scans, presentations, and structured documents read, so that substantive evidence outside HTML can contribute to my Profile.
17. As a Workspace owner, I want relevant institutional and professional records researched, so that people with less general-web coverage receive substantive Profiles.
18. As a Workspace owner, I want archived evidence retained with its dates, so that historical roles are understood without being presented as current.
19. As a Workspace owner, I want sources and exact passages accessible from claims, so that I can inspect what an assertion actually rests on.
20. As a Workspace owner, I want a speaker's own statements distinguished from independent accounts, so that an interview or post does not become independent verification of itself.
21. As a Workspace owner, I want personal contributions distinguished from team output and company scale, so that the record does not exaggerate individual responsibility.
22. As a Workspace owner, I want conflicting and uncertain information labeled, so that research does not resolve disagreement by guessing.
23. As a Workspace owner, I want public evidence and Relationship History kept separate, so that private Workspace information does not leak into public-safe consumers.
24. As a Workspace owner, I want temporary source failures retried within the operation, so that a recoverable failure does not prematurely end enrichment.
25. As a Workspace owner, I want research to continue through other sources when one persistently fails, so that useful evidence is still collected.
26. As a Workspace owner, I want completion to explain coverage and remaining gaps, so that a finished operation does not imply every fact is known.
27. As a Workspace owner, I want interruption distinguished from completion, so that a model outage or application shutdown is not reported as successful research.
28. As a Workspace owner, I want archive, merge, detachment, corrections, and deletion respected during research, so that late results do not undo my decisions.
29. As a developer, I want 30 independently researched Benchmark People, so that evaluation represents general person research rather than a few technology celebrities.
30. As a developer, I want strong references that exceed current source coverage, so that the benchmark drives improvements rather than ratifies today's implementation.
31. As a developer, I want rich, ordinary, sparse, ambiguous, social-first, video-first, and records-first examples, so that easy cases cannot conceal systematic failures.
32. As a developer, I want dated reference facts and unjustified conclusions recorded, so that the evaluator can recognize both omissions and overclaims.
33. As a developer, I want the twenty dossier requirements represented across the collection, so that the benchmark tests the intended depth of Person Profiles.
34. As a developer, I want unavailable dimensions left honest for each person, so that reference authoring does not manufacture facts merely to fill a checklist.
35. As a developer, I want live discovery to see only realistic lookup inputs, so that reference answers and source lists cannot leak into the research under test.
36. As a developer, I want a fixed-reference-document evaluation, so that I can distinguish search failures from failures to use available evidence.
37. As a developer, I want factual reliability reported separately, so that wrong-person attribution and unsupported statements cannot hide behind a large dossier.
38. As a developer, I want completeness measured against each person's reference, so that missing available evidence is distinguished from an inherently sparse public footprint.
39. As a developer, I want absolute richness reported alongside completeness, so that excellent recovery of three facts is not confused with a deeply documented Profile.
40. As a developer, I want meeting-preparation usefulness assessed, so that correctly collected information also helps a reader understand the person and remaining questions.
41. As a developer, I want operational reliability reported separately, so that successful access, extraction, and completion are not confused with factual quality.
42. As a developer, I want deterministic source-integrity checks, so that nonexistent quotations, broken references, or mismatched source versions cannot pass on a judge's opinion.
43. As a developer, I want semantic judgments with cited evidence, so that valid paraphrases are recognized and unsupported scope changes are rejected.
44. As a developer, I want ambiguous judgments reviewable, so that the evaluator does not present uncertain model decisions as established facts.
45. As a developer, I want reference and judge versions fixed during comparison, so that I can attribute a changed result to the research change being evaluated.
46. As a developer, I want command-line evaluation and durable machine-readable and readable reports, so that I can reproduce and inspect results without an app evaluation page.
47. As a developer, I want full-collection and selected-subset evaluation, so that quick checks and comprehensive comparisons use the same evaluator.
48. As a developer, I want quality broken down by person, industry, role, footprint, language, and source family where represented, so that aggregate improvements do not hide regressions.
49. As a developer, I want discovery separated from result selection and reading, so that a relevant URL discarded before retrieval is visible as its own failure.
50. As a developer, I want source and upstream-index provenance, so that several wrappers over one index or copied biographies do not count as independent evidence.
51. As a developer, I want precise production failure codes and observations, so that I can debug the actual pipeline rather than a separate evaluation imitation.
52. As a developer, I want every retry and fallback linked to its original attempt, so that I can see which recovery methods worked and which failed.
53. As a developer, I want HTTP, timeout, parser, subprocess, and model details where applicable, so that a generic unavailable message does not conceal the cause.
54. As a developer, I want collector versions and relevant nonsecret configuration recorded, so that a failing source can be investigated against the implementation that produced it.
55. As a developer, I want retained diagnostic evidence and reproduction pointers, so that I can mitigate failures without guessing from a summary.
56. As a developer, I want observed causes separated from hypotheses, so that a 403 or empty response is not assigned an invented explanation.
57. As a developer, I want diagnostic summaries to preserve access to the attempt history, so that a display limit or later error does not erase the original failure.
58. As a developer, I want source eligibility verified from current documentation and live probes, so that stale catalogue labels do not introduce keys, payments, or login requirements.
59. As a developer, I want source additions tested for unique supported evidence, so that increasing adapter count alone is not reported as a quality improvement.
60. As a developer, I want baseline and expanded-production results compared under recorded conditions, so that the implementation demonstrates real improvement.
61. As a developer, I want failed and interrupted evaluations reported explicitly, so that stale successful output cannot replace the result of a failed attempt.
62. As a developer, I want remaining benchmark misses preserved, so that follow-up source and extraction work has concrete acceptance targets.
63. As a developer, I want existing private evidence and lifecycle behavior protected, so that better public research does not compromise the Workspace's ownership and privacy boundaries.
64. As a Workspace owner, I want the current Profile reading experience retained during this effort, so that research improvements do not require adoption of the experimental profile layouts.

## Implementation Decisions

### Ownership and integration

- Person Profiles remain a Workspace resource and product area, not a new Module. Build on the
  existing Person Profiles composition, Workspace interfaces, research orchestration, dossier
  persistence, Source Adapters, PublicSearch and shared model boundary.
- The evaluator is developer tooling over the production research capability. It must not maintain
  a second discovery, attribution, extraction or dossier-synthesis implementation.
- Introduce or extend a single operation-level research interface at the Person Profiles
  composition boundary where necessary. It exposes starting research, progressive reads, final
  outcome, coverage, and attempt diagnostics. Keep collector-specific mechanics behind it.
- Preserve shared provider health, cooldowns and caches across consumers rather than giving each
  Profile an independent view of the same upstream rate limit.
- Existing API and Profile surfaces continue to present progressive research. The evaluation
  entry point is a developer CLI, with readable reports and structured results. A production
  evaluation page and prototype integration are not part of this change.

### Continuous research and completion

- Create or reuse the Person Profile promptly and publish valid evidence progressively throughout
  one continuous research operation. Internal search batches are work within that operation,
  not separate enrichment passes waiting for manual or scheduled resumption.
- Existing short per-profile call/time caps and daily-rollover behavior must not routinely suspend
  accepted enrichment for a later pass or produce a false completion. Adapt settings and stored
  state to the continuous model while preserving explicit user cancellation and lifecycle gates.
- Bound individual requests, subprocesses and retries; respect source rate limits and avoid
  runaway duplicate traversal. These controls classify failures and govern scheduling within the
  operation; they must not silently discard actionable leads or masquerade as research completion.
- Completion requires investigating planned coverage, accounting for actionable leads, checking
  alternative queries/source families when needed, finding no useful further evidence through
  expansion, and publishing the findings with explicit gaps. A model's unsupported statement
  that it is finished is not sufficient evidence of these conditions.
- Record why each relevant lead was investigated, rejected, deduplicated, inaccessible or left
  interrupted. Unknown facts may remain unknown; completion does not assert internet exhaustion.
- Retry temporary failures and attempt eligible alternative retrieval methods within the same
  operation. Persistent source failures become documented gaps while other work continues.
- Model-provider failure, shutdown, user cancellation and lifecycle invalidation are interruptions
  or cancellations, not successful completion. Durable state and completed evidence remain
  protected; no routine resume action is introduced as the intended enrichment experience.
- Preserve existing creation/reuse triggers, consumer revision semantics and eligible later
  refresh behavior. A later refresh for changed evidence is distinct from stopping unfinished
  initial enrichment and presenting its next pass as a refresh.

### Search and source expansion

- Begin with broad parallel discovery, then let the configured LLM propose further queries,
  sources and reading actions from observed evidence and remaining questions. Every supported
  source remains eligible regardless of the Workspace owner's industry.
- Match identity before factual attribution. An apparent profession can guide priority but cannot
  exclude other industries, languages, roles or source families. Sparse results require broader
  exploration rather than repeated searches in one assumed category.
- Preserve discovery provenance, upstream-index identity where known, ranking and selection
  decisions. Replace registration-order truncation as the sole selection rule with selection that
  accounts for relevance, independent evidence and coverage gaps. Retain enough information to
  diagnose discovered-but-unread sources.
- Data acquisition must require no API key, payment, source sign-in, imported session or paid
  proxy. Audit existing routes as well as additions; free tiers requiring keys are excluded.
  Optional keyed or paid upgrades must never be automatic fallbacks. LLM inference providers
  and their existing credentials are unaffected by this source restriction.
- Expand production capabilities across the following families, with exact eligible routes
  verified during implementation:

  | Family | Integration targets and expected evidence |
  | --- | --- |
  | General discovery | Existing keyless search, suitable SearXNG engines and MWMBL; additional verified engines where they add useful coverage. |
  | Spoken evidence | Existing public YouTube caption and media readers, eligible additional video extractors, PeerTube, podcast discovery, public RSS transcript links and appropriate local transcription. |
  | Public social evidence | Verified anonymous Bluesky and Mastodon reads, plus anonymously accessible LinkedIn, Instagram and other public posts/pages when obtainable. |
  | Documents and publisher sites | HTML, public structured records, PDFs, scans, slides, feeds and relevant attachments; local parsing/OCR and bounded anonymous rendering where needed. |
  | Published and deposited work | Crossref, DataCite, available Europe PMC material, eligible anonymous OpenAlex queries and linked open documents. |
  | Professional and institutional records | NPPES, ClinicalTrials.gov, SEC filings, Nonprofit Explorer and relevant public professional, employer, association and event pages. |
  | Creative and cultural records | TVMaze, Library of Congress, Art Institute of Chicago and appropriate public catalogue/credit records. |
  | Identity and affiliation | Referenced Wikidata statements, ROR and existing eligible identity sources. |
  | Historical evidence | Existing Internet Archive/Wayback capabilities, eligible archived files and Common Crawl URL/capture retrieval. |

- Reuse the existing video, browser and local media runtime capabilities before adding parallel
  stacks. Libraries such as Docling, Steel or approaches from web-search-free are candidates,
  not mandatory dependencies. Infomesh is an experimental additional index until it demonstrates
  useful coverage; it is not assumed to contain the general web.
- Treat catalogues as discovery leads. A public endpoint response, a library supporting a site,
  and an end-to-end grounded Profile claim are three different levels of evidence. An unavailable
  route must retain the reason rather than receive a mock-backed supported label.
- Access and use terms must permit the actual application route. A noncommercial-only hosted
  API is not universally suitable for arbitrary companies. Limited anonymous quotas are allowed
  without paid escalation; quota exhaustion is explicit. Full-text rights and public metadata
  availability are evaluated separately.
- Preserve text, dates, source versions and citation anchors suited to the format, including
  page or timestamp references where available. Distinguish caption timestamps from speaker
  identification and generated transcription from publisher-provided captions.

### Benchmark and evaluation contract

- Author 30 Benchmark People, deliberately covering the agreed industry groups: healthcare;
  education; finance/professional services; manufacturing/logistics; construction/property;
  retail/hospitality; agriculture/food; media/creative work; government/nonprofits; and
  technology/telecommunications. Balance the collection across roles, organization sizes,
  languages, regions and footprint types rather than choosing only prominent executives.
- Reference facts are independently investigated from dated sources with inspectable support,
  expected identity anchors and conclusions the evidence does not justify. Include useful
  evidence the current app cannot source. Do not invent reference facts or reduce expectations
  to make current collectors pass.
- Preserve immutable reference versions and trace corrections to their evidence. Retain source
  snapshots or permitted excerpts and stable pointers sufficient to judge the exact reference;
  handle source rights without treating a link alone as an already verified expectation.
- Cover all twenty dossier requirements from the prior spec across the collection. They need not
  all be populated for every person. Existing fictional fixtures remain useful for controlled
  missing, conflicting and adversarial cases, and must stay labeled as fictional.
- Live evaluation starts from realistic lookup inputs and cannot access reference facts, expected
  source lists or evaluator feedback while researching. The fixed-document mode supplies the
  reference corpus through the same reading/extraction capability to isolate downstream quality.
- Evaluate factual reliability, completeness, meeting-preparation usefulness and operational
  reliability separately. Report supported reference recovery and absolute richness separately;
  no overall score initially. Wrong-person attribution, invented evidence and scope inflation are
  explicit failures rather than small deductions concealed by volume.
- Deterministic checks validate record/citation integrity and source-version support. A separately
  configured semantic judge assesses meaning, support and usefulness, cites the relevant
  reference and evaluated evidence, and marks ambiguous cases for review. Judge approval cannot
  override failed integrity checks. Quotation presence alone does not establish claim support.
- Record the reference version, research configuration, model/provider, prompt/collector versions,
  judge configuration, timestamps, cache/live conditions, request counts and available usage for
  comparisons. Do not invent token counts or cost when the model boundary cannot supply them.
- Produce per-person and grouped comparisons with denominators, coverage gaps and failure
  breakdowns. Keep full and subset evaluation on the same CLI/report contract. Record incomplete
  and failed executions so previously successful output cannot be reused as the new result.
- Compare the incumbent and expanded production pipelines against the same reference and judge
  configuration under recorded comparable conditions. Report any changed research allowances or
  network conditions rather than attributing every gain to a source or model change.

### Failure diagnostics and lifecycle

- Production research and the evaluator share structured Person Research Failure records.
  Preserve operation/profile revision, source or query identity, attempt correlation,
  collector/parser version and relevant nonsecret configuration.
- Distinguish discovery, selection, transport, access, rendering, document parsing/OCR,
  caption/media acquisition, transcription, identity attribution, extraction, validation and
  publication failures with stable reason codes.
- Retain applicable observed details: HTTP/upstream status, safe final URL, content type/size,
  response or document hash, timestamps, elapsed time and timeout stage, parser location,
  subprocess exit status and existing structured model-boundary diagnostics.
- Differentiate connectivity/DNS/TLS failures, rate limits or quota exhaustion, login-required
  content, challenge pages, unavailable resources, unsupported formats, missing captions,
  unavailable local runtimes, ambiguous attribution, invalid result shapes, unsupported citations
  and stale-result rejection. Unknown causes remain unknown; a 403 alone establishes none of
  the more specific access explanations.
- Persist retry/fallback history, delays, outcomes and the reason further recovery stopped.
  Connect failure impact to missing source material or dossier coverage and provide specific
  investigation/remediation pointers. Distinguish hypotheses from observed facts.
- Keep retained permitted source references and bounded sanitized debugging artifacts. Never
  expose credentials, sessions, hidden model reasoning or private evidence in public diagnostics.
  A compact display limit must not erase the underlying attempt history.
- Preserve Workspace ownership, immutable evidence/revisions, standing identity decisions,
  archive, merge, detach, privacy deletion, Transcript deletion and in-flight write fencing.
  New diagnostic and evaluation artifacts must participate in applicable cleanup and migration
  rules rather than becoming an ungoverned second store of person information.
- Run benchmarks in isolated workspaces. Do not reset a live Workspace, send messages, create
  external Tasks, or modify existing user Profiles as a side effect of evaluation.

## Testing Decisions

- **Primary testing seam: the existing Person Profiles composition.** Exercise canonical creation
  or reuse, research start, progressive dossier reads, completion/interruption, public/private
  projections and failure diagnostics as one product. Replace external search/retrieval/model
  and local-runtime I/O at their existing boundaries; extend composition-level dependency
  injection only where necessary. Keep the real orchestrator, identity policy, stores and
  lifecycle behavior connected.
- **Developer-facing seam: the evaluator CLI and report contract.** Verify corpus loading,
  reference isolation, both evaluation modes, semantic/deterministic result combination,
  provenance, failure output and comparisons through observable reports and exit behavior.
  Reuse production composition beneath it rather than testing a duplicate research engine.
- **Thin application checks:** use existing HTTP and browser journeys to verify immediate Profile
  creation, progressive evidence, completion with gaps, visible interruption and source inspection.
  Do not recreate every research scenario in the browser suite.
- A good test asserts externally meaningful evidence and outcomes, not helper calls, internal
  batching, prompt wording or the implementation's own scoring formula. Verify actual retained
  text and source versions, correct identity and contribution scope, observable progress, and
  explanations of missing evidence.
- Use deterministic external responses to test alternate discovery, source diversity, wrong-person
  results, copied sources, conflicting dates, unavailable formats, absent captions, transcription
  errors, challenge pages, rate limits, timeouts, malformed model replies and publication races.
- Include a valid quote that does not support the claimed conclusion, a correct statement about
  the wrong person, useful evidence discovered beyond an earlier result cap, and substantive
  source material retrieved but ignored. These distinguish integrity, attribution, selection and
  semantic failures.
- Prove that sparse results broaden research, a temporary failure can recover within the same
  continuous operation, persistent failures retain their full reason/attempt history, and
  request/retry controls cannot silently turn unfinished work into successful completion.
- Test cancellation and shutdown as interruption, with completed evidence preserved; test archive,
  deletion, detachment, merge and revised identity during I/O so late results cannot revive or
  misattribute data.
- Test anonymous collection configuration to ensure no source keys, payments, login sessions or
  paid fallbacks are required or silently used. Probe actual production routes independently of
  documentation and distinguish an anonymous smoke test from usable person evidence.
- Use controlled semantic-judge fixtures to verify report behavior and known correct, omitted,
  unsupported and ambiguous answers. Real-model evaluation provides additional evidence; it
  cannot replace deterministic correctness tests or make unsupported facts acceptable.
- Prior art includes the existing Person Profiles composition tests, dossier acceptance matrix,
  automatic-entry and lifecycle tests, research queue tests, model-boundary failure tests,
  source-adapter canaries, dossier API/browser journeys, and the transcript evaluation CLI's
  handling of failure versus stale successful output.
- Run the repository's narrow applicable gates during work, full checks before pushing, application
  browser coverage for changed behavior, and production Docker build/boot checks for runtime and
  bundle changes. Live-source/model evaluations stay explicitly identified and separate from
  deterministic CI; this spec does not change the four required merge checks.
- Acceptance requires the complete 30-person benchmark, both evaluation modes, production
  adaptive/continuous research and source-family expansion, specific failure diagnostics, and
  an inspectable baseline-versus-new report demonstrating improved reference coverage without
  newly introduced critical identity or source-integrity failures. Unsupported routes and
  unresolved reference misses remain explicit with actionable explanations; no fixture-only
  integration is presented as live coverage.

## Out of Scope

- Integrating the experimental Person Profile layouts or creating an app evaluation page.
- Requiring the Workspace owner to select an industry or manually configure each source.
- Paid or keyed data acquisition, free trials requiring keys, source logins, imported browser
  sessions, paid proxies, or bypassing access restrictions.
- Requiring local-only LLM inference or changing the existing provider-choice policy.
- A guarantee of identical dossier volume for every person or exhaustive discovery of all online
  information; equal evidence standards and recovery of available reference information are the
  measurable requirements.
- Using confidential or leaked data to compensate for a sparse public footprint.
- Inferring competence, availability, authority, legal conclusions or personal contribution merely
  from a title, popularity, affiliation or absence of contrary evidence.
- Recursively researching every connected person into a full Profile without a separate request.
- Replacing the Workspace lifecycle, identity review or privacy model, resetting live data, or
  sending external communications as part of benchmarking.
- Adopting entire external research platforms merely because their default configuration works
  with paid services; reuse suitable patterns and compliant components.
- Changing repository rulesets or making nondeterministic live-provider success a new required CI
  gate. Requiring every ambitious reference fact to pass before this first effort can finish.

## Further Notes

This is a standalone follow-on to [#204](https://github.com/nicolas-found42/chief-of-staff-demo/issues/204)
and [#212](https://github.com/nicolas-found42/chief-of-staff-demo/issues/212), both closed. It extends
their dossier/research capability and replaces routine budget-limited enrichment passes with the
continuous operation defined here. Their twenty depth requirements and standing Workspace,
identity, evidence, consumer and lifecycle protections remain applicable.

ADR-0063 records the decisions from this design session and should land with the implementation.
ADR-0042 and ADR-0062 continue to govern Workspace ownership and evidence-backed dossiers;
ADR-0049's shared keyless search and failure-independence posture is retained while selection and
adaptive orchestration improve.

Source research used Context Awesome and Firecrawl to inspect all eight user-supplied starting
repositories, followed by primary documentation/code verification and limited anonymous probes.
The catalogues are leads, not evidence of production support. Key examples include
[public-apis](https://github.com/public-apis/public-apis),
[awesome-search](https://github.com/frutik/awesome-search),
[awesome-search-engines](https://github.com/prirai/awesome-search-engines),
[awesome-linkedin](https://github.com/brandonhimpfen/awesome-linkedin),
[awesome-hacker-search-engines](https://github.com/edoardottt/awesome-hacker-search-engines),
[Infomesh](https://github.com/dotnetpower/infomesh),
[awesome-web-agents](https://github.com/steel-dev/awesome-web-agents), and
[web-search-free](https://github.com/qiran87/web-search-free).

The practical implementation order is reference authoring and baseline capture, shared operation
and diagnostic contracts, source/reader expansion and adaptive continuous research, then full
comparison and production verification. These are stages of one delivery; the evaluator alone
does not complete this spec. Record failures and remaining misses rather than lowering the
references, claiming mocks as live support, or marking interrupted research complete.
