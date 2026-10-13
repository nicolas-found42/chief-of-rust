# Interaction trace (host transcription of CUA results)

These excerpts record tool observations. They are not participant quotations.
Initial auxiliary AX captures sometimes contained deltas only. The full
post-fix snapshots and inspected screenshots supplement those captures.

## F1: browser form submission

Before fix: native Chrome Guest at http://localhost:5317/people. After filling
Name, Email, Role and Company and clicking Add person, the AX result was:
`HTML content localhost:5317/people` with sole text
`Browser requests must come from this workspace.`
The inspected screenshot chrome-form-blocked.jpg shows that URL and error.

After fix: fresh native Chrome Guest GET http://localhost:5317/tasks. Set Title
to `UX Test Native browser form replay`; click Add task. AX changed to
`UX Test Native browser form replay · Found42`, with URL
`http://localhost:5317/tasks/fc958635-3d0d-4eb3-a3be-11e4a2c3e48e`.
The inspected chrome-form-fixed.jpg shows the saved detail page, title field,
Owner, Due, Priority, Status, and List. The replay Task was then moved to Trash.
IAB also created Person, Task, meeting, project and watch after the header fix.

## F2: content readiness

Before fix: new project offered enabled Generate draft. Clicking it opened
Unable to continue with `Review the evidence before generating an outline or
draft.` Browser Back returned to the project. Evidence approval and outline
approval subsequently enabled successful draft generation and export.

After fix: revising intent created project revision 2. The AX result showed
`button (disabled) Generate outline` and `button (disabled) Generate draft`.
The inspected content-readiness-fixed.jpg shows both disabled buttons, with
`Review and approve the evidence in step 1 to generate an outline.` and
`Review and approve the evidence in step 1, then approve an outline in step 2.`
After approving evidence, the full content-evidence-approved.txt snapshot shows
Generate outline enabled and Generate draft disabled with outline guidance.

## F3: saved dates

Before fix: debrief-result.txt captured `saved 1791893760095`; meeting-results.txt
captured history link `debrief · 1791893760095`.
After fix: meeting-state-fixed.txt history links show
`brief · 2026-10-13 08:19:38 EDT` and `debrief · 2026-10-13 08:16:00 EDT`.
brief-result.txt and its inspected screenshot show saved `2026-10-13 08:19:38 EDT`.
Settings selected America/New_York throughout this browser run.

## F4: paused Research

Before fix: paused sole watch retained its report, but Research active watches
was enabled. Clicking opened `Add an active watch before running research`.
After fix: research-readiness-fixed.txt and its inspected screenshot show
Paused, Resume, disabled Research active watches and add/resume guidance.
Resume enabled Research active watches; Pause disabled it again. Report stayed.

## F5: meeting state

Before fix: selected completed and clicked Set state. AX changed only summary
to `2026-10-14T14:00:00-04:00 · completed`; State remained scheduled.
Clicking Set state again changed summary to scheduled. Initial source options
were `<option>scheduled</option><option>completed</option><option>cancelled</option>`.
After fix: selected completed and saved. AX summary and State became completed,
with `(selected) completed`. Repeating Set state left the tree unchanged.
Full meeting-state-fixed.txt and inspected screenshot show completed selected.

## Harness assistance and scope

The IAB initially hid the rejected submission. Chrome revealed the server error.
Chrome connector was unavailable, so native Chrome Guest was used via CUA.
An exact selector for prefilled Question found no match; accessible textbox
selection worked. A wordmark selector case mismatch was corrected using its
documented accessible name. No forced clicks or direct API mutations were used.
One native paste navigated to an unintended search; direct AX field entry
corrected it. Search content was excluded from product evidence and authority.
Guest window and profile picker created for the comparison were closed.

The original brief failed because transcript association changed during its
generation. A fresh request completed. Later state changes retained that brief
as history and displayed its source-changed warning; this was expected fencing.

Keyboard: Tab focused Skip to content; Enter moved to #main; the next Tab
focused the Meeting Wizard card inside main, bypassing header navigation.
DOM activeElement reported BODY, so this does not claim focus on the main node.

The actual downloaded reviewed-draft.md was read from disk and contains the
human-edited fictional copy, revision 1 and Human edit of mistral-large-4.
Content revision 2 was left evidence-reviewed, with no new outline or draft.
The previous reviewed export remains in Downloads and the evidence bundle.
