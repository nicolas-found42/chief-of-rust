import { expect, test } from "./fixture";

const START_AT = "2026-08-28T15:00:00.000Z";
const DUE_AT = "2026-08-28T11:00:00.000Z";
const NOW_BEFORE_DUE = "2026-08-28T10:00:00.000Z";

function fixtureEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calendarId: "primary",
    eventId: "evt_journey_1",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Initial Meeting",
    description: "Q3 planning",
    startAt: START_AT,
    endAt: "2026-08-28T15:30:00.000Z",
    location: "Room A",
    conferenceLink: "https://meet.example.com/abc",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
    attachments: [],
    ...overrides,
  };
}

test("meeting brief hermetic journey — setup → wake → clock → brief → send → revision → coalesced update", async ({
  page,
  request,
}) => {
  // 1. Setup: configure Internal Domains and fake connections (hermetic, fake providers)
  await request.post("/api/test/meeting-brief/set-now", {
    data: { now: NOW_BEFORE_DUE },
  });

  // Internal Domains — comma separated via existing config route
  const cfgRes = await request.put("/api/meeting-brief/config", {
    data: { internalDomains: ["internal.example.com"] },
  });
  expect(cfgRes.ok()).toBe(true);
  const cfg = (await cfgRes.json()) as { internalDomains: string[] };
  expect(cfg.internalDomains).toContain("internal.example.com");

  // Fake HubSpot connection (per-user token, redacted hint)
  const hubRes = await request.post("/api/meeting-brief/hubspot/connect", {
    data: { token: "pat-na1-fake-journey-token" },
  });
  expect(hubRes.ok()).toBe(true);

  // Verify Settings coherently presents diagnostics (one place: Settings page)
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Meeting Brief Generator" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Internal Domains" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "HubSpot CRM" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Person Profiles" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Google — Calendar, Gmail, Drive" }),
  ).toBeVisible();
  // Relay health/channel/last wake-up visible in Settings (relay section)
  await expect(page.getByRole("heading", { name: "Calendar Relay", exact: true })).toBeVisible();
  await expect(page.getByText("Relay health:", { exact: true })).toBeVisible();

  // 2. Seed Calendar wake-up (header-only wake never mistaken for data — we reconcile)
  // Clear any prior fake gmail
  await request.post("/api/test/meeting-brief/fake-gmail/clear");

  const v1 = fixtureEvent({ version: "v1", summary: "Initial Meeting" });
  // Schedule as Intake durable schedule (upcoming) with due at DUE_AT
  const sched1 = await request.post("/api/test/meeting-brief/schedule", {
    data: { event: v1, dueAt: DUE_AT },
  });
  expect(sched1.ok()).toBe(true);

  // Verify upcoming appears via index (Intake schedules)
  const idx = (await (await request.get("/api/meeting-brief/index")).json()) as {
    upcoming: { occurrenceKey: string; version: string }[];
    briefs: unknown[];
  };
  expect(idx.upcoming.some((u) => u.version === "v1")).toBe(true);

  // Open live tab — shows upcoming, no current brief yet
  await page.goto("/meetings/brief");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Brief" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upcoming meetings" })).toBeVisible();
  await expect(page.getByText("Initial Meeting")).toBeVisible();
  await expect(page.getByText(/Current briefs/)).toBeVisible();

  // 3. Advance fake clock to due → Intake creates Run with 4 Stages and completes
  const advance1 = await request.post("/api/test/meeting-brief/advance", {
    data: { now: DUE_AT },
  });
  expect(advance1.ok()).toBe(true);

  // Process due is done inside advance; poll index for brief
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { eventVersion: string; delivery: { status: string } | null }[];
        };
        const v1Brief = data.briefs.find((b) => b.eventVersion === "v1");
        return v1Brief?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

  const idxAfter = (await (await request.get("/api/meeting-brief/index")).json()) as {
    upcoming: unknown[];
    briefs: {
      eventVersion: string;
      delivery: unknown;
      meetingBrief: { sourceReferences: string[]; missingEvidence: string[] } | null;
    }[];
  };
  // Upcoming cleared after due processing
  expect(idxAfter.upcoming.length).toBe(0);

  // Re-open tab and assert current brief rendering, evidence warnings, delivery state
  await page.goto("/meetings/brief");
  const currentBriefs = page.getByLabel("Current briefs");
  await expect(
    currentBriefs.getByRole("heading", { name: "Initial Meeting", exact: true }),
  ).toBeVisible();
  // Current brief section shows the Brief journey rendering and delivery sent
  await expect(currentBriefs.getByText("Brief for Initial Meeting", { exact: true })).toBeVisible();
  // Source links (at least one)
  const sourceLink = currentBriefs.getByRole("link", { name: /https:\/\/example.com\/alice/ });
  await expect(sourceLink.first()).toBeVisible();
  // Missing-evidence warnings
  await expect(currentBriefs.getByText(/Missing evidence/)).toBeVisible();
  await expect(currentBriefs.getByText(/Drive Docs for Acme/)).toBeVisible();
  // Delivery state pending/sent/superseded/failed with Gmail identity
  await expect(currentBriefs.getByText(/Delivery:/)).toBeVisible();
  await expect(currentBriefs.getByText("Sent", { exact: true })).toBeVisible();
  await expect(currentBriefs.getByText(/owner@example.com/)).toBeVisible();
  // Check fake gmail messages — owner-only send state, never External Guest
  const gmail1 = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: { to: string; subject: string; deliveryId: string }[] };
  expect(gmail1.messages.length).toBe(1);
  expect(gmail1.messages[0].to).toBe("owner@example.com");
  expect(gmail1.messages[0].subject).toBe("Meeting Brief: Initial Meeting");
  expect(gmail1.messages[0].deliveryId).toContain("v1");

  // #164: the success path stays on the owning Brief journey surface — a
  // delivered Brief links nowhere near /runs/ (Technical details is the
  // failure path's link only).
  await expect(currentBriefs.locator('a[href^="/runs/"]')).toHaveCount(0);

  // 4. Change event to new material version — then one more rapid revision to test coalescing
  // First revision v2 (material: title changed) scheduled at same due time (already past) → will go to quiet wait
  const v2 = fixtureEvent({ version: "v2", summary: "Revised title" });
  const sched2 = await request.post("/api/test/meeting-brief/schedule", {
    data: { event: v2 },
  });
  expect(sched2.ok()).toBe(true);
  const proc2 = await request.post("/api/test/meeting-brief/process-due", { data: {} });
  expect(proc2.ok()).toBe(true);

  // Poll for blocked revision (delivery pending) — quiet period 5 min
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { eventVersion: string; delivery: { status: string } | null; status: string }[];
        };
        // Check runs directly via /api/runs? For quiet period we check index brief pending or runs blocked
        // Brief for v2 will be pending until quiet expires, not yet sent
        const v2Entry = data.briefs.find((b) => b.eventVersion === "v2");
        if (v2Entry?.delivery?.status === "pending") return "pending";
        // Also check if run is blocked via runs list
        const runsRes = await request.get("/api/runs?module=meeting-brief-generator");
        const runsData = (await runsRes.json()) as { runs: { id: string; status: string }[] };
        // find blocked
        const hasBlocked = runsData.runs.some((r) => r.status === "blocked");
        return hasBlocked ? "pending" : "none";
      },
      { timeout: 10_000 },
    )
    .toBe("pending");

  // While still in quiet period, push another material change v3 quickly (within 2 min)
  await request.post("/api/test/meeting-brief/advance", { data: { ms: 2 * 60 * 1000 } });
  const v3 = fixtureEvent({ version: "v3", summary: "Final revised title" });
  const sched3 = await request.post("/api/test/meeting-brief/schedule", {
    data: { event: v3 },
  });
  expect(sched3.ok()).toBe(true);
  const proc3 = await request.post("/api/test/meeting-brief/process-due", { data: {} });
  expect(proc3.ok()).toBe(true);

  // Verify gmail still only 1 message (quiet period coalescing — older revision not sent)
  const gmailMid = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: unknown[] };
  expect(gmailMid.messages.length).toBe(1);

  // Advance clock through quiet period (5 min after v3)
  await request.post("/api/test/meeting-brief/advance", { data: { ms: 5 * 60 * 1000 + 1000 } });

  // Assert one coalesced Updated Meeting Brief and obsolete superseded explain
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { eventVersion: string; delivery: { status: string } | null }[];
        };
        const v3Brief = data.briefs.find((b) => b.eventVersion === "v3");
        return v3Brief?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

  const idx2 = (await (await request.get("/api/meeting-brief/index")).json()) as {
    briefs: {
      eventVersion: string;
      delivery: { status: string } | null;
      supersedes: string | null;
    }[];
  };
  const v2Entry = idx2.briefs.find((b) => b.eventVersion === "v2");
  const v3Entry = idx2.briefs.find((b) => b.eventVersion === "v3");
  expect(v2Entry?.delivery?.status).toBe("superseded");
  expect(v3Entry?.delivery?.status).toBe("sent");
  expect(v3Entry?.supersedes).toBeTruthy();

  // Gmail now has one coalesced update (total 2 messages: v1 + v3 updated)
  const gmailFinal = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: { subject: string; deliveryId: string }[] };
  expect(gmailFinal.messages.length).toBe(2);
  expect(gmailFinal.messages[1].subject).toContain("Updated Meeting Brief");
  expect(gmailFinal.messages[1].deliveryId).toContain("v3");

  // Tab shows updated revision as current, and superseded explain
  await page.goto("/meetings/brief");
  await expect(
    currentBriefs.getByRole("heading", { name: "Final revised title", exact: true }),
  ).toBeVisible();
  await expect(currentBriefs.getByText(/Updated Meeting Brief/)).not.toBeVisible(); // subject is email, not tab — tab shows Brief for ...
  await expect(
    currentBriefs.getByText("Brief for Final revised title", { exact: true }),
  ).toBeVisible();
  // Superseded entry explains obsolete
  const revisionHistory = page.getByLabel("Revision history");
  await expect(revisionHistory.getByText("Superseded", { exact: true }).first()).toBeVisible();
  await expect(revisionHistory.getByText(/only the latest revision sends/)).toBeVisible();

  // Revision history shows chain
  await expect(page.getByRole("heading", { name: "Revision history" })).toBeVisible();
  await expect(revisionHistory.getByText(/version v3/)).toBeVisible();
  await expect(revisionHistory.getByText(/version v2/)).toBeVisible();

  // Ensure tab and Runs surfaces are accessible (keyboard, status without color etc covered by existing a11y)
  // Verify source link names are accessible
  await expect(
    page.getByRole("link", { name: /https:\/\/example.com\/acme/ }).first(),
  ).toBeVisible();
});

test("meeting brief hermetic journey — incomplete provider blocks until cutoff, policy disable, explicit retry delivers", async ({
  page,
  request,
}) => {
  const CUTOFF_AT = "2026-08-28T14:30:00.000Z";

  // 1. Make the hermetic enrich fixture report a failed selected provider.
  await request.post("/api/test/meeting-brief/fixture-outcomes", {
    data: {
      outcomes: [
        {
          provider: "crm",
          attendee: "alice@external.co",
          outcome: "failed",
          artifact: null,
          diagnostics: { httpStatus: 503, errorCode: null, reason: "Hermetic CRM outage" },
        },
      ],
    },
  });
  await request.post("/api/test/meeting-brief/set-now", { data: { now: NOW_BEFORE_DUE } });
  await request.post("/api/test/meeting-brief/fake-gmail/clear");

  // 2. Schedule the occurrence and run it: the gate must block, not compose.
  const v1 = fixtureEvent({
    eventId: "evt_journey_cutoff",
    version: "v1",
    summary: "Cutoff Meeting",
  });
  await request.post("/api/test/meeting-brief/schedule", { data: { event: v1, dueAt: DUE_AT } });
  const advance1 = await request.post("/api/test/meeting-brief/advance", { data: { now: DUE_AT } });
  expect(advance1.ok()).toBe(true);
  const { created } = (await advance1.json()) as { created: string[] };
  const runId = created[0];
  const runMeta = (await (await request.get(`/api/runs/${runId}`)).json()) as {
    status: string;
  };
  expect(runMeta.status).toBe("blocked");

  // 3. Advance to the cutoff: the Run fails visibly and nothing was sent.
  const advance2 = await request.post("/api/test/meeting-brief/advance", {
    data: { now: CUTOFF_AT },
  });
  expect(advance2.ok()).toBe(true);
  const failedStatus = (await (await request.get(`/api/runs/${runId}`)).json()) as {
    status: string;
    failureHint: string | null;
  };
  expect(failedStatus.status).toBe("failed");
  expect(failedStatus.failureHint).toContain("cutoff");

  const gmailAtCutoff = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: unknown[] };
  expect(gmailAtCutoff.messages).toHaveLength(0);

  // 4. The Brief tab shows the failed Run with its provider outcomes.
  await page.goto("/meetings/brief");
  const currentBriefs = page.getByLabel("Current briefs");
  /* Without a composed Brief the entry takes its name from the Meeting rather
     than from the Calendar event id, and reports its outcome in display
     vocabulary. The per-provider outcomes are diagnostics, so they sit behind
     a disclosure instead of a semicolon-joined paragraph. */
  await expect(currentBriefs.getByText("evt_journey_cutoff", { exact: true })).toHaveCount(0);
  await expect(currentBriefs.getByText(/Failed/)).toBeVisible();
  await currentBriefs
    .getByRole("group")
    .filter({ hasText: /sources? consulted/ })
    .first()
    .click();
  await expect(currentBriefs.getByText("crm · alice@external.co — failed")).toBeVisible();
  await expect(currentBriefs.getByText(/No brief — preparation failed/)).toBeVisible();

  // 5. Technical details links the failed preparation to its Run detail,
  // which shows the cutoff failure and no composed Brief.
  await currentBriefs.getByRole("link", { name: "Technical details" }).click();
  await expect(page).toHaveURL(/\/runs\/.+/);
  await expect(page.getByText(/cutoff/i).first()).toBeVisible();

  // 6. Explicit policy action: disable the failing provider on the Run.
  const policyRes = await request.post(`/api/meeting-brief/runs/${runId}/provider-policy`, {
    data: { provider: "crm", action: "disable", reason: "hermetic outage accepted" },
  });
  expect(policyRes.ok()).toBe(true);

  // 7. The person's explicit retry is what delivers the complete Brief.
  const retryRes = await request.post(`/api/runs/${runId}/retry`, { data: {} });
  expect(retryRes.ok()).toBe(true);

  await expect
    .poll(
      async () => {
        const idx = (await (await request.get("/api/meeting-brief/index")).json()) as {
          briefs: { eventVersion: string; delivery: { status: string } | null }[];
        };
        const entry = idx.briefs.find((b) => b.eventVersion === "v1");
        return entry?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

  const gmailFinal = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: { to: string }[] };
  expect(gmailFinal.messages).toHaveLength(1);
  expect(gmailFinal.messages[0].to).toBe("owner@example.com");

  // 8. The tab now shows the delivered Brief as current.
  await page.goto("/meetings/brief");
  const delivered = page.getByLabel("Current briefs");
  await expect(delivered.getByText("Brief for Cutoff Meeting", { exact: true })).toBeVisible();
  /* The card is addressed by the meeting it prepared, not by the Calendar
     event id — that is a diagnostic and lives on the Run detail page. */
  await expect(
    delivered
      .locator("li.card")
      .filter({ hasText: "Brief for Cutoff Meeting" })
      .getByText("Sent", { exact: true }),
  ).toBeVisible();

  // Reset the knob for later tests.
  await request.post("/api/test/meeting-brief/fixture-outcomes", { data: { outcomes: null } });
});
