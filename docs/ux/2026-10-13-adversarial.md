# Adversarial UX assessment: five-area pilot workflow

## Run and outcome

User-supplied scope: test all five areas at `http://localhost:5317`, fix
supported issues, and merge behind five green checks. The composite task was
inferred from the README: prepare a fictional partner pilot, preserve a sourced
profile, capture follow-through, develop a reviewed content draft, and save
public research. Success requires inspectable saved outputs, not a successful
button invocation.

Mode: executed. Starting revision: `3ab6be80e1aa6619d45bf57a972f52562a9a15af`.
Docker deployment, live `mistral-large-4`, SQLite Workspace, bundled search.
Initial state: no People, meetings, content projects or research watches; three
existing persistence-smoke Tasks. Those existing Tasks were left untouched.

Loaded skill: `/Users/Nicolas/.agents/skills/adversarial-ux-test/SKILL.md`,
version 2.0.0, SHA-256
`c790dcbd617e5481e50fd5aeb432526ef976c14db011b2631ea3f4f73697f157`.
Rust 1.98.1; app 0.1.0; Chrome 155.0.8059.40; Jev
`typesafe/jev-1.13-20260917`, helper SDK 0.7.2. Host model and CUA API version
were unreported. [Environment record](evidence/2026-10-13/environment.json).

Persona: skeptical founder, familiar with meeting and content work but assuming
ordinary HTML forms. Mouse and keyboard; reads visible help and README; checks
saved outputs; stops unchanged retries. Uses fictional `UX Test` records and
`example.test` addresses. No remote writes, account permission changes or
permanent deletion probes. Audience fit is an explicit assumption, not actual
participant evidence. The operator had prior implementation knowledge; initial
attempts used visible routes, and subsequent source diagnosis is disclosed.

Budget: 90 minutes total, including 20 minutes reserved for reporting and CI.
Core workflow, diagnosis and fixes ran from 08:07:26 to 08:43:48 EDT (36m22s).
This is automation wall time, not measured human effort. Final evidence capture, reporting, review and
GitHub CI follow this phase; their results belong to the PR and delivery record.

Outcome: original attempt **blocked**; selected five-area workflows achieved
**assisted success after the form fix**. Connected-account branches remain
partial or untested. There is no claim of exhaustive feature coverage, human
satisfaction, adoption, or a clean original product run.

## Checked outcomes and assistance

| Area | Executed task and checked witness |
| --- | --- |
| Person Profiles | Created a fictional identity, saved evidence, generated a dossier with four exact quotations, archived and restored the Person. [Restored Person](evidence/2026-10-13/person-restored.txt); [Dossier](evidence/2026-10-13/dossier-result.txt); [quote audit](evidence/2026-10-13/mcp-judgments.json). |
| Tasks | Captured work, saved owner/priority/status, trashed and restored it. Accepted a reviewed meeting action into a Task with owner, due date and source snapshot. [Restored Task](evidence/2026-10-13/task-restored.txt); [accepted Task](evidence/2026-10-13/task-accepted.txt). |
| Meeting Wizard | Created a meeting, recovered from invalid date via browser Back, associated transcript text, reviewed a debrief and captured an action. An in-flight brief failed after source change; a fresh brief completed and its actual body was read. State changes subsequently retained it as historical output. [Debrief](evidence/2026-10-13/debrief-result.txt); [brief](evidence/2026-10-13/brief-result.txt). |
| Content Engine | Saved test brand/material, approved evidence and outline, generated a draft, removed unsupported framing through an edited version, approved and downloaded Markdown. Read the actual file. Revision 2 then exercised review reset; previous versions remain in history. [Downloaded content](evidence/2026-10-13/reviewed-draft.md). |
| Content Research | Saved and ran a public watch, opened its report with eight saved source excerpts, paused it, and checked report retention and resume/pause readiness. [Report](evidence/2026-10-13/research-report.txt). |

Assistance: native Chrome Guest compared the stalled in-app submission; source
reading diagnosed the response header; the corrected image was deployed before
downstream tasks. Result URLs were bookmarked after discovery. An exact
prefilled-textarea selector and a wordmark casing selector failed; accessible
alternatives worked. One native paste navigated to an unintended search, then
direct field entry corrected it. That content was excluded. No forced clicks,
direct API mutations or injected product records supported these browser tasks.
Tests separately use isolated fixture Workspaces.

Positive observations: explicit transcript association, quoted dossier evidence,
durable action acceptance, human content edits, review before export, and source
fencing all produced inspectable records. Source changes retained old artifacts
and showed a warning. A paused watch retained its report.

## Persona review

Simulated reaction, not a participant quotation: “I could not save my first
record [F1]. Once that worked, the review steps and source history helped me
check what I was approving. Enabled actions that immediately reject me [F2,
F4], unreadable dates [F3], and a state selector that changes my saved decision
[F5] make those checks harder.”

## Findings

| ID / observation | Expected result and basis | Type / impact | Attribution / evidence / replay | Disposition |
| --- | --- | --- | --- | --- |
| F1: valid browser POST rejected | Normal forms save records; explicit README promise | Defect / blocking in tested setup | Product response header; native Chrome independently reproduced origin rejection. Same-origin header then enabled Chrome and IAB saves. [Before](evidence/2026-10-13/chrome-form-blocked.jpg), [after](evidence/2026-10-13/chrome-form-fixed.jpg). | Fixed; opaque, foreign and other-port origins still rejected. |
| F5: state selection resets to scheduled | Form reflects saved state; editing convention | Defect / substantial recoverable burden | Product render; completed summary with scheduled selected, then repeated save reverted state. Fixed replay preserved completed. [Trace](evidence/2026-10-13/interaction-trace.md), [fixed state](evidence/2026-10-13/meeting-state-fixed.txt). | Fixed; tests cover all three states and repeated saves. |
| F2: premature content generation offered | Staged actions explain prerequisites; convention | Friction / minor | Product controls; enabled draft action led to accurate error page. Back recovered; no data loss. Fixed revision reset disables both steps; evidence approval enables outline only. [Fixed viewport](evidence/2026-10-13/content-readiness-fixed.jpg). | Fixed; server review gates retained. |
| F4: research offered with no active watch | Pause excludes watch from work; disabled control is convention | Friction / minor | Product controls; correct empty-run rejection caused avoidable navigation. Fixed resume/pause toggles readiness and retains report. [Fixed viewport](evidence/2026-10-13/research-readiness-fixed.jpg). | Fixed; backend empty-run rejection retained. |
| F3: saved dates shown as epochs | History metadata is readable; convention | Friction / minor | Product rendering; saved artifacts intact, but date requires conversion. Fixed history/detail use Workspace timezone and machine-readable time elements. [Saved brief](evidence/2026-10-13/brief-result.jpg). | Fixed; timezone/DST and both view seams tested. |

F1's root cause is consistent with the [Fetch Standard's Origin-header
algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header):
`no-referrer` makes a non-CORS navigation POST serialize its Origin as `null`.
The app's strict origin comparison rejected it. `same-origin` retains the local
origin without sharing referrers with external destinations. The boundary's
rejection rules remain intact.

## Coverage and judgment record

| State / modality | Coverage and limit |
| --- | --- |
| Initial and successful core tasks | Executed through app links/forms after F1 repair; actual outputs inspected. |
| Mistakes and recovery | Executed invalid date/Back, Task trash/restore, Person archive/restore, premature generation, paused research, source change, and repeated state save. |
| Visual evidence | Inspected selected 1280×720 IAB viewports, relevant scrolled controls, and native Chrome form comparison. Full AX text supplements offscreen content; it does not prove every pixel fits. |
| Keyboard | Tab/Enter activated skip link; next Tab reached first main card. DOM activeElement was BODY; no claim of main-node focus. No screen-reader audit. |
| Optional accounts | Settings showed Google, Asana, HubSpot and YouTube key unconfigured. Account intake/delivery and YouTube observations untested live. No accounts or permissions changed. |
| Other product branches | Scout opportunity collection, all other publication formats, duplicate merging, weekly review, schedules, privacy deletion and narrow/mobile viewports were not executed in this run. Existing automated tests cover some; that is distinct evidence. |

[Plan judgments](evidence/2026-10-13/plan-judgments.json) identified assumed
audience and uncertain leakage/constraints. [Finding judgments](evidence/2026-10-13/finding-judgments.json)
supported the two defect types; several impact, attribution and convention
axes needed review. [Explicit resolutions](evidence/2026-10-13/judgment-resolution.txt)
apply the observed task barrier, recoverability and independently fixable scope.
F2 and F4 remain separate despite a shared helper; the [pair review](evidence/2026-10-13/pair-judgments.json)
was nearly tied. Tracker-title retrieval was screened `skip` and excluded; no
tracker-completeness or duplicate-absence claim is made. No issues published.

The [initial verification](evidence/2026-10-13/findings-verify.json) exposed
delta-only AX evidence and an unqualified comparison with a pre-fix timestamp.
It is retained. Full snapshots, inspected images and a transcribed observation
trace corrected the evidence; [corrected verification](evidence/2026-10-13/findings-verify-corrected.json)
supported all five narrowly scoped replay claims. No thresholds were lowered.
The earlier [checkpoint](evidence/2026-10-13/checkpoint-judgments.json) was
partial while brief detail still awaited inspection; that remainder was later
read. Final report review and patch gate are performed before publication and
recorded alongside the PR.

Local checks: fmt, locked workspace check, locked Clippy with warnings denied,
and locked workspace tests passed: 62 ordinary tests, zero failures, two
opt-in live tests ignored. Live Mistral behavior here comes from browser Runs,
not rerunning those ignored test suites. [Check output](evidence/2026-10-13/verification.log).
The [final image build](evidence/2026-10-13/build-final.log) and
[boot](evidence/2026-10-13/boot-final.log) passed, and browser replay used that
image. GitHub's five checks remain the merge gate.

Cleanup: the native Guest window and its profile picker were closed; its
replay Task was moved to recoverable Trash. The research watch is paused and
all schedules remain disabled. Other clearly fictional test records, artifact
history and the downloaded draft are retained for inspection. The original
checkout's unfinished changes and its three existing smoke Tasks were preserved.
