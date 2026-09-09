import AxeBuilder from "@axe-core/playwright";
import type { PersonResearchStatus } from "@chief-of-staff-demo/shared";
import { expect, test } from "./fixture";

test("automatic dossier journey — add, research, inspect source, and query demonstrated work", async ({
  page,
}) => {
  const quote = "Maya designed the scheduler and deployed Atlas to 200 sites.";
  const extraction = {
    fullName: "Maya Chen",
    employer: null,
    author: null,
    publishedAt: "2024-02-01",
    sourceClass: "primary-artifact",
    claims: [
      {
        id: "work",
        section: "work",
        statement: quote,
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: "2024-02-01",
        effectiveTo: null,
        citations: [{ sourceId: "source", quote }],
        supports: [],
        supersedes: [],
        changeReason: null,
      },
    ],
    works: [
      {
        id: "atlas",
        title: "Atlas",
        url: "https://example.com/atlas",
        kind: "system",
        startedAt: "2024-02-01",
        endedAt: null,
        claimIds: ["work"],
        contribution: {
          text: "Designed the scheduler and deployed the system",
          claimIds: ["work"],
        },
        teamContribution: null,
        authority: [{ role: "executed", claimIds: ["work"] }],
        scale: [
          {
            value: 200,
            unit: "sites",
            scope: "Atlas deployment",
            date: "2024-02-01",
            claimIds: ["work"],
          },
        ],
        constraints: [],
        outcomes: [],
      },
    ],
    expertise: [
      {
        category: "deployment",
        originalWording: "deployed Atlas to 200 sites",
        support: "demonstrated",
        workIds: ["atlas"],
        claimIds: ["work"],
      },
    ],
    connections: [],
    sections: [],
  };
  await page.request.post("/api/test/person-dossier-source", {
    data: {
      url: "https://example.com/maya",
      text: `Maya Chen — maya@example.com. ${quote}`,
      extraction,
    },
  });
  await page.request.patch("/api/people/research/settings", {
    data: { paused: false, profileCalls: 4 },
  });
  await page.goto("/people/new");
  await page.getByLabel("Email or profile URL").fill("maya@example.com");
  await page.getByRole("button", { name: "Add and research" }).click();
  await expect(page).toHaveURL(/\/people\/person_/);
  await page.getByRole("tab", { name: "Body of work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Atlas", exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("200 sites", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Evidence 1", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Retained source" })).toContainText(quote);
  await page.getByRole("button", { name: "Close source" }).click();
  await page.getByLabel("Dossier revision").selectOption("1");
  await expect(
    page.getByText("Reading historical dossier revision 1.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  const retained = page.getByRole("button", { name: "Inspect retained source 1", exact: true });
  await retained.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Retained source" })).toContainText(quote);
  await page.getByRole("button", { name: "Close source" }).click();
  await page.getByLabel("Dossier revision").selectOption("current");

  await page.getByRole("tab", { name: "Relationship history", exact: true }).click();
  await expect(page.getByText(/No confirmed Workspace history yet/)).toBeVisible();
  const scan = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(scan.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto("/people");
  await page.getByText("Find expertise and work across Profiles", { exact: true }).click();
  await page.getByLabel("Capabilities required together").fill("deployment");
  await page.getByRole("button", { name: "Search dossiers", exact: true }).click();
  await expect(page.getByText(/1 demonstrated matches/)).toBeVisible();
  await expect(page.getByRole("blockquote").first()).toContainText(quote);
});

test("sparse and unavailable dossiers keep unquoted sources accessible with queue progress", async ({
  page,
}) => {
  await page.request.patch("/api/people/research/settings", {
    data: { paused: true, profileCalls: 12 },
  });
  const created = await (
    await page.request.post("/api/people", { data: { primaryEmail: "retained-only@example.com" } })
  ).json();
  await page.goto(`/people/${created.id}`);
  await page.getByText("Research settings", { exact: true }).click();
  await expect(page.getByText(/Backfill:/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume research", exact: true })).toBeVisible();
  await page.request.post("/api/test/person-dossier-source", {
    data: {
      url: "https://example.com/retained-only",
      text: "retained-only@example.com has a source whose model extraction is unavailable.",
      extraction: {},
    },
  });
  await page.request.patch("/api/people/research/settings", { data: { paused: false } });
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Inspect retained source 1", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Inspect retained source 1", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Retained source" })).toContainText(
    "model extraction is unavailable",
  );
  await expect(page.getByRole("region", { name: "Retained source" })).toContainText("unattempted");
  await page.getByRole("button", { name: "Close source" }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("Calendar and repeated Transcript entry reach automatically populated dossier sources", async ({
  page,
}) => {
  const emails = ["calendar@browser-entry.example", "transcript@browser-entry.example"];
  for (const email of emails)
    await page.request.post("/api/test/person-dossier-source", {
      data: {
        url: `https://browser-entry.example/${email.split("@")[0]}`,
        text: `${email} built a documented scheduler.`,
        extraction: {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        },
      },
    });
  await page.request.patch("/api/people/research/settings", {
    data: { paused: false, profileCalls: 4, concurrency: 2 },
  });
  const event = {
    calendarId: "primary",
    eventId: "dossier-entry",
    occurrenceId: "2026-08-28T15:00:00Z",
    version: "v1",
    summary: "Dossier entry meeting",
    description: "Review",
    startAt: "2026-08-28T15:00:00Z",
    endAt: "2026-08-28T15:30:00Z",
    location: "",
    conferenceLink: null,
    organizer: { email: "owner@example.com" },
    attendees: [
      { email: "owner@example.com", organizer: true, responseStatus: "accepted" },
      { email: emails[0], responseStatus: "accepted" },
    ],
    attachments: [],
  };
  expect(
    (
      await page.request.post("/api/test/meeting-brief/schedule", {
        data: { event, dueAt: "2026-08-28T11:00:00Z" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post("/api/test/meeting-brief/advance", {
        data: { now: "2026-08-28T11:00:00Z" },
      })
    ).ok(),
  ).toBe(true);
  const transcript = {
    id: "drive_dossier_browser_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "dossier-browser",
      fileName: "Dossier entry conversation.md",
      sourceUrl: null,
      checksum: "dossier-browser",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-28T12:00:00Z",
    extractorVersion: 1,
    normalizedText: `Email ${emails[1]} before the review.`,
    meetingDate: "2026-08-28",
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
  };
  expect(
    (await page.request.post("/api/test/meeting-debrief/seed", { data: { transcript } })).ok(),
  ).toBe(true);
  for (let index = 0; index < 2; index++)
    expect((await page.request.post("/api/meeting-brief/reconcile")).ok()).toBe(true);
  for (const email of emails) {
    let id = "";
    await expect
      .poll(
        async () => {
          const response = (await (
            await page.request.get(`/api/people?query=${encodeURIComponent(email)}`)
          ).json()) as Array<{ id: string; primaryEmail: string }>;
          const matches = response.filter(
            (profile: { primaryEmail: string }) => profile.primaryEmail === email,
          );
          id = matches[0]?.id ?? "";
          return matches.length;
        },
        { timeout: 10000 },
      )
      .toBe(1);
    await page.goto(`/people/${id}`);
    await page.getByRole("tab", { name: "Sources", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Inspect retained source 1", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Inspect retained source 1", exact: true }).click();
    await expect(page.getByRole("region", { name: "Retained source" })).toContainText(email);
  }
});

test("completed research explains gaps and provider interruption keeps retained sources visible", async ({
  page,
}) => {
  for (const interrupted of [false, true]) {
    const email = interrupted ? "interrupted@scope-browser.example" : "gaps@scope-browser.example";
    const url = `https://scope-browser.example/${interrupted ? "interrupted" : "gaps"}`;
    await page.request.post("/api/test/person-dossier-source", {
      data: {
        url,
        text: `${email} appears in this sparse public record.`,
        extraction: {
          fullName: null,
          employer: null,
          author: null,
          publishedAt: null,
          sourceClass: "primary-artifact",
          claims: [],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        },
        ...(interrupted ? { extractionError: "Fixture provider connection interrupted" } : {}),
      },
    });
    await page.request.patch("/api/people/research/settings", {
      data: { paused: false, profileCalls: 60 },
    });
    await page.goto("/people/new");
    await page.getByLabel("Email or profile URL").fill(email);
    await page.getByRole("button", { name: "Add and research" }).click();
    await expect(page).toHaveURL(/\/people\/person_/);
    await expect(
      page.getByText(interrupted ? "Research interrupted" : "No matched evidence found", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByText("What this research did not find", { exact: true }).click();
    await expect(
      page
        .locator("details")
        .filter({ has: page.getByText("What this research did not find", { exact: true }) }),
    ).toContainText(/evidence|uninvestigated|coverage/i);
    if (interrupted) {
      await page.getByText("Source and identity diagnostics", { exact: true }).click();
      await expect(page.getByText("model-boundary-failed", { exact: true })).toBeVisible();
    }
    await page.getByRole("tab", { name: "Sources", exact: true }).click();
    await page.getByRole("button", { name: "Inspect retained source 1", exact: true }).click();
    await expect(page.getByRole("region", { name: "Retained source" })).toContainText(email);
  }
});

test("published claims remain readable while the same operation awaits another extraction", async ({
  page,
}) => {
  const email = "progressive@continuous-browser.example";
  const heldUrl = "https://continuous-browser.example/second";
  const firstQuote = "Morgan built the Atlas scheduler.";
  const secondQuote = "Morgan deployed Atlas to coastal stations.";
  for (const [url, quote, held] of [
    ["https://continuous-browser.example/first", firstQuote, false],
    [heldUrl, secondQuote, true],
  ] as const) {
    await page.request.post("/api/test/person-dossier-source", {
      data: {
        url,
        text: `${email}. ${quote}`,
        holdExtraction: held,
        extraction: {
          fullName: null,
          employer: null,
          author: null,
          publishedAt: null,
          sourceClass: "primary-artifact",
          claims: [
            {
              id: held ? "deployment" : "scheduler",
              section: "work",
              statement: quote,
              status: "supported",
              nature: "statement",
              matchConfidence: "high",
              effectiveFrom: null,
              effectiveTo: null,
              citations: [{ sourceId: "source", quote }],
              supports: [],
              supersedes: [],
              changeReason: null,
            },
          ],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        },
      },
    });
  }
  try {
    await page.request.patch("/api/people/research/settings", {
      data: { paused: false, profileCalls: 60, readConcurrency: 2 },
    });
    await page.goto("/people/new");
    await page.getByLabel("Email or profile URL").fill(email);
    await page.getByRole("button", { name: "Add and research" }).click();
    await expect(page).toHaveURL(/\/people\/person_/);
    const profileId = new URL(page.url()).pathname.split("/").at(-1)!;
    const job = async () => {
      const status = (await (
        await page.request.get("/api/people/research/status")
      ).json()) as PersonResearchStatus;
      return status.jobs.find((entry) => entry.profileId === profileId);
    };
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/test/person-dossier-extraction?url=${encodeURIComponent(heldUrl)}`,
        );
        return ((await response.json()) as { started: boolean }).started;
      })
      .toBe(true);
    await page.getByRole("tab", { name: "Body of work", exact: true }).click();
    await expect(page.getByRole("article").getByText(firstQuote, { exact: true })).toBeVisible();
    await expect(page.getByText("Researching", { exact: true })).toBeVisible();
    await expect(page.getByText(secondQuote, { exact: true })).toHaveCount(0);
    const active = await job();
    expect(active?.state).toBe("researching");
    const operationId = active?.checkpoint?.operationId;
    expect(operationId).toBeTruthy();
    await page.getByRole("button", { name: "Evidence 1", exact: true }).first().click();
    await expect(page.getByRole("region", { name: "Retained source" })).toContainText(firstQuote);
    await page.getByRole("button", { name: "Close source" }).click();
    await page.request.post("/api/test/person-dossier-extraction/release", {
      data: { url: heldUrl },
    });
    await expect(page.getByRole("article").getByText(secondQuote, { exact: true })).toBeVisible();
    await expect(page.getByText("Current within completed scope", { exact: true })).toBeVisible();
    expect((await job())?.operation).toMatchObject({ operationId, conclusion: "completed" });
  } finally {
    await page.request.post("/api/test/person-dossier-extraction/release", {
      data: { url: heldUrl },
    });
  }
});
