# Drive scope widened from `drive.readonly` to `drive`

**Date:** 2026-08-23
**Amends:** ADR-0012 (Drive folder is the only transcript Intake), ADR-0013 (Drive picker and setup flow), ADR-0016 (YouTube rides the Google connection)

ADR-0012 chose `https://www.googleapis.com/auth/drive.readonly` as minimal scope — the Intake only reads — and ADR-0013/0016 repeated it. The Picker comment, `SURFACE`/`SCOPE_LABELS`, `GOOGLE_SCOPES`, README and `e2e` expectation all followed.

On 2026-08-23 Nicolas widened it to `https://www.googleapis.com/auth/drive` on a product call: a bunch of upcoming Modules will need to **write** to Drive (e.g., Move Meeting Videos `drive.moveFile`, future Modules with Drive outputs). `drive.readonly` would force a second scope request later; `drive` (full) is the narrowest scope covering both read and write, still one consent, still one Cloud project.

**Decision:** Request `drive` (full) in `GOOGLE_SCOPES`. Keep `drive.readonly` as a grandfathered fallback in `SettingsPage` `labelMap` (`"drive.readonly": "Google Drive"`) so old refresh tokens still classify as Drive. `googlePicker.ts` comment updated (`drive` not `drive.readonly`); `connection.ts` `SURFACE.drive.scope` now `drive`, `SCOPE_LABELS` now `drive`.

**Consequences:** Existing `refresh_token` was granted `drive.readonly`; it retains `readonly` until the operator does `Settings → Google → Disconnect → Save and sign in with Google` and ticks Drive again — then the new token carries `drive`. `docker compose up --build -d` now advertises `scopes` with `drive`; `Check my setup` and the scopes step now copy `drive`. No new credential, no new Cloud project, no `setDeveloperKey`/`setAppId` change. Commit `967e633`.

**Considered:** Keep `readonly` and request `drive` only when a writing Module ships — rejected: would add a second consent screen and a scope-migration branch for no gain; the write need is already concrete (11, 09, and drive outputs in `Not yet specified`).

**Out of scope:** Notion/Reddit/HubSpot secrets (still no home — ADRs 0007/0011), YouTube `youtube.readonly` unchanged.
