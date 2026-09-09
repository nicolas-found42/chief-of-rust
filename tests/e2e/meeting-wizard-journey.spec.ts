import { expect, test } from "./fixture";

/**
 * Meeting Wizard journey (issues #136, #151): the home reads the Meeting store
 * and lists today's Meetings in start order, each linking to its own page; a
 * day with no meetings says so; the Brief journey keeps Prepare now; the
 * legacy product route and adapter surface answer not-found.
 */

/** Today's local date at a fixed hour, so the fixtures land on the home's day. */
function atTodayLocal(hour: number): string {
  const at = new Date();
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

const NOW_BEFORE_DUE = atTodayLocal(9);

function fixtureEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startAt = (overrides.startAt as string | undefined) ?? atTodayLocal(11);
  return {
    calendarId: "primary",
    eventId: "evt_wizard_1",
    occurrenceId: startAt,
    version: "v1",
    summary: "Internal planning",
    description: "Q4 planning",
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
    location: "Room A",
    conferenceLink: "https://meet.example.com/abc",
    organizer: { email: "owner@example.com", displayName: "Owner" },
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "bob@internal.example.com", displayName: "Bob", responseStatus: "accepted" },
    ],
    attachments: [],
    ...overrides,
  };
}

test("meeting wizard home — a day with no meetings says so", async ({ page }) => {
  // Fresh hermetic workspace: no Meeting recorded carries today's date.
  await page.goto("/meetings");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("No meetings today.")).toBeVisible();
});

test("meeting history — collected back to the oldest Transcript, the home says where it begins", async ({
  page,
  request,
}) => {
  // A month-old meeting, and a Transcript whose meetingDate is a day older —
  // the bound the one backward read reaches back to (issue #152).
  const historyDay = new Date();
  historyDay.setHours(15, 0, 0, 0);
  historyDay.setDate(historyDay.getDate() - 30);
  const startAt = historyDay.toISOString();
  const boundDay = new Date(historyDay.getTime() - 24 * 60 * 60 * 1000);
  const transcript = {
    id: "drive_history_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "history",
      fileName: "Old planning notes",
      sourceUrl: null,
      checksum: "history-checksum",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: new Date().toISOString(),
    extractorVersion: 1,
    normalizedText: "Old planning transcript text.",
    meetingDate: boundDay.toISOString(),
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
  };
  expect(
    (
      await request.post("/api/test/meeting-brief/seed-transcript", {
        data: { record: transcript },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.post("/api/test/meeting-brief/calendar-event", {
        data: {
          event: {
            calendarId: "primary",
            eventId: "evt_history_1",
            occurrenceId: startAt,
            version: "v1",
            summary: "Old planning",
            startAt,
            endAt: new Date(historyDay.getTime() + 60 * 60 * 1000).toISOString(),
            attendees: [
              { email: "owner@example.com", responseStatus: "accepted", self: true },
              { email: "alice@external.co", responseStatus: "accepted" },
            ],
          },
        },
      })
    ).ok(),
  ).toBe(true);

  // The reconcile pass runs the one backward read beside the forward one.
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);

  const store = (await (await request.get("/api/meetings/list")).json()) as {
    meetings: { id: string; title: string; startAt: string }[];
    historyBeginsAt: string | null;
  };
  const oldMeeting = store.meetings.find((meeting) => meeting.title === "Old planning");
  if (!oldMeeting) throw new Error("the history read did not record the old Meeting");
  // #154 orphan dating: the unmatched Transcript (title-alone-never-links per
  // #153) owns a Meeting dated at its meetingDate (boundDay), which predates
  // the Calendar meeting, so history begins there.
  expect(store.historyBeginsAt).toBe(boundDay.toISOString());

  // The home states where history begins; the old Meeting is not today's.
  await page.goto("/meetings");
  await expect(page.getByText(/Meeting history begins/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Old planning" })).toHaveCount(0);
});

test("meeting wizard journey — home lists today's Meetings from the store, Brief journey, legacy surface gone", async ({
  page,
  request,
}) => {
  // Setup: Internal Domains + a clean fake Gmail mailbox.
  await request.post("/api/test/meeting-brief/set-now", { data: { now: NOW_BEFORE_DUE } });
  const cfgRes = await request.put("/api/meeting-brief/config", {
    data: { internalDomains: ["internal.example.com"] },
  });
  expect(cfgRes.ok()).toBe(true);
  await request.post("/api/test/meeting-brief/fake-gmail/clear");

  // Two meetings today at different hours, both Eligible.
  const internalEvent = fixtureEvent({
    summary: "Internal planning",
    startAt: atTodayLocal(11),
  });
  const externalEvent = fixtureEvent({
    eventId: "evt_wizard_2",
    summary: "External kickoff",
    startAt: atTodayLocal(15),
    attendees: [
      { email: "owner@example.com", responseStatus: "accepted", organizer: true },
      { email: "alice@external.co", displayName: "Alice", responseStatus: "accepted" },
    ],
  });
  for (const event of [internalEvent, externalEvent]) {
    expect((await request.post("/api/test/meeting-brief/schedule", { data: { event } })).ok()).toBe(
      true,
    );
  }
  // The intake pass records each occurrence as a Meeting (ADR-0050).
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);

  const meetingsRes = await request.get("/api/meetings/list");
  expect(meetingsRes.ok()).toBe(true);
  const store = (await meetingsRes.json()) as { meetings: { id: string; title: string }[] };
  const internal = store.meetings.find((m) => m.title === "Internal planning");
  const external = store.meetings.find((m) => m.title === "External kickoff");
  if (!internal || !external) throw new Error("Meeting store did not record both meetings");

  // The home lists both in start order and links each to its page; the
  // brief-record projection it replaced is gone.
  await page.goto("/meetings");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Upcoming eligible meetings" })).toHaveCount(0);
  /* One section for the day, not two: the Daily briefing is today's meetings
     plus their Brief state, so the separate list it duplicated is gone. */
  const todaySection = page.locator('section[aria-labelledby="wizard-today-heading"]');
  const cards = todaySection.locator("li.wizard-line");
  await expect(cards.filter({ hasText: "Internal planning" })).toHaveCount(1);

  await expect(
    cards.filter({ hasText: "Internal planning" }).getByRole("link", { name: "Internal planning" }),
  ).toHaveAttribute("href", `/meetings/${internal.id}`);
  await expect(
    cards.filter({ hasText: "External kickoff" }).getByRole("link", { name: "External kickoff" }),
  ).toHaveAttribute("href", `/meetings/${external.id}`);

  // Following a home link reaches that Meeting's page.
  await cards
    .filter({ hasText: "Internal planning" })
    .getByRole("link", { name: "Internal planning" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Internal planning" })).toBeVisible();

  // Prepare now lives on the Brief journey; the internal meeting delivers.
  await page.goto("/meetings/brief");
  const internalCard = page.locator("li.card").filter({ hasText: "Internal planning" }).first();
  await internalCard.getByRole("button", { name: "Prepare now" }).click();
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/meeting-brief/index");
        const data = (await res.json()) as {
          briefs: { occurrenceKey: string; delivery: { status: string } | null }[];
        };
        const brief = data.briefs.find((b) => b.occurrenceKey.startsWith("evt_wizard_1"));
        return brief?.delivery?.status ?? "none";
      },
      { timeout: 15_000 },
    )
    .toBe("sent");

  // Owner-only delivery: no external attendee ever receives a Brief.
  const gmail = (await (
    await request.get("/api/test/meeting-brief/fake-gmail/messages")
  ).json()) as { messages: { to: string; subject: string }[] };
  expect(gmail.messages).toHaveLength(1);
  expect(gmail.messages[0].to).toBe("owner@example.com");

  // The external meeting still waits for its scheduled preparation time.
  const idxAfter = (await (await request.get("/api/meeting-brief/index")).json()) as {
    upcoming: { occurrenceKey: string }[];
  };
  expect(idxAfter.upcoming.some((u) => u.occurrenceKey.startsWith("evt_wizard_2"))).toBe(true);

  // The legacy product route answers not-found; the legacy adapter API is gone.
  await page.goto("/meeting-brief");
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  const legacyStatus = await request.get("/api/meeting-brief/guest-profile/status");
  expect(legacyStatus.status()).toBe(404);
});

test("meeting page — shows the Transcript matched to its Meeting (issue #153)", async ({
  page,
  request,
}) => {
  const summary = "Transcript link sync";
  const startAt = atTodayLocal(14);
  const event = fixtureEvent({
    eventId: "evt_link_1",
    occurrenceId: startAt,
    summary,
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60 * 1000).toISOString(),
  });
  expect((await request.post("/api/test/meeting-brief/schedule", { data: { event } })).ok()).toBe(
    true,
  );
  const fileName = `${summary} notes.txt`;
  expect(
    (
      await request.post("/api/test/meeting-brief/seed-transcript", {
        data: {
          record: {
            id: "drive_link_r1",
            source: {
              sourceSystem: "drive",
              externalFileId: "link",
              fileName,
              sourceUrl: null,
              checksum: "link-checksum",
              observedRevision: 1,
              modifiedAt: null,
            },
            ingestedAt: new Date().toISOString(),
            extractorVersion: 1,
            normalizedText: "Bob agreed to own the follow-up.",
            meetingDate: startAt.slice(0, 10),
            occurrence: null,
            speakers: ["Bob"],
            speakerIdentityMappings: [],
            roster: [],
            meetingId: null,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);

  const store = (await (await request.get("/api/meetings/list")).json()) as {
    meetings: { id: string; title: string }[];
  };
  const linked = store.meetings.find((m) => m.title === summary);
  if (!linked) throw new Error("the linked Meeting was not recorded");
  const transcriptsRes = await request.get(`/api/meetings/${linked.id}/transcripts`);
  expect(transcriptsRes.ok()).toBe(true);
  const body = (await transcriptsRes.json()) as { transcripts: { id: string; title: string }[] };
  expect(body.transcripts.some((t) => t.id === "drive_link_r1")).toBe(true);

  await page.goto(`/meetings/${linked.id}`);
  await expect(page.getByRole("heading", { level: 1, name: summary })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcripts" })).toBeVisible();
  await expect(page.getByRole("heading", { name: fileName })).toBeVisible();
});

test("meeting wizard tabs — Today and This week are routes, and survive refresh and Back", async ({
  page,
  request,
}) => {
  // One Meeting today, so both tabs have something to be about.
  const startAt = atTodayLocal(11);
  const event = fixtureEvent({ eventId: "evt_tabs_1", occurrenceId: startAt, startAt });
  expect((await request.post("/api/test/meeting-brief/schedule", { data: { event } })).ok()).toBe(
    true,
  );
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);
  // One overdue Task, which This week owns its own deterministic section for.
  expect(
    (
      await request.post("/api/tasks", {
        data: { title: "Overdue weekly work", dueDate: "2020-01-01" },
      })
    ).ok(),
  ).toBe(true);

  await page.goto("/meetings");
  const tabs = page.getByRole("navigation", { name: "Meeting Wizard views" });
  await expect(tabs.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("link", { name: "This week" }).click();
  await expect(page).toHaveURL(/\/meetings\/weekly$/);
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Meeting Wizard views" }).getByRole("link", {
      name: "This week",
    }),
  ).toHaveAttribute("aria-current", "page");

  // The deterministic sections stand on their own, whatever the Summary did.
  await expect(page.locator('section[aria-labelledby="weekly-overdue-heading"]')).toContainText(
    "Overdue weekly work",
  );
  await expect(page.locator('section[aria-labelledby="weekly-upcoming-heading"]')).toBeVisible();

  // Keep the page open while canonical work changes in another client.
  const added = await (
    await request.post("/api/tasks", {
      data: { title: "Live weekly update", dueDate: "2020-01-01" },
    })
  ).json();
  await expect(page.getByRole("link", { name: "Live weekly update", exact: true })).toBeVisible({
    timeout: 10000,
  });
  expect((await request.post(`/api/tasks/${added.id}/complete`)).ok()).toBe(true);
  await expect(page.getByRole("link", { name: "Live weekly update", exact: true })).toHaveCount(0, {
    timeout: 10000,
  });

  // Refresh-safe: the tab is the URL, not component state.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "This week" })).toBeVisible();

  // And Back returns to Today rather than to whatever came before the app.
  await page.goBack();
  await expect(page).toHaveURL(/\/meetings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Wizard" })).toBeVisible();
});

test("meeting wizard Today — the Day Spine metric strip, and the restraint around it", async ({
  page,
  request,
}) => {
  // One Meeting today, one overdue Task, one pending proposal: enough for the
  // strip to have five real figures rather than five zeroes.
  const startAt = atTodayLocal(10);
  const event = fixtureEvent({ eventId: "evt_spine_1", occurrenceId: startAt, startAt });
  expect((await request.post("/api/test/meeting-brief/schedule", { data: { event } })).ok()).toBe(
    true,
  );
  expect((await request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);

  await page.goto("/meetings");

  // The day's shape in five figures, in the order the day is read, each one a
  // link to the surface that owns it (issue #193).
  const strip = page.locator("ul.work-metrics");
  await expect(strip).toBeVisible();
  await expect(strip.locator("li.work-metric")).toHaveCount(5);
  await expect(strip.locator(".work-metric-label")).toHaveText([
    "Today",
    "This week",
    "Pending",
    "Open",
    "Overdue",
  ]);
  for (const [label, href] of [
    ["Today", "/meetings"],
    ["This week", "/meetings/weekly"],
    ["Pending", "/tasks#action-items"],
    ["Open", "/tasks"],
    ["Overdue", "/tasks"],
  ] as const) {
    await expect(
      strip.locator("li.work-metric").filter({ hasText: label }).getByRole("link"),
    ).toHaveAttribute("href", href);
  }
  // The figures are real, not decoration: one more overdue Task moves the
  // Overdue figure by exactly one. Asserted as a delta because the hermetic
  // server is shared across specs, so no absolute count is this test's to own.
  const overdue = strip
    .locator("li.work-metric")
    .filter({ hasText: "Overdue" })
    .locator(".work-metric-value");
  const before = Number(await overdue.textContent());
  expect(Number.isInteger(before)).toBe(true);
  expect(
    (
      await request.post("/api/tasks", {
        data: { title: "Overdue spine work", dueDate: "2020-01-01" },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(overdue).toHaveText(String(before + 1));

  // Canonical Tasks and pending Action Items stay two headed groups, never one
  // merged queue.
  await expect(page.getByRole("heading", { name: /^Tasks \(/ })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Action Items awaiting review \(/ }),
  ).toBeVisible();

  // Quiet Rail restraint: no prototype-only switch and no admin Run concepts
  // reach the production Meeting Wizard surface.
  await expect(page.getByRole("radiogroup", { name: /prototype/i })).toHaveCount(0);
  await expect(page.getByText(/prototype/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Runs$/ })).toHaveCount(0);
});
