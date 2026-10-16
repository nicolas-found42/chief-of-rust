# Automatic Bloomberg Terminal workflow

Approved in the October 16, 2026 design interview. This amendment supersedes
the manual intake, questions, continuation, presentation controls, history UI
and automatic comparison regeneration in `bloomberg-terminal-spec.md`.

## Intake and identity

- All information entry is on `/terminal`. Directories and dossiers have no
  content-entry forms. Navigation, search/filter, refresh and retry remain.
- Name is the only required create input. Person inputs: email, role,
  company, LinkedIn, personal website and phone. Company inputs: website,
  jurisdiction and phone.
- Submitting starts a durable background workflow: identify the subject,
  create or match its profile, collect evidence and publish a complete dossier.
- Update selects an existing profile on the homepage. Name stays fixed;
  every other input can change. Fresh research replaces the visible dossier.
- Research distinguishes namesakes with evidence and identifying context.
  A shared name or employer never proves identity. Ambiguity pauses for a
  choice or additional identifying information on the homepage, before any
  overwrite. A job change retains the person's stable ID and career history.
- Confident matches reuse the existing profile, including repeat submissions.

## Research and publication

- Person and company dossiers use all applicable detailed standard sections.
  No user question, outline, depth selector or manual continuation is needed.
- Automatically follow useful evidence and provider cursors within defined
  resource limits. Report contradictions, unavailable data and coverage gaps;
  never fabricate missing facts or treat company evidence as personal facts.
- The last successful dossier remains visible during research and after a
  failed refresh, with progress, errors and retry controls.
- Archive prior successful revisions in the repository before publishing a
  replacement. Retain Markdown plus structured evidence. Historical revisions
  are not shown or browsable in the app.
- No scheduled research. User submissions, candidate research, updates and
  explicit refreshes are the admission points.

## Discovery candidates

- Discovered employers, executives, companies they work for and competitors
  appear on the Terminal homepage as candidates, without recursive research.
- Show name, identifying context, relationship/reason and source evidence.
- Research starts profile creation and research. Dismiss hides the suggestion
  durably. Deduplicate suggestions and link confidently identified existing
  profiles. Namesakes must not collapse merely because their names match.

## Questions, comparisons and reports

- A separate Ask / compare form on the Terminal homepage selects one or more
  person/company profiles and a specific question, including comparisons of
  two companies.
- Reports use the selected dossiers plus supplemental web research. Their
  evidence remains attached to the report and does not rewrite the dossiers.
- Results are read-only. Preserve a report when its input dossier changes;
  show Newer dossier available and provide explicit Refresh report.

## Acceptance

Exercise the HTTP and durable worker seams: input preservation, namesakes,
matching/reuse, job changes, ambiguity resolution, candidate research and
dismissal, archive failures, failed refreshes, reports and freshness notices.
Run all repository gates and container build/boot/persistence checks. Review
standards and spec independently, then merge only the verified green head.

After implementation, run several real company and person cases in an
isolated workspace. Read each resulting dossier before the next creation.
Repair data collection, access and other errors, and rerun affected cases.
