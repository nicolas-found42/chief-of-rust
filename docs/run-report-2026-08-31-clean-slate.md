# Clean-slate exercise — all six Modules, 10 Runs each

**Run window:** 2026-08-30T07:26Z → 2026-08-31T12:10Z (~28.7 h wall clock)
**Build:** working tree at `7d11a96` **plus the uncommitted Content Research batch** (not committed during this session)
**Container:** `chief-of-staff-demo-app` at http://127.0.0.1:4317, image built 2026-08-30T07:25:41Z
**LLM:** OpenRouter `dots-studio/dots-3-note-preview:free` (changed from `z-ai/glm-5.3-flash` at 07:41Z, via Settings → Manage provider)

The exercise itself changed no source files; four defects it uncovered were then fixed (§8). Run ids
are cited; no collected Source Item bodies, transcript contents, brief contents or credentials appear
below.

---

## 1. Executive verdict

**Five of six Modules reached or passed 10 completed Runs** after the fixes in §8. The sixth is
blocked on one missing credential, not on a defect.

| # | Module | `done` | Target | Verdict |
|---|---|---:|---:|---|
| 01 | Transcript → Tasks | **13** | 10 | ✅ Met. Cleanest Module in the app. |
| 02 | YouTube Trends | **11** | 10 | ✅ Met once the one-per-day cap was lifted (§8.3). Was 2. |
| 03 | Idea Engine | **10** | 10 | ✅ Met; 3 Runs still failed on model structured-output limits. |
| 04 | Content Scout | **13** | 10 | ✅ Met on count, but **`daily-intake` still cannot complete end-to-end.** |
| 05 | Meeting Brief Generator | **0** | 10 | ⛔ Blocked at `enrich` on **Guest Profile** alone. Calendar, Gmail, Drive and HubSpot all pass. |
| 06 | Content Research | **13** | 10 | ✅ Met. |

**70 Run records total.** The only remaining blocker is the Guest Profile credential. The most
important *defects* found were a durability bug that silently drops transcripts and an unsanitised
event version that broke Meeting Brief for every real Calendar event — both now fixed (§8).


---

## 2. What was cleared, and what that cost

Per your instruction, everything except `workspace/config.json` was deleted. A recoverable archive
(954 KB) was taken to the session scratchpad first.

Deleted: `runs/` (20 records), `state.json`, `content-research/`, `content-scout/`,
`meeting-brief-calendar.json`, `watch-archive/`. Preserved: `config.json` (all OAuth tokens, Notion
token, LLM key, Drive binding), `relay.json`.

Three consequences worth recording:

1. **Wiping `state.json` dropped `drive.ingestedIds`,** so on boot the Drive poller re-queued *every*
   transcript in the folder as new — 30 Runs across two Modules, each of which would have written
   duplicate Google Tasks and Gmail drafts into your account. Transcript → Tasks has **no review
   gate**; `outputs` calls `createTask`/`createDraft` directly. I stopped the container within
   seconds; both in-flight Runs were still in their LLM `extract` stage, so **zero outward writes
   occurred**, then trimmed the queue on your instruction.
2. **Content Scout lost its Brand Profile and all Source Targets,** which its ranking depends on.
   Rebuilt during this session (§4.4).
3. **Content Research re-seeded** Lenny Rachitsky and Pieter Levels on boot, as designed, so the
   contaminated `[4351, 1211, 1211]` baseline history is gone.

---

## 3. Credentials encountered

The rule for this session was to stop and ask rather than skip. Three services needed intervention.

| Service | Symptom | Resolution |
|---|---|---|
| **Google Calendar** | `Request had insufficient authentication scopes.` | Two separate faults, both fixed. See below. |
| **HubSpot** | `Connect your HubSpot private app first.` | **Outstanding** — private app prepared, token is yours to mint and paste. |
| **Guest Profile** | `Guest Profile endpoint and API key are not configured.` | **Outstanding** — needed after HubSpot. |

### Google Calendar — two faults, both resolved

The app's own **Check my setup** misattributed the cause ("The consent screen is missing the
calendar.readonly scope"). The truth was two stacked problems:

1. The stored OAuth token dated from **2026-08-24** and predated `calendar.readonly`,
   `gmail.readonly` and `gmail.send` being requested. Re-consent was required regardless of console
   state.
2. The **Calendar API was not enabled** on Cloud project `cos-onboarding-test` (project 469326573261).

Fixed by adding the three scopes under Data Access, re-running the OAuth consent (no password
handled — the account was already signed in), and enabling the Calendar API. All seven Google
surfaces now pass:

```
OK  Google Tasks         OK  Gmail drafts      OK  Gmail history
OK  Gmail delivery       OK  Google Calendar   OK  Google Drive       OK  YouTube view counts
```

`gmail.readonly` and `gmail.send` were also broken before this and are now working — a pre-existing
fault unrelated to Calendar.

---

## 4. Per-Module detail

### 4.1 Transcript → Tasks — 13/13 succeeded

Trigger: Settings → Drive transcripts → **Sync now** (plus the 3-minute poller).
Stages, every Run: `convert → extract → outputs`.

**Produced: 65 Google Tasks and 7 Gmail drafts** across 13 transcripts.

| Run (suffix) | Output | Source |
|---|---|---|
| `…09dd5094` | 3 tasks | Found42 Stand-Up Meeting_summary.txt |
| `…9dfbcda5` | 7 tasks | Nick x Adejoke 2026-08-24 |
| `…ee5c66dd` | 3 tasks | Found42 Stand-Up Meeting_transcript.txt |
| `…568edee4` | 1 task | Stand-Up 2026-07-23 |
| `…9b888cde` | 10 tasks, 1 draft | Stand-Up 2026-08-27 |
| `…111478f0` | 6 tasks | Stand-Up 2026-08-20 |
| `…1be7cf8a` | 3 tasks, 1 draft | Specialized Course Development for CEOs |
| `…c8b5e451` | 4 tasks | Abhinav–Richard (copy) |
| `…467c7613` | 5 tasks, 2 drafts | Abhinav–Richard |
| `…fbb45cb6` | 5 tasks, 1 draft | CPSD – Google – Found42 Cadence |
| `…1064e976` | 8 tasks, 2 drafts | Erin–Richard–Evan AI workshop |
| `…99e52b0a` | 4 tasks | Stand-Up 2026-08-05 |
| `…b18595cb` | 6 tasks | Stand-Up 2026-08-04 |

Zero failures. `.md`, `.txt` and `.json` transcripts all converted correctly. **Note:** because the
ingest checkpoint was wiped, these 65 tasks and 7 drafts are duplicates of work already delivered
before the wipe — they are in your account and will need clearing out.

### 4.2 YouTube Trends — 11 done

Trigger: **Record today**. Stages: `enumerate → fetch`.

Originally capped at 2 Runs by a one-per-local-day guard. On your decision that guard was lifted for
the manual trigger (§8.3, [ADR-0040](adr/0040-youtube-trends-measures-on-demand-not-once-a-day.md)),
and the Module then reached 11.

The point of the change, visible immediately in the live trend for Joe Budden TV:

| Measured | Views |
|---|---:|
| 2026-08-30 07:29 | 945,124,927 |
| 2026-08-31 06:29 | 945,702,382 |
| 2026-08-31 12:59 | 945,801,636 |
| 2026-08-31 13:06 | 945,804,080 |

**+99,254 views between 06:29 and 12:59 on the same day** — movement the old one-row-per-day shape
discarded entirely. Every Run is kept; none supersedes another.

**Separate gap found:** the trend spreadsheet was `null`, so the first two Runs recorded counts
**locally only** and wrote nothing to Sheets. YouTube Trends' stated purpose is a spreadsheet that
"outlives this app", and it silently produced none. I created it via Settings → **Create the
spreadsheet**: `10H4cNkC1Dg7ccy-OmKKKh5h7tOgCpiGxDKfV2s5Gm5o`. The silent-no-op itself is **not**
fixed and remains open.

### 4.3 Idea Engine — 10 done, 3 failed

Trigger: Drive poll / **Backfill historical transcripts**.
Stages: `convert →` twelve per-content-type stages `→ persist → draft`.

**Produced: 305+ Content Ideas** across 10 transcripts (the table below lists the first nine).

| Run (suffix) | Ideas | Run (suffix) | Ideas |
|---|---:|---|---:|
| `…f30cc999` | 64 | `…371285f4` | 33 |
| `…65da9c06` | 61 | `…0ca35ebe` | 28 |
| `…3d0f5149` | 53 | `…e4e86dee` | 24 |
| `…9e90376d` | 19 | `…a5e7a733` | 18 |
| `…f1730263` | 5 | | |

All three failures are **model-capability failures at the `response_format` binding**, not app bugs
(§5.2). One (`…371285f4`) succeeded on retry; two remain failed after two retries each.

### 4.4 Content Scout — 11 done, but `daily-intake` never completes

Setup had to be rebuilt from nothing. Sequence driven in the browser:

1. **Brand Profile** — bounded same-origin scan of `https://found42.com` → proposal from **1 page**,
   14 sections, all non-conflicting → accepted as revision `brand_20260830074521424_6bc55134`.
2. **Source Targets** — 12 active RSS feeds added (4 initially, 8 more when evidence proved short).
3. **Scout now** → `collect → rank → selection` → durable human gate.

| Intake | done | other |
|---|---:|---|
| `source-discovery` | 6 | — |
| `source-backfill` | 3 | 1 failed |
| `brand-profile-scan` | 1 | — |
| `daily-intake` | **0** | 2 skipped, 2 failed |

Discovery produced **212 Source Suggestions**; backfills collected **27 Source Items**.

**The blocking finding.** `daily-intake` has no completing path in the current state:

- Selecting an opportunity → `draft` fails `insufficient_evidence`: *"the selected opportunity has
  only 1 qualifying Source Items; at least 3 are required for an evidence-complete brief."*
- Every one of the 5 ranked opportunities carried **exactly 1** `sourceItemIds` entry — confirmed
  across two separate shortlists, and after tripling the source count from 4 to 12 feeds.
- Skipping → Run ends `skipped`, not `done`.

So `rank` structurally emits one-item opportunities while `draft` demands three. **Zero Content Packs
were produced** (`contentPacks: 0`) despite Notion being connected. This is the same
`insufficient_evidence` failure your handoff recorded from 2026-08-28, and it is not data-dependent —
it reproduces on fresh collection.

Two smaller findings: the `a16z` RSS feed fails `internal_failure` after 3 backoff attempts and
leaves a persistent "Collection is degraded" banner; and source discovery drifted badly off-brand,
returning academic papers on kinesthetic learning and hands-on pedagogy rather than founder/AI
sources (§5.4).

### 4.5 Meeting Brief Generator — 0 done, blocked on Guest Profile alone

Two sample meetings were created on your calendar with `notificationLevel: NONE` and
`@example.com` guest addresses (IANA-reserved, cannot receive mail), so **nothing was emailed to
anyone**:

| Meeting | Start | External guest | Internal |
|---|---|---|---|
| Found42 × Northwind Labs — platform partnership intro | 2026-08-30 18:30 −04:00 | Dana Whitfield (accepted), Marcus Lee (needsAction, optional) | — |
| Found42 × Meridian Health — AI workflow discovery call | 2026-08-30 19:45 −04:00 | Priya Raman (tentative) | colleague@found42.com |

`internalDomains` was set to `["found42.com"]` so the internal attendee is correctly excluded from
External Guest status.

Reconcile scheduled **3** eligible occurrences (the two samples plus your real
"Relay -> Claude Migration Training" on 2026-09-05, whose `dueAt` correctly computed to 4 h before
start).

Both Runs: `snapshot → enrich`, failed.

- `snapshot` **worked correctly** — froze `eventId`, `occurrenceId`, `occurrenceKey` and event
  `version`.
- `enrich` failed: `Connect your HubSpot private app first.`

**HubSpot is now connected** (private app "Chief of Staff" in portal 247222335, na2, with exactly
`crm.objects.contacts.read`, `crm.objects.companies.read` and `crm.objects.deals.read`; token
verified 12:26). After the §8.1 fix, `enrich` runs all the way through Gmail, Calendar history, Drive
(10 documents per guest) and HubSpot, and now stops at exactly one thing:

```
missing_configuration: Guest Profile not configured
```

**Guest Profile is the last blocker.** It is a per-user third-party people-enrichment HTTP API
(endpoint + key): given a guest's email it returns their current role, background, current employer
with evidence URLs, and an identity confidence — the "profile" quarter of the Module's stated
purpose. It is a pluggable endpoint rather than built in because the app deliberately does not scrape
LinkedIn ("no imported browser session or CAPTCHA bypass"); it is the replacement for the dead
reverseContact path tracked in [#115](https://github.com/nicolas-found42/chief-of-staff-demo/issues/115).

`enrich` treats all six providers as required (`enrich.ts:350`, "Spec A"), so a missing one fails the
whole Run. Whether that should degrade instead is a design decision, still open.

**Note on an earlier attempt:** the first pair of sample meetings was created for 05:45/06:45 local
and had fallen into the past by the time Calendar access was fixed, because the free-tier model made
the session run ~12 h longer than expected. Those two stale events are still on your calendar; I did
not delete them.

### 4.6 Content Research — 12/12 succeeded

| Intake | Runs | Stages |
|---|---:|---|
| `content-research-daily` | 6 | `collect → normalize → scoreResonance → extractHook → publish` |
| `content-research-backfill` | 3 (7d, 30d, 90d) | same |
| `people-discovery` | 3 | `discover` |

**Produced: 41 ledger rows** written to Sheets, resonance reports for both watched people, and **9
Person Suggestions** (Shreyas Doshi, Elena Verna, Julie Zhuo — each with a co-mention evidence URL,
via the new `search.ts` public-search seam).

Daily resonance for Lenny Rachitsky across successive Runs: `+56450` (cold start) → `-1650.79` →
`+5.45` → `+7.70` → `+5.16` → `+10.97`. Top item in the latest report was a YouTube video at 23,220
views / 249 likes → weighted 23,718.

**Pieter Levels scored `+0` on every single Run.** His only surface is `levels.io/rss`, which yields
no engagement counts, so there is nothing to score. He is on the watchlist but contributes no signal
— worth deciding whether that should surface as a "no measurable surface" state rather than a
misleading `+0`.

I left the 9 Person Suggestions unapproved, since approving them would change your watchlist beyond
the scope of exercising Runs.

---

## 5. Findings

### 5.1 Pending Drive Runs are silently and permanently dropped on restart (durability bug)

**Severity: high.** A transcript can be lost with no trace and no retry.

`RunnerHost.recoverRuns()` (`apps/server/src/engine/runner.ts:167`) runs every 30 s and asks the
Module for a recovery plan. Both `transcript` and `idea-engine` gate `planRecovery` on
`state.files.includes("transcript.txt")`:

- `apps/server/src/modules/transcript/module.ts:266`
- `apps/server/src/modules/idea-engine/module.ts:329`

`transcript.txt` is written by the **`convert` stage**. A Run that the Drive poller *enqueued but
never started* has no files at all, so `planRecovery` returns `null` and the Run is never recovered.
Meanwhile `rememberSeenForModule` has **already** recorded the file id in `state.json` at enqueue
time, so the poller will never re-queue it either.

**Observed live:** 6 Runs sat at `pending` with only a `created` event across multiple 30-second
recovery sweeps and a container restart, and never moved. The transcript is dropped permanently and
nothing surfaces the loss.

Suggested fix: let `planRecovery` return a `fresh` plan when a `pending` Run has no `transcript.txt`,
rather than `null` — the Drive spec is still in `meta.json` (`externalId`, `sourceUrl`, `fileName`).

### 5.2 The new model's structured-output support is unreliable

`dots-studio/dots-3-note-preview:free` (upstream **AtlasCloud**) fails the `response_format` binding
in three distinct ways:

| Classification | Detail | Where |
|---|---|---|
| `unusable_shape` | HTTP 200, 21,694 bytes, "no answer where the binding puts it" | Idea Engine `Live_thread` |
| `http_error` | HTTP 400, upstream code 400, "the provider refused the call" | Idea Engine `X/Twitter`, `LinkedIn_Carousel` |
| `transport_failure` | no status, no body | Content Scout `rank` |

It handles Transcript → Tasks perfectly (13/13) and Content Research fine, but fails the
higher-complexity per-content-type extraction and ranking. Retry ladders reached **attempt 6, 11 and
12** before giving up. The old model (`z-ai/glm-5.3-flash`) failed differently — a `request_timeout`
at the 300,000 ms ceiling with 0 bytes returned.

The failure diagnostics here are genuinely good: `modelBoundary` records classification, provider,
model, upstream server, binding, status and body size — shape only, no payload.

### 5.3 Malformed model JSON leaks into rendered UI text

The Content Scout shortlist renders a bare `},{` as a line of its own beneath the opportunity
rationale, visible in the browser. A JSON fragment from the model's output is reaching a display
field unsanitised. Cosmetic, but it is on-screen in the product.

### 5.4 Source discovery drifts off-brand

From a Found42 brand profile (AI-driven growth for founders/executives), `source-discovery` proposed
academic literature on kinesthetic learning, project-based learning and "hands-on training
outperforms traditional" — apparently keying on the phrase "hands-on" in the profile rather than the
business domain. Of 20 first-round suggestions, roughly half were unusable. This matters because
discovery is the intended remedy for thin evidence, and it does not supply on-brand sources.

### 5.5 `Check my setup` misdiagnoses a stale token as a missing scope

For all three broken Google surfaces the diagnostic said "The consent screen is missing the *X*
scope. Add it under Data Access, then sign in again." The consent screen was one cause, but the
proximate cause was a token predating the scope request, and for Calendar there was a third
independent cause (API not enabled) that only surfaced *after* re-consent. The message sends the
operator to the console when re-authentication alone may be the fix.

---

## 6. Verified working (uncommitted batch)

Both headline fixes in the uncommitted Content Research work were confirmed **live**, not just in
tests:

- **`resonanceBasis`** is recorded per item with real values — `z_score` and `delta_from_mean`
  observed in `run_20260831-080040_1f75c91c`. A cold-start raw level is no longer passed off as a
  z-score.
- **Conditional requests persist.** `workspace/content-research/people.json` holds per-URL
  validators, e.g. for `lennysnewsletter.com/feed`:
  `conditional: { etag: "W/\"65d7e-…\"", lastModified: null }`, alongside `checkpoint` and
  `lastSuccessfulAt`. The second Run genuinely sends `If-None-Match`.

Also confirmed: the **Google Picker** path for the Drive folder is present in Settings ("The picker
shows your Drive folders — no folder ID to copy"), so the spec drift recorded earlier has been
closed.

---

## 7. What is still outstanding

1. **Guest Profile endpoint + API key** — the single remaining blocker for Meeting Brief Generator.
   Everything else in that Module now passes.
2. **Content Scout `daily-intake`** still cannot complete: `rank` emits 1-item opportunities,
   `draft` requires 3. Zero Content Packs.
3. **Idea Engine's 3 failed Runs** are model-capability limits on
   `dots-studio/dots-3-note-preview:free`, not app defects (§5.2).
4. **YouTube's silent no-op** when no spreadsheet exists — a Run reports success while writing
   nothing to Sheets.
5. **65 duplicate Google Tasks and 7 duplicate Gmail drafts** from the re-ingest are in your account.
6. **Four stale sample calendar events** (two at 2026-08-30 05:45/06:45, two at 18:30/19:45) left in
   place — I did not delete them.
7. The uncommitted Content Research batch **plus this session's fixes** are all still uncommitted.
   The `a16z` feed still fails `internal_failure`.
8. `docs/adr/0039-…md` has an uncommitted modification predating this session.

## 8. Fixes applied after the exercise

Four defects found by this exercise were fixed in the working tree, each with a regression test
written red-first and verified to fail without its fix.

### 9.1 Meeting Brief: unsanitised event version broke every artifact name

Once HubSpot was connected, the Runs failed on something new and unrelated to credentials:

```
Invalid artifact name: gmail-exact-marcus_lee_example_com-"3576241611505950".json
```

Google returns the Calendar `etag` as a **quoted** string. Nine filename compositions interpolated
`eventVersion` directly while sanitising every other component, and `runs.ts` rejects any name
outside `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. This broke `enrich` for **every real Calendar event** — it
had never been caught because every test fixture used `version: "v1"`.

Fixed with one shared `sanitizeArtifactVersion()` in `enrichment/helpers.ts`, applied at all eight
filename sites across `google/gmail.ts`, `google/drive.ts`, `google/calendarHistory.ts`,
`enrichment/enrich.ts` and `enrichment/publicIntelligence.ts`. Regression test added to
`meeting-brief-google-enrichment.test.ts` using a realistic quoted ETag.

### 9.2 Transcript loss on restart (the §5.1 durability bug)

The Drive poller records a file as ingested the moment the Run exists, but the bytes live only in
memory until `convert` writes `transcript.txt` — which is exactly what `planRecovery` keys on. A
restart in between left a Run that could never be recovered and a checkpoint that stopped the poller
re-queuing it. The comment at the marking site states the right intent ("so a file the pipeline
rejected is retried on the next poll rather than silently swallowed"); "the Run exists" was simply
too early a moment.

Added `reclaimStrandedDriveRun()` and `forgetSeenForModule()` to `state.ts`, called from
`TranscriptHost.start()` and `IdeaEngineHost.start()` before the recovery loop. A Drive Run that is
`pending`/`running` with no `transcript.txt` is now failed visibly with
`stranded_before_convert` and its file is released back to the poller. A Run that already converted
is left alone, since `planRecovery` can resume that one.

### 9.3 YouTube Trends: measure on demand

On your decision, the manual **Record today** trigger now repeats as often as you like, so intra-day
view movement is visible. `DayAlreadyRecordedError` and its HTTP 409 branch are gone. The automatic
schedule is unchanged at one Run per local day, and **every Run is kept** — none supersedes another.

Because the trend is a Cross-Run index that sorted by `day`, repeats would have been ambiguous, so
`TrendPoint` now carries `measuredAt` (a fact `YoutubeRunResult` already recorded) and `TrendIndex`
orders by it. Recorded as [ADR-0040](adr/0040-youtube-trends-measures-on-demand-not-once-a-day.md).

### 9.4 The missing trend spreadsheet

Created during the exercise (`10H4cNkC1Dg7ccy-OmKKKh5h7tOgCpiGxDKfV2s5Gm5o`), so Runs now have
somewhere to append. The underlying silent-no-op behaviour — a Run reporting success while writing
nothing — is **not** fixed and remains an open finding.

### Still open from §5

- **§5.3** malformed model JSON (`},{`) leaking into rendered shortlist text.
- **§5.4** source discovery drifting off-brand.
- **§5.5** `Check my setup` misdiagnosing a stale token as a missing scope.
- **§4.4** Content Scout `daily-intake` still cannot complete: `rank` emits 1-item opportunities,
  `draft` requires 3.
- The YouTube silent-no-op above.

---

## 9. Handling

No API keys, tokens, passwords or OAuth secrets appear in this report. Cloud project name, HubSpot
portal id, spreadsheet id and Drive/Calendar identifiers are infrastructure identifiers, not
credentials. No transcript contents, Source Item bodies or brief contents are reproduced. The
pre-wipe workspace archive is in the session scratchpad only and is not committed.
