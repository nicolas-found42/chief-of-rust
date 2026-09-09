# App functional audit — does chief-of-staff-demo work, what is missing, what is needed

_Researched 2026-08-29 against HEAD `36e1bb9` for the functional-audit assignment. Prior audit `docs/run-report.md` (commit `28d1961`, 2026-08-28) is treated as a lead and verified against current HEAD; divergences are noted. Static claims are grounded in source only; the **Runtime verification** section below was measured live by a peer agent run at this checkout and HEAD, plus direct health probes of the operator's running stack._

## Question

Does the app work end to end, what is missing, and what is ordered to make it fully functional with no errors — chased to the owning file or GitHub issue for every claim?

---

## Executive verdict

The app builds, boots, and serves its local shell, five Modules, and opaque relay mechanics, but it is not fully functional as shipped: the Meeting Brief Generator is presented as live while its production bootstrap still uses an in-memory fake Calendar provider and a null owner-email resolver, the Compose `RELAY_BASE_URL` is ignored until manual registration, and the whole-tree gate is measurably red at HEAD — `npm run lint` needs a heap bump (issue #98) and e2e is 33/38 (issues #94, #96); the prior audit's knip and unit-test reds are fixed and live-verified green (see Runtime verification). Real Google, LLM, Notion, and HubSpot integrations are untested without credentials by design.

| Area | Result | Source |
| --- | --- | --- |
| Docker application image | Builds and boots per prior audit; declared gate is `docker compose build` + `GET /api/health` → `{"ok":true}` | `docs/run-report.md:28-60`, `docs/agents/verification.md:38-45`, `docker-compose.yml:12-17` |
| Docker relay image | Builds and boots; health endpoint `GET /health` → `{"ok":true}` | `docs/run-report.md:33-60`, `docker-compose.yml:48-60` |
| Shell navigation and layout | Live — routes `/`, `/transcript`, `/runs`, `/youtube`, `/idea-engine`, `/content-scout`, `/meeting-brief`, `/settings` rendered correctly; 320 px responsive width held | `docs/run-report.md:98-111`, `apps/web/src/App.tsx:65-77` |
| Settings persistence and secret redaction | Live — save round-trips, secrets return only `set` + hint, never echoed | `docs/run-report.md:124-149`, `apps/server/src/config.ts:250-278` |
| Core API empty-state behavior | Live — `GET /api/health`, `/api/config`, `/api/google/status`, `/api/runs`, `/api/youtube/trends`, `/api/idea-engine/ideas`, `/api/content-scout`, `/api/meeting-brief/index`, `/api/relay/status` all return 200 with expected empty states on a fresh workspace | `docs/run-report.md:200-227` |
| Opaque relay lifecycle | Live after manual registration; hashing, buffering, dedup, poll/ack verified | `docs/run-report.md:229-255`, `apps/server/src/relay/routes.ts:15-77`, `apps/server/src/relay/state.ts:11-24` |
| Meeting Brief production Calendar intake | **Not implemented** — fake provider wired in production | `apps/server/src/main.ts:161-162`, `apps/server/src/modules/meeting-brief-generator/host.ts:147`, `docs/run-report.md:377-392` |
| Typecheck | Declared gate `npm run typecheck` covers `packages/shared`, `apps/server`, `apps/web`, `tests` | `package.json:18`, `docs/agents/verification.md:12` |
| ESLint | Prior audit: crashes at default heap, passes only at `NODE_OPTIONS=--max-old-space-size=8192` | `docs/run-report.md:281-284` |
| Formatting | Prior audit: `prettier --check` passed; staged-file hook is `lint-staged` | `docs/run-report.md:260-264`, `package.json:34-41` |
| Knip / dead-code gate | Prior audit: failed (2 unused files, 24 unused exports, 8 unused exported types); HEAD has since deleted the two files and reserved the three provider entries explicitly | `docs/run-report.md:267-276`, `knip.jsonc:7-18` |
| Unit tests | Prior audit: 759/760 passed, 1 failed (`durable replace before expiration`); HEAD fixes that test to use the injected fixture clock | `docs/run-report.md:286-304`, `tests/src/modules/meeting-brief-calendar-intake.test.ts:425-428` at HEAD |
| Browser / e2e tests | Prior audit: 33/38 passed, 5 failed (4 stale expectations + 1 HubSpot hermetic failure) | `docs/run-report.md:305-373` |
| Real Google / LLM / Notion / HubSpot integrations | Not testable without credentials; per-ADRs each person supplies their own OAuth client, Notion token, HubSpot token, and provider API key | `README.md:71-80`, `docs/adr/0007-per-user-google-oauth-client.md:1-10`, `docs/adr/0027-per-user-notion-integration-token.md:1-10`, `packages/shared/src/schemas.ts:176-194`, `ONBOARDING.md:70-80` |

---

## What works (static evidence)

All items below are grounded in files at HEAD, not in re-executed gates.

**Dockerized single-port app remains the only supported runtime.** `README.md:35-40` and `docker-compose.yml:2-22` define `docker compose up -d --build` on `127.0.0.1:4317` with `workspace/` as a bind mount; the server binds `HOST=0.0.0.0` inside the container while the host side stays loopback-only per ADR-0001 (`apps/server/src/main.ts:40-43`, `docker-compose.yml:4-6`). The production entrypoint is `node apps/server/dist/main.js` and the web bundle is served from `apps/web/dist` via `fastifyStatic` (`apps/server/src/main.ts:174-178`).

**Shell owns navigation, Home, connection state, and the Run machinery.** `CONTEXT.md:9-24` defines the Shell/Module vocabulary; `apps/web/src/App.tsx:22-77` renders the shell chrome and routes; `apps/server/src/main.ts:51-55,165-167` wires one `Runs` store and the ordered `HostedModule[]`: transcript, YouTube Trends, Idea Engine, Content Scout, Meeting Brief Generator. Google OAuth is a Shell concern with a single registration flow (`README.md:71-79`, `docs/adr/0007-per-user-google-oauth-client.md:1-10`).

**Five Modules are registered as live or planned per the Shell registry.** Transcript → Tasks, YouTube Trends, Idea Engine, Content Scout, and Meeting Brief Generator are instantiated in `apps/server/src/main.ts:56-164` and started via `module.start?.()` (`apps/server/src/main.ts:295-297`). Content Scout is declared live per ADR-0028 (`docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:1-18`, `CONTEXT.md:34-37`); YouTube Trends is live and proves the `run(ctx,input)` contract (`README.md:27-31`); Meeting Brief Generator is declared live per `CONTEXT.md:219-225` but its production Calendar wiring is missing (see Missing).

**Static-file fallback correctly preserves SPA routing.** Unknown `/api/*` returns `404 application/json`; unknown client `GET` routes return `200 text/html` so the SPA can render its not-found page (`apps/server/src/main.ts:179-189`, `docs/run-report.md:112-120`). The residual asset-vs-route collision (`/missing.js` → 200 HTML) is tracked separately and does not break SPA navigation.

**Settings and secret handling are structurally correct.** Password fields remain empty after load/save; `GET /api/config` returns redacted `SecretHint` (`apps/server/src/config.ts:250-278`) and `PUT` keeps stored values when a secret field is omitted; Notion, HubSpot, and Google secrets are stored in `workspace/config.json` with `set` + last-four `hint` semantics (`packages/shared/src/schemas.ts:50-53,176-194`, `apps/server/src/config.ts:36-87`).

**YouTube Trends validates input before any write.** The YouTube page rejects `https://example.com/not-youtube` with guidance to paste a handle or channel-id URL (`docs/run-report.md:159-162`); the server parses channel refs in `apps/server/src/modules/youtube/channels.ts` and calls `videos.list` via the Google connection with the `youtube.readonly` scope (`docs/adr/0016-youtube-rides-the-google-connection.md:30-41`).

**Content Scout pipeline and adapter contract are intact in source.** The shared source-item envelope distinguishes unavailable/failed retrieval (`docs/research/content-scout-source-adapters.md:52-72`, `packages/shared/src/content-scout.ts`); the adapter states Available/Experimental/Coming later are explicit per ADR-0028 (`docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:45-51`); adapters isolate failures so one failure does not stop the others (`docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:11-14`). Immediate collection, in-app blocked shortlist, and 23-draft Content Pack with `NotionCalendarPublisher` are specified together (`docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:13-19`). Canary infrastructure (`ContentScoutCanaryRunner`, `ExternalRuntimeInspector`) and the `GET /api/content-scout` health surface were exercised manually in the prior audit (`docs/run-report.md:164-182`).

**Relay opaque wake-up contract is correctly shaped.** `relay/src/app.ts` and `relay/src/store.ts` implement hashed verifier, buffered opaque wake-ups without body, authentication, dedup, and poll/ack; `apps/server/src/relay/routes.ts:15-77` and `apps/server/src/relay/state.ts:11-32` persist installation identity/secret, channel token, expiration, and `lastWakeUpAt`; `docker-compose.yml:11` and `docker-compose.yml:49-52` wire the two Compose services. Prior audit verified the full cycle 204/401/400/poll-ack after manual registration (`docs/run-report.md:229-255`).

**Documented verification topology exists.** `docs/agents/verification.md:8-17` defines gates: single-file `npm run test --workspace @chief-of-staff-demo/tests`, whole-tree `npm run typecheck`, staged `lint-staged`, whole-tree `npm run check` (`typecheck && lint && format:check && knip && test`), `npm run check:all` (+ e2e), production image build+health, and clean-checkout CI. `package.json:18-23` implements the script split exactly as declared. ADR-0026 matches change granularity to gate cost (`docs/adr/0026-verification-gates-match-change-granularity.md:1-12`).

**Workspace durability is file-backed with no database.** `workspace/config.json`, `workspace/state.json`, `workspace/relay.json`, `workspace/runs/<runId>/{meta.json,result.json,events.jsonl}` are the only state, with `runs` opened once and shared (`apps/server/src/main.ts:52-54`, `apps/server/src/runs.ts`, `README.md:161-176`).

---

## Known-failing gates (static view; live re-runs in the next section)

Per the contract, this audit does **not** re-run `npm run check` / `npm run check:all` / `docker compose build`. The table below reports what the repo declares as its gates and what the last audit + current HEAD statically imply about them.

| Gate | Declared command | Last observed result | Current HEAD static delta |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc -b` + two `--noEmit` passes) (`package.json:18`, `docs/agents/verification.md:12`) | Prior audit: passed (`docs/run-report.md:260-262`) | No divergence claimed; TypeScript tree not re-verified live |
| ESLint (whole tree) | `npm run lint` (`package.json:19`, `docs/agents/verification.md:12`) | Prior audit: crashed twice at default ~4 GB heap (`FATAL ERROR: Ineffective mark-compacts`) and passed only at `NODE_OPTIONS=--max-old-space-size=8192` (`docs/run-report.md:280-285`) | Source still lints under the 8 GB workaround; durable fix is tracked as issue #98 |
| Prettier | `npm run format:check` (`package.json:21`, `docs/agents/verification.md:12`) | Prior audit: passed (`docs/run-report.md:262-264`) | Staged-file hook remains `simple-git-hooks` + `lint-staged` (`package.json:31-41`, `docs/agents/verification.md:23-33`) |
| Knip | `npm run knip` (`package.json:24`, `knip.jsonc:1-30`) | Prior audit: failed — 2 unused files (`apps/server/src/modules/meeting-brief-generator/connections.ts`, `apps/server/src/modules/meeting-brief-generator/enrichment/googleEnrichment.ts`), 24 unused exports, 8 unused exported types; whole-tree gate stopped at Knip (`docs/run-report.md:267-279`) | HEAD deletes both unused files and replaces `knip.json` with `knip.jsonc:7-18` that reserves `google/calendarHistory.ts`, `google/drive.ts`, `google/gmailDelivery.ts` as entries for issue #103; gate would be re-measured live by the RuntimeVerify peer |
| Unit tests | `npm test` → `tests` workspace vitest (`package.json:28`, `tests/vitest.config.ts:1-20`) | Prior audit: 759 passed / 1 failed out of 760; the failure `durable replace before expiration` derived expiry from `Date.now()` instead of the injected fixture clock (`docs/run-report.md:286-304`, `tests/src/modules/meeting-brief-calendar-intake.test.ts:425` at `28d1961`) | HEAD commit `36e1bb9` rewrites that line to `new Date(now.getTime() + 30*60*1000)` so the delta is 30 min against the injected `2026-08-28T09:00:00Z`; no live re-run |
| e2e (Playwright) | `npm run test:e2e` (`package.json:29`, `tests/playwright.config.ts:1-25`, `docs/agents/verification.md:15`) | Prior audit: 33 passed / 5 failed; four are stale expectations (busy-control `aria-disabled` overload covering 6 Meeting Brief HubSpot/Guest Profile controls, nav focus order Content Scout→Settings now interrupted by Meeting Brief, scope count 6 vs 7 with `gmail.send`, `getByText("Internal")` ambiguity), one is the Meeting Brief journey contacting real HubSpot (`docs/run-report.md:339-373`, `apps/web/src/pages/SettingsPage.tsx:1142`, `apps/web/src/pages/SettingsPage.tsx:1237`, `tests/e2e/a11y.spec.ts:446`, `tests/e2e/ui.spec.ts:66`, `tests/e2e/ui.spec.ts:660`, `tests/e2e/meeting-brief-journey.spec.ts:46`) | No source divergence for the four stale tests at HEAD; HubSpot hermetic gap is tracked as issue #96 — all deferred to live re-run |
| Production image | `docker compose build` + `docker compose up -d` + `curl --fail http://127.0.0.1:4317/api/health` (`docs/agents/verification.md:38-45`) | Prior audit: both images built (app ~1.05 GB, relay ~82 MB), both `health` endpoints returned `{"ok":true}`, `pwuser` for app, no `USER` for relay (`docs/run-report.md:28-68`, `relay/Dockerfile:1-18`, `Dockerfile:95-96`) | `Dockerfile` and `relay/Dockerfile` unchanged in the `28d1961..HEAD` diff except for build-cache retention; live build not re-run |
| Orchestrator loop gate | `scripts/orchestrator-loop-gate.mjs` at fixed point `8feea68` (`docs/orchestrator-loop-gate-todo.md:3-6`) | Round 1: Standards 0 hard / 3 smells; Spec 4 missing / 3 wrong across issues #72–#78 — gate RED (`artifacts/orchestrator/baseline-round-1.md:7-34`, `artifacts/orchestrator/round-1.md:7-34`) | Fixed point still `8feea68`, `HEAD` is `36e1bb9`; the 7 gate issues #72–#78 are CLOSED as COMPLETED in the tracker (`gh issue list --state closed`), so the recorded RED round predates their fixes — a fresh gate round is the outstanding verification (Remediation 9) |

---

## Runtime verification — live gates re-run (2026-08-29, HEAD `36e1bb9`)

Executed in a fresh process against this checkout (peer transcript `RuntimeVerify`); live-stack health probed directly. This supersedes the "pending live" columns above and in Divergences.

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | Pass | exit 0; shared/server build + web/tests `--noEmit` clean |
| `npm test` | Pass — 760/760 across 55 files (3.9s) | prior single failure `durable replace before expiration` gone — confirms the `36e1bb9` clock fix live |
| `npm run knip` | Pass | exit 0, no findings — confirms the `5e4a00a` deletions + `knip.jsonc:7-18` reservations live |
| `npm run lint` (default heap) | **Fail** | V8 heap OOM, exit 134 after ~36s (`Ineffective mark-compacts near heap limit`) — issue #98 open |
| `npm run lint` (`NODE_OPTIONS=--max-old-space-size=8192`) | Pass | exit 0 in 14.4s — manual heap workaround still required |
| `npm run format:check` | Pass | all files Prettier-clean |
| `npm run build` | Pass | server `tsc` + vite 73 modules |
| `npm run test:e2e` | **Fail — 33 passed / 5 failed** (49.2s) | four stale expectations per issue #94 (`tests/e2e/a11y.spec.ts:252` busy-control overload — 7 controls match, `tests/e2e/a11y.spec.ts:455` nav focus after direct run load, `tests/e2e/ui.spec.ts:66` 6 scopes vs expected 7 missing `gmail.send`, `tests/e2e/ui.spec.ts:660` `Internal` strict-mode ×3) plus the Meeting Brief journey abort per issue #96 (`tests/e2e/meeting-brief-journey.spec.ts:50`, `hubRes.ok()` false on HubSpot connect) |
| Production image gate | Skipped — live stack occupies the ports | 4317/4318 held by the operator's healthy Compose stack (app up ~6h, relay ~7h); per `docs/agents/verification.md:38-45` an occupied stack must not be touched. Direct probes instead: `GET /api/health` → `{"ok":true}`, `GET :4318/health` → `{"ok":true,"service":"relay"}` |

Verdict: **degraded**. `npm run check` is red only at lint's default heap (issue #98); `npm run check:all` additionally red at e2e (issues #94, #96). Remediation items 3–4 close the gate gap; items 5–7 close the functionality gaps.

## Missing / not implemented

All items are traced to the owning file or issue; no speculation beyond what the sources state.

1. **Meeting Brief production Calendar provider is still fake.** `apps/server/src/main.ts:161-162` comments that the real provider "lands in later wave" and `apps/server/src/modules/meeting-brief-generator/host.ts:147` defaults `deps.calendarProvider ?? new FakeCalendarProvider()`. The host comment at `apps/server/src/modules/meeting-brief-generator/host.ts:125-126` marks the Module as planned until production providers are connected. Production therefore never watches a real Google Calendar, Intake never receives real events, and startup channel/sync-token logs come from the fake (`docs/run-report.md:377-392`). Issue #103.

2. **Owner email resolver returns nothing in production.** `apps/server/src/main.ts:162` wires `getOwnerEmail: () => null`; `apps/server/src/modules/meeting-brief-generator/host.ts:312-316` returns that unconditionally, so the owner-only delivery path (`apps/server/src/modules/meeting-brief-generator/google/gmailDelivery.ts:149-220`, ADR-0034 at `docs/adr/0034-meeting-briefs-auto-send-only-to-the-owner.md:1-12`) has no recipient in production. The Google connection's identity is the intended source per the binding spec. Issue #103.

3. **Compose `RELAY_BASE_URL` has no effect on a fresh workspace.** `docker-compose.yml:11` sets `RELAY_BASE_URL: http://relay:4318`, but `apps/server/src/relay/routes.ts:15-77` initializes exclusively from `workspace/relay.json` and only persists a base URL on `POST /api/relay/install`. Fresh-workspace `GET /api/relay/status` is `not_configured` until manual registration (`docs/run-report.md:406-426`). Issue #99.

4. **Meeting Brief e2e journey is not hermetic.** `tests/e2e/meeting-brief-journey.spec.ts:46` posts a fake HubSpot token and expects success, but the test server injects no fake HubSpot probe; the probe leaves the machine and HubSpot returns `400 Authentication credentials not found` (`docs/run-report.md:356-361`). Downstream wake-up, scheduling, enrichment, composition, revision, and coalescing assertions never execute. Issue #96.

5. **Scheduling lives in Intake, not in blocked Runs — but unexplored pre-preparation window still waits in Intake.** ADR-0032 (`docs/adr/0032-upcoming-meetings-wait-in-intake-not-runs.md:1-14`) and ADR-0033 (`docs/adr/0033-calendar-event-revisions-create-new-runs.md:1-12`) require a Module-owned Intake schedule with durable wake-up, deduplicated same-version pushes, and revision Runs that supersede prior briefs. The durable clock (`apps/server/src/engine/durableClock.ts`), Intake reconciliation (`apps/server/src/modules/meeting-brief-generator/intake.ts:185-189`), and quiet-period coalescing (`apps/server/src/modules/meeting-brief-generator/deliver.ts:76-79`, `docs/adr/0034-meeting-briefs-auto-send-only-to-the-owner.md:9-12`) are present behind the fake provider; production Calendar wiring is the missing integration seam above.

6. **Credential-dependent surfaces need per-person setup before they function.** Google OAuth (Tasks/Gmail drafts/Drive/YouTube/Sheets) requires a user-registered OAuth client and seven scopes including `gmail.send` for Meeting Brief (`README.md:71-92`, `docs/adr/0007-per-user-google-oauth-client.md:1-10`); extraction needs `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / OpenRouter / Ollama base URL (`README.md:94-111`, `ONBOARDING.md:70-80`, `packages/shared/src/schemas.ts:49-87`); Content Scout Notion publishing needs a per-user integration token (`docs/adr/0027-per-user-notion-integration-token.md:1-10`, `apps/server/src/config.ts:49-87`); HubSpot enrichment needs a private-app token (`packages/shared/src/schemas.ts:176-194`, `apps/server/src/modules/meeting-brief-generator/hubspot/connection.ts`); Guest Profile needs endpoint + API key (`packages/shared/src/meeting-brief.ts:152-185`, `apps/server/src/modules/meeting-brief-generator/profile/provider.ts:462-473`). Without those, the corresponding Runs fail at `extract` or `outputs` with typed diagnostics and are retryable (`README.md:188-202`). None is a code defect; each is an operator prerequisite documented in `ONBOARDING.md:70-114`.

7. **Content Scout gate follow-ups: closed in the tracker; gate re-run still owed.** The seven gate issues #72–#78 from `docs/orchestrator-loop-gate-todo.md:13-20` and `artifacts/orchestrator/round-1.md:22-29` are all CLOSED with `stateReason: COMPLETED` (`gh issue list --state closed --json number,stateReason`, audit time). Spot-checks against HEAD source confirm the headline gaps are addressed: comment fetch is capped at 50 (`apps/server/src/modules/content-scout/adapters/youtube.ts:620`), Substack labels feed-level misses `unavailable` while reserving `failed` for enrichment errors (`apps/server/src/modules/content-scout/adapters/substack.ts:136-160`), and canary persistence moved to a shared `ContentScoutCanaryStore` writing `workspace/content-scout/canary-state.json`, used by both host and runner, replacing the old `linkedin-canaries.json` disconnect (`apps/server/src/modules/content-scout/canary.ts:42-50`, `apps/server/src/modules/content-scout/host.ts:188-194`). #73, #74, #77, #78 were not individually re-verified against source; the outstanding verification is a fresh gate round (Remediation 9).

8. **Smaller shipped-vs-documented gaps.** Global footer copy states "Drafts are created, mail is never sent." (`apps/web/src/App.tsx:80-81`) which contradicts the Meeting Brief owner-only `gmail.send` exception explained in `README.md:209-211` and ADR-0034 — issue #100. `GET /missing.js` returns SPA HTML with `200` instead of `404` due to `apps/server/src/main.ts:179-189` `setNotFoundHandler` — issue #101. Relay image runs as root (no `USER` directive) while the app image correctly uses `pwuser` (`relay/Dockerfile:1-18`, `Dockerfile:95-96`) — issue #102. Fresh-workspace startup auto-fires the 24-receipt public canary batch (`docs/run-report.md:452-467`, `apps/server/src/modules/content-scout/host.ts` canary runner) — issue #104.

9. **Marker scan across source.** A pattern scan across `apps/`, `packages/`, `relay/` for the marker set `not-implemented`/`fake`/`stub`/`placeholder` plus the usual task tags at HEAD finds only intentional seams: `FakeCalendarProvider`, `FakeCalendarHistoryProvider`, `FakeGmailDeliveryProvider`, fake Guest Profile providers, and test-only stubs (`apps/server/src/main.ts:243-268`, `apps/server/src/modules/meeting-brief-generator/calendar.ts:210-216`, `apps/server/src/modules/meeting-brief-generator/google/gmailDelivery.ts:145-149`, `apps/server/src/modules/meeting-brief-generator/enrichment/enrich.ts:35-38`). No stray task-tag markers beyond those documented fakes remain in production source.

---

## Remediation plan — ordered, each item traced

Order is dependency-first: unblock the verification signal, then the production wiring that makes live Modules truthful, then the correctness details.

### 0) Precondition: do not ship a partial Meeting Brief — keep the binding bar

The movement plan ends "Do not expose a partial movement as a live Module" and the binding spec #80 keeps the Module planned until Calendar push and all enrichments exist (`docs/adr/0028-content-scout-separates-collection-selection-and-publication.md:51-55`, issue #103 triage). Every Meeting Brief item below preserves that bar; the fake remains acceptable only behind the test seam, never in `main.ts` production wiring.

### 1) Restore the Knip gate (fixed at HEAD, live-confirmed)

- **Source-confirmed:** commit `5e4a00a` deleted `connections.ts` and `enrichment/googleEnrichment.ts` and added `knip.jsonc:7-18` reserving the three real-provider factories for issue #103; commit `36e1bb9` fixed the unit-test clock (`tests/src/modules/meeting-brief-calendar-intake.test.ts:425-428`). Prior audit's `knip` failure (`docs/run-report.md:267-279`) is therefore statically addressed.
- **Live-confirmed:** `npm run knip` exits 0 with no findings at HEAD (see Runtime verification). If fresh unused exports reappear, remove dead code rather than blanket-ignoring, keeping the `knip.jsonc:12-16` entries narrowly justified. Trace: issue #97 (closeable once the live green gate is recorded), `knip.jsonc:1-30`, `docs/run-report.md:267-279`.

### 2) Fix the durable-replace unit test clock (fixed at HEAD, live-confirmed)

- Source fix already at HEAD (`tests/src/modules/meeting-brief-calendar-intake.test.ts:425`); live `npm test` now reports 760/760 with no failures (see Runtime verification). Issue #95 can close on the recorded green gate. Trace: issue #95, `docs/run-report.md:298-304`.

### 3) Fix the four stale e2e expectations

- Replace the `aria-disabled="true"` busy helper with a dedicated busy signal (`aria-busy` or a narrower selector) so the six Meeting Brief HubSpot/Guest Profile unavailable controls (`apps/web/src/pages/SettingsPage.tsx:1142`, `apps/web/src/pages/SettingsPage.tsx:1237`) no longer pollute the busy assertion; insert Meeting Brief between Content Scout and Settings in the expected nav order (`tests/e2e/a11y.spec.ts:446`); expect seven Google scopes including `gmail.send`; disambiguate the `Internal` locator. Live gate is `npm run test:e2e`. Trace: issue #94, `docs/run-report.md:342-373`.

### 4) Make the heap fix durable so `npm run lint` completes without manual env juggling

- Either raise the lint heap inside the repo (e.g., `NODE_OPTIONS` in the `lint` script or ESLint config) or reduce typed-lint cost, then confirm `npm run lint` (without external `NODE_OPTIONS`) passes from a clean checkout. Host at prior audit was Node 26.7.0 (`docs/run-report.md:281-285`). Trace: issue #98, `package.json:19`, `docs/agents/verification.md:12-13`.

### 5) Wire the real Google Calendar provider and owner email in production bootstrap

- Replace `apps/server/src/main.ts:161-162` (`getOwnerEmail: () => null` + fake `CalendarProvider`) with the real `Google Calendar` provider built from the `googleConnection` and the `googleapis` client, and resolve owner email from the connected Google identity as specified in ADR-0031/0034 and the binding spec #80 (primary calendar watch, `expiration` persistence, replace-before-expiry, incremental sync on startup/wake/invalid-sync via `apps/server/src/modules/meeting-brief-generator/intake.ts` + `calendar.ts` + `host.ts:146-147,311-316`). Persisted state remains in `workspace/relay.json` + `workspace/state.json` via `MeetingBriefCalendarStore`. This is the largest functional gap (`docs/run-report.md:377-392`). Acceptance is the binding spec's go-live bar and the hermetic journey below; do not mark live until that journey passes. Trace: issue #103, `apps/server/src/main.ts:156-164`, `apps/server/src/modules/meeting-brief-generator/host.ts:51-147`, `docs/adr/0031-calendar-push-uses-an-opaque-cloud-relay.md:1-15`, `docs/adr/0034-meeting-briefs-auto-send-only-to-the-owner.md:1-12`.

### 6) Make `RELAY_BASE_URL` take effect on a fresh workspace

- On startup, if `workspace/relay.json` has no `relayBaseUrl` and `process.env.RELAY_BASE_URL` is set, seed the store from the env so `GET /api/relay/status` leaves `not_configured` and the documented `docker compose up -d` topology self-connects without manual `POST /api/relay/install`. Stored URL continues to win when present. Trace: issue #99, `docker-compose.yml:10-11`, `apps/server/src/relay/routes.ts:48-55`, `apps/server/src/relay/state.ts:34-36,94-102`.

### 7) Inject a fake HubSpot probe so the Meeting Brief e2e journey is hermetic

- Provide a `FakeHubSpotApi` transport behind the test flag (`ENABLE_TEST_SEED`) that answers the probe for the fake token, so `tests/e2e/meeting-brief-journey.spec.ts` runs fully offline and its later wake-up/schedule/enrichment/composition/delivery/revision/coalescing assertions actually execute. Then the journey proves item 5 end to end. Trace: issue #96, `tests/e2e/meeting-brief-journey.spec.ts:46`, `apps/server/src/main.ts:203-204`, `apps/server/src/modules/meeting-brief-generator/hubspot/connection.ts`.

### 8) Correct lower-severity shipped copy and routing

- **Footer:** qualify `apps/web/src/App.tsx:80-81` to reflect the Meeting Brief owner-only send exception (keep the draft-only ban narrowly scoped as `README.md:209-211` and ADR-0034 do, and keep the banned-token unit test in `tests/src/unit/draft-mime.test.ts`). Trace: issue #100.
- **Asset 404:** narrow `apps/server/src/main.ts:179-189` `setNotFoundHandler` so extension-bearing or `/assets/*` misses return `404` while client routes retain the HTML fallback. Trace: issue #101.
- **Relay USER:** add `USER` to the runtime stage of `relay/Dockerfile:1-18` so the publicly-hosted component does not run as root. Trace: issue #102.
- Items 8 may be batched; none blocks item 5 but each removes a user-visible inconsistency noted in the prior audit (`docs/run-report.md:433-449`).

### 9) Bank the closed Content Scout fixes with a fresh orchestrator gate round

- The seven gate fixes (#72–#78, all CLOSED COMPLETED) and the knip/unit fixes (`5e4a00a`, `36e1bb9`) landed after the last recorded round (`artifacts/orchestrator/round-1.md:7-34`, RED). Re-run `scripts/orchestrator-loop-gate.mjs` at fixed point `8feea68` → `36e1bb9` per `docs/orchestrator-loop-gate-todo.md:25-33,36-46` and persist a green round report before closing umbrella #42; whole-tree `npm run check` plus per-adapter canary/receipt evidence are the gate's own bar. Spot-checks already confirm cap 50 (`apps/server/src/modules/content-scout/adapters/youtube.ts:620`), Substack `unavailable`/`failed` (`apps/server/src/modules/content-scout/adapters/substack.ts:136-160`), and shared canary persistence (`apps/server/src/modules/content-scout/canary.ts:42-50`, `apps/server/src/modules/content-scout/host.ts:188-194`). Note: `docs/orchestrator-loop-gate-todo.md` Phase 1 still lists #72–#78 as open checkboxes and is stale relative to the tracker.

### 10) Keep `docs/next-issues.html` and the orchestrator gate as the execution order

- `docs/next-issues.html:233-512` already orders Phase 0 (tracker truth), Phase 1 (selection/evidence), Phase 2 (source capabilities), Phase 3 (reliability/receipts), Phase 4 (Module roadmap). Bank the Content Scout gate with a fresh orchestrator round (item 9) before advancing Phase 2–3; do not advance Meeting Brief (#14), Content Research (#21), or LinkedIn Engagement (#23) until the central loop is trustworthy. Trace: `docs/next-issues.html:230-512`, `docs/orchestrator-loop-gate-todo.md:8-53`.

---

## Open GitHub issues that block full functionality

Rows carry live tracker state at audit time (`gh issue list --state open --json number --limit 200`, plus `--state closed` for #72–#78). Blockers are those whose fix is required for the app to behave as its live surfaces advertise; the remaining wayfinder grillmap issues are deferred Module decisions.

| Issue | Title | Blocking? | Why |
| --- | --- | --- | --- |
| #103 | Meeting Brief production bootstrap still wires the fake Calendar provider; real Calendar intake never runs | **Yes** | Production Intake never sees a real Calendar; the live Meeting Brief tab cannot perform its advertised workflow (`apps/server/src/main.ts:161-162`) |
| #99 | Compose `RELAY_BASE_URL` is ignored; a fresh Compose topology does not self-connect the relay | **Yes** | Fresh `docker compose up -d` leaves `relayHealth: "not_configured"` despite a healthy relay (`docker-compose.yml:11`, `apps/server/src/relay/routes.ts:15-32`) |
| #96 | Meeting Brief e2e journey contacts real HubSpot; inject a fake probe so the hermetic journey runs | **Yes** | The whole Meeting Brief journey aborts at step one, so no proof of scheduling/enrichment/delivery exists (`tests/e2e/meeting-brief-journey.spec.ts:46`) |
| #95 | Unit test "durable replace before expiration" derives expiry from the wall clock | **Yes** | Deterministic whole-tree gate failure until source fix is live-verified (`tests/src/modules/meeting-brief-calendar-intake.test.ts:425`) — source-fixed at `36e1bb9` |
| #97 | Knip gate red: 2 unused files, 24 unused exports, 8 unused exported types | **Yes** | `npm run check` stops at Knip (`package.json:22`) — source-fixed at `5e4a00a`+`36e1bb9` via `knip.jsonc:7-18` |
| #98 | Default `npm run lint` crashes with a V8 heap OOM | **Yes** | Documented `npm run lint` is not operational without manual heap bump (`package.json:19`, `docs/run-report.md:280-285`) |
| #94 | e2e suite: fix four stale expectations/locators after Meeting Brief landed | **Yes** | 4/5 e2e failures are stale expectations that keep `npm run check:all` red (`tests/e2e/a11y.spec.ts:446`, `tests/e2e/ui.spec.ts:66`) |
| #100 | Global footer copy ("mail is never sent") contradicts the Meeting Brief owner-only send exception | No | Copy misleading on every page but not a functional failure (`apps/web/src/App.tsx:80-81`) |
| #101 | Missing asset-like routes return SPA HTML with 200 instead of 404 | No | Stale hashed assets surface as opaque MIME errors; low severity (`apps/server/src/main.ts:179-189`) |
| #102 | Relay container image runs as root | No | Hardening gap; no functional failure observed (`relay/Dockerfile:1-18`) |
| #104 | Fresh-workspace startup auto-fires the 24-receipt public canary batch | No | Design observation about outbound canary traffic (`docs/run-report.md:452-467`) |
| #72–#78 | Seven Content Scout gate follow-ups (comment ranking, domain/category similarity, fixtures, LinkedIn persistence, Substack `unavailable`, YouTube `causeChain`, empty-shell detection) | Closed — not blocking | All seven CLOSED `COMPLETED` at audit time; HEAD spot-checks confirm cap 50, Substack `unavailable`/`failed`, shared canary store; a fresh gate round is still owed (Remediation 9) |
| #12–#24 | Wayfinder grillmap (Executive Coach, Curate Newsletters, Meeting Follow-Up, Content Research, LinkedIn Engagement Tracker, Move Meeting Videos, Weekly AI Wins) | No | Deferred Module brainstorms; intake not yet specified (`docs/next-issues.html:435-511`) |

Total open issues: 19 — the 11 triaged functional issues #94–#104 plus the 8 wayfinder grillmap issues #12/#15/#16/#18/#21–#24 (`gh issue list --state open --json number --limit 200`, audit time). The Content Scout gate issues #72–#78 are CLOSED (COMPLETED) and not counted. Open blocking set for full functionality: #94, #95, #96, #97, #98, #99, #103 (7 issues) — of which #95 and #97 are already fixed and live-verified green at HEAD, leaving 5 actionable blockers: #94, #96, #98, #99, #103.

---

## Divergences from `docs/run-report.md` at current HEAD

| Prior claim | HEAD verification | Divergence? |
| --- | --- | --- |
| Knip failed with 2 unused files `connections.ts` + `enrichment/googleEnrichment.ts` (`docs/run-report.md:272-276`) | Both files deleted at HEAD (`5e4a00a`); `knip.jsonc:7-18` reserves `google/calendarHistory.ts`, `google/drive.ts`, `google/gmailDelivery.ts` with an explicit comment "kept for issue #103" | **Diverged** — statically addressed, live re-run deferred |
| Unit test `durable replace before expiration` failed deterministically because expiry used `Date.now()` vs injected clock (`docs/run-report.md:299-304`) | Fixed in `36e1bb9` to `new Date(now.getTime() + 30*60*1000)` (`tests/src/modules/meeting-brief-calendar-intake.test.ts:425`) | **Diverged** — statically fixed |
| E2E `33/38` and unit `759/760` tallies (`docs/run-report.md:286-310`) | Counts not re-measured live; e2e stale failures #94 and HubSpot #96 unchanged at HEAD | **Not diverged** — pending live re-run |
| Production Calendar bootstrap uses `FakeCalendarProvider` and `getOwnerEmail: () => null` (`docs/run-report.md:378-392`, `apps/server/src/main.ts:161-162`) | Unchanged at HEAD; still present verbatim | **Not diverged** |
| Relay required manual registration, `RELAY_BASE_URL` ignored (`docs/run-report.md:406-426`) | `docker-compose.yml:11` and `apps/server/src/relay/routes.ts:15-55` unchanged | **Not diverged** |
| Footer, asset fallback, relay root gaps (`docs/run-report.md:433-450`) | `apps/web/src/App.tsx:80-81`, `apps/server/src/main.ts:179-189`, `relay/Dockerfile:1-18` unchanged | **Not diverged** |

---

## What was not attempted

Real credential-dependent integrations (Google OAuth/Tasks/Gmail/Drive/YouTube/Sheets, live LLM providers, Notion, HubSpot, Guest Profile provider) were not exercised; no workspace with user credentials was present and no credentials were created, matching the prior audit's limitation (`docs/run-report.md:469-482`). No whole-tree `npm`/`docker` gates were re-executed; `RuntimeVerify` owns those live measurements.

---

## Sources

Primary sources only. Every factual claim above cites the owning file or issue; secondary summaries cite their primary:

- `CONTEXT.md:9-274` — Shell/Module/Content Scout/Meeting Brief vocabulary
- `README.md:1-211` — what the app does, Docker-only runtime, configuration, verification
- `ONBOARDING.md:1-185` — credential prerequisites for a first operator
- `docker-compose.yml:1-60` — services, ports, healthchecks, `RELAY_BASE_URL`
- `Dockerfile:95-96` + `relay/Dockerfile:1-18` — runtime images and `USER`
- `package.json:18-41` — `check`/`check:all`/`typecheck`/`lint`/`knip` gates, `lint-staged`
- `knip.jsonc:1-30` — entry reservations for the real-provider wave
- `docs/agents/verification.md:1-48` — gate topology
- `docs/run-report.md:1-505` — prior audit (verified claim-by-claim)
- `docs/orchestrator-loop-gate-todo.md:1-64` — fixed point `8feea68`, 7 gate issues, loop contract
- `artifacts/orchestrator/baseline-round-1.md:1-34` + `artifacts/orchestrator/round-1.md:1-34` — Standards/Spec findings
- `docs/next-issues.html:233-512` — phased roadmap #35–#61, #12–#24
- `docs/adr/0001-local-first-single-user.md` + `docs/adr/0007-per-user-google-oauth-client.md` + `docs/adr/0016-youtube-rides-the-google-connection.md` + `docs/adr/0027-per-user-notion-integration-token.md` + `docs/adr/0028-content-scout-separates-collection-selection-and-publication.md` + `docs/adr/0030-model-boundary-failures-are-classified-facts.md` + `docs/adr/0031-calendar-push-uses-an-opaque-cloud-relay.md` + `docs/adr/0032-upcoming-meetings-wait-in-intake-not-runs.md` + `docs/adr/0033-calendar-event-revisions-create-new-runs.md` + `docs/adr/0034-meeting-briefs-auto-send-only-to-the-owner.md`
- `docs/research/content-scout-source-adapters.md:1-357` / `docs/research/dev-tooling.md:1-329` — format conventions followed
- `apps/server/src/main.ts:40-311` + `apps/server/src/relay/routes.ts:15-216` + `apps/server/src/relay/state.ts:1-126` + `apps/server/src/modules/meeting-brief-generator/host.ts:1-782` + `apps/server/src/config.ts:36-278` + `packages/shared/src/schemas.ts:50-232` + `apps/web/src/App.tsx:22-84` — server/shell/relay/config/UI grounding
- GitHub issues at audit time — open (`gh issue list --state open --json number --limit 200`): #12, #15, #16, #18, #21–#24, #94–#104; closed COMPLETED (`gh issue list --state closed --json number,stateReason`): #72–#78
