# Canonical Tasks live cutover — prepared, not authorized

Candidate Workspace: `/Users/Nicolas/Documents/github/chief-of-staff-demo/workspace`, the bind mount
configured by this repository's Compose file. `live-preview.json` is the exact reviewed inventory;
`live-preview-preservation.json` records matching before/after digests across all 22 files. It has no
legacy Debrief Runs, provider receipts or canonical Task records to create at the time of preview.
If the owner intends a different Workspace, preview that exact path before authorization.

## Preconditions and owner authorization

Finish and record local gates and the isolated production proof in `verification.md`. Obtain a
fresh explicit owner instruction for this exact Workspace and current preview fingerprint before
execution. #202 additionally requires the authorization recorded on the issue; obtain authorization
to publish that exact record if tracker writes have not already been permitted. The prepared tracker
updates are drafts, not published evidence.

Do not run the old `RESET WORKSPACE` route. Do not start the normal Compose project during preview.
Preserve the existing `chief-dossier-audit-proof` container and its anonymous volume.

## Authorized execution sequence

1. Stop/quiesce the app that owns this exact Workspace, including pending provider and research
   operations. Confirm it is the intended deployment, not the existing isolated audit container.
2. With owner-only filesystem permissions, copy the Workspace to an external backup directory and
   record its aggregate digest. Never print or publish configuration values or source content.
3. Run the operator preview again. A changed fingerprint requires review and refreshed authorization.
   The operator command starts no schedulers and makes no provider calls:

   ```sh
   pnpm exec tsx scripts/task-cutover.mts /Users/Nicolas/Documents/github/chief-of-staff-demo/workspace preview
   ```

4. Execute only with the exact authorized fingerprint:

   ```sh
   pnpm exec tsx scripts/task-cutover.mts /Users/Nicolas/Documents/github/chief-of-staff-demo/workspace execute '<authorized fingerprint>' 'MIGRATE TASKS'
   ```

   The CLI stages records outside the Workspace, then atomically publishes canonical records and
   receipt in `tasks/state.json`. It preserves configuration, credentials, historical Runs and old
   files. Provider receipts are adopted by ID without importing unrelated records. When provider
   state is unavailable, links retain a classified refresh requirement rather than fabricating a
   successful remote read. Subsequent production synchronization can reconcile existing IDs.
5. Save the content-free receipt, compare preserved file digests, and read Tasks, Lists and Action
   Items through a newly constructed TaskStore. Verify receipt counts and identities against the
   staged preview. Repeating the same authorized operation returns the existing receipt.
6. Activate the verified image for this Workspace under separately confirmed operating settings.
   Check `/api/health`, all five product areas, canonical APIs, navigation and preserved owner/config
   identity. Do not use activation as authorization to send test email or create remote Tasks.
7. Publish the authorization, receipt and verification evidence to #202 if permitted, then reconcile
   #172/#117 and close #202 only after the live checks succeed.

## Recovery

- Before atomic publication, failure leaves the old records authoritative and no completion receipt.
  Fix the reported filesystem/provider-reading problem, preview again and retry. The regression
  forces the real atomic writer to fail at its temporary path, reconstructs the executor and proves
  that a retry preserves the original records and commits a single receipt.
- An interrupted write may leave `tasks/state.json.tmp`. It is never an authoritative record. Inspect
  `tasks/state.json` through TaskStore: either the valid bundle and receipt exist, or the old files
  remain authoritative. Never substitute a partial temporary file for the committed bundle.
- After publication, a valid receipt means migration completed. Resume from that receipt; do not run
  the obsolete reset or restore old Task files over newer owner work. If an immediate rollback is
  required before any new work, stop the app and restore the verified full backup as one operator
  action, preserving a copy of the failed deployment for diagnosis.
- For a lost remote-create response, use the existing provider record ID in the Task recovery UI.
  Automatic retries deliberately refuse to create a second record. If inspection establishes no
  record exists, removing the link and deliberately choosing a destination again is an owner action;
  uncertainty must not silently become an automatic duplicate.

No live execution, backup containing credentials, deployment replacement, provider write, or tracker
mutation has been performed by this preparation.
