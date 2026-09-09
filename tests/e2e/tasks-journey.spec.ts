import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The Tasks browser journey (issues #173, #174, #177): capture a Task with a
 * title alone, complete and reopen it, edit its full details, organize Task
 * Lists, and read the pending Action Items a Meeting Debrief proposed without
 * any of them looking like accepted work.
 *
 * Nothing here is connected to a provider. The hermetic Workspace has no
 * Google account, which is the point: the whole area has to work anyway.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("tasks journey — nav → quick add → complete → reopen → edit → lists", async ({ page }) => {
  // 1. Tasks is a top-level product area reachable from explicit navigation.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeFocused();
  await expect(page.getByText("No open Tasks. Quick Add above captures one.")).toBeVisible();

  // 2. Quick Add takes a title and nothing else — reached from the keyboard,
  //    submitted from the keyboard, and it hands focus back for the next one.
  await page.getByLabel("Task title").click();
  await page.keyboard.type("Send the billing follow-up");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 3, name: "Send the billing follow-up" }),
  ).toBeVisible();
  await expect(page.getByLabel("Task title")).toBeFocused();
  await expect(page.getByLabel("Task title")).toHaveValue("");
  // The defaults the Workspace filed it under, stated on the row itself.
  await expect(page.getByText("Inbox · no due date · no priority · You")).toBeVisible();

  // 3. Completing moves it out of open work; reopening brings it back.
  await page.getByRole("button", { name: "Complete" }).click();
  await expect(page.getByText("Nothing completed yet.")).toHaveCount(0);
  await expect(page.getByText("No open Tasks. Quick Add above captures one.")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Nothing completed yet.")).toBeVisible();

  // 4. A Task List of the owner's own, then the full detail edit that files
  //    the Task into it without changing what the Task is.
  await page.getByLabel("New Task List").fill("Billing");
  await page.getByRole("button", { name: "Create list" }).click();
  /* Exact: the Task on this page is "Send the billing follow-up", and a
     substring match on "Billing" reaches its heading as well as the list's. */
  await expect(page.getByRole("heading", { level: 3, name: "Billing", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Edit details" }).click();
  await page.getByLabel("Notes").fill("Include the Q3 numbers.");
  await page.getByLabel("Due date").fill("2026-09-11");
  /* Exact, like the Task List field beside it: the filters above the list
     name the same concepts, and a substring match would reach either. */
  await page.getByLabel("Priority", { exact: true }).selectOption("high");
  await page.getByLabel("Task List", { exact: true }).selectOption({ label: "Billing" });
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Billing · due 2026-09-11 · high priority · You")).toBeVisible();
  await expect(page.getByText("Include the Q3 numbers.")).toBeVisible();
  // Focus returns to the control that opened the form.
  await expect(page.getByRole("button", { name: "Edit details" })).toBeFocused();

  // 5. A list that still holds a Task is refused rather than emptied.
  await page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: "Billing", exact: true }) })
    .getByRole("button", { name: "Delete list" })
    .click();
  await expect(page.getByRole("alert")).toContainText("still holds 1 Task");

  // 6. Refreshing the route is safe, and the Workspace still holds everything.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 3, name: "Send the billing follow-up" }),
  ).toBeVisible();
  await expect(page.getByText("No Action Items are waiting.")).toBeVisible();

  await scanForViolations(page);
});

test("tasks journey — opening Tasks reconciles linked records without being asked", async ({
  page,
}) => {
  // The Tasks-open trigger (issues #187, #190). Startup, the five-minute tick,
  // a local change and the Refresh button are proven at the API; this is the
  // fifth entry point, and it lives in the page rather than the server — a
  // `useEffect` in TasksPage that runs once per open.
  const reconciliations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/tasks/refresh")) {
      reconciliations.push(request.url());
    }
  });

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await expect.poll(() => reconciliations.length).toBe(1);

  // Once per open, not once per filter change: a projection read is not a
  // reason to spend provider calls.
  await page.getByLabel("Search Tasks").fill("a filter that changes nothing outward");
  await page.waitForTimeout(250);
  expect(reconciliations).toHaveLength(1);

  // And opening the page again reconciles again.
  await page.goto("/");
  await page.goto("/tasks");
  await expect.poll(() => reconciliations.length).toBe(2);
});

test("tasks journey — a Debrief's Action Items arrive as proposals, not Tasks", async ({
  page,
  request,
}) => {
  const fileName = "Tasks journey - 2026-08-19T13-00-00.000Z.md";
  const seeded = await request.post("/api/test/meeting-debrief/seed", {
    data: {
      transcript: {
        id: "drive_tasks_journey_r1",
        source: {
          sourceSystem: "drive",
          externalFileId: "tasks-journey",
          fileName,
          sourceUrl: null,
          checksum: "tasks-journey-checksum",
          observedRevision: 1,
          modifiedAt: "2026-08-19T13:05:00.000Z",
        },
        ingestedAt: "2026-08-31T12:00:00.000Z",
        extractorVersion: 1,
        normalizedText: [
          "Dana: We decided to move the pricing page review to Thursday.",
          "Dana: I will own the pricing page rewrite.",
        ].join("\n"),
        meetingDate: "2026-08-19",
        occurrence: null,
        speakers: ["Dana"],
        speakerIdentityMappings: [],
        roster: [],
      },
    },
  });
  expect(seeded.ok(), `seed failed: ${seeded.status()}`).toBe(true);
  const { runId } = (await seeded.json()) as { runId: string };

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`);
      return ((await detail.json()) as { status: string }).status;
    })
    .toBe("done");

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { level: 2, name: "Action Items" })).toBeVisible();
  const proposal = page
    .getByRole("listitem")
    .filter({ hasText: "own the pricing page rewrite" })
    .first();
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText(/^Proposed ·/)).toBeVisible();
  await expect(proposal.getByRole("link", { name: "Open full Debrief" })).toHaveAttribute(
    "href",
    `/meeting-debrief/${runId}`,
  );

  // A proposal is not accepted work: it carries no Task controls, and the
  // extraction created no Task of its own.
  /* Exactly "Complete": the review panel's own "Create completed Task" is a
     different control, and it is the one thing on the row that may create a
     Task — deliberately, and only after a review (issue #178). */
  await expect(proposal.getByRole("button", { name: "Complete", exact: true })).toHaveCount(0);
  const tasks = (await (await request.get("/api/tasks")).json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(tasks.tasks.map((task) => task.title)).not.toContain("own the pricing page rewrite");

  // Home and the Daily Briefing link every pending proposal to
  // `/tasks#action-item-<id>` (issue #192). The anchor those links point at
  // was missing outright until `153eb8a`, and a link to an anchor nothing
  // renders looks exactly like a working one — so the target is asserted here,
  // on the page that owns it, and the link is followed to prove it lands.
  const queue = (await (await request.get("/api/action-items?state=pending")).json()) as {
    items: Array<{ id: string; proposal: { title: string } }>;
  };
  const pending = queue.items.find((item) =>
    /own the pricing page rewrite/i.test(item.proposal.title),
  );
  expect(pending, "the seeded Debrief proposed the rewrite").toBeDefined();
  const anchor = page.locator(`#action-item-${pending!.id}`);
  await expect(anchor).toBeVisible();
  await expect(anchor).toContainText("own the pricing page rewrite");

  await page.goto("/");
  const compact = page.getByRole("link", { name: "own the pricing page rewrite" }).first();
  await expect(compact).toHaveAttribute("href", `/tasks#action-item-${pending!.id}`);
  await compact.click();
  await expect(page).toHaveURL(new RegExp(`/tasks#action-item-${pending!.id}$`));
  await expect(page.locator(`#action-item-${pending!.id}`)).toBeVisible();
});

test("tasks journey — dismissing an Action Item offers Undo and later restore", async ({
  page,
  request,
}) => {
  const fileName = "Tasks dismiss - 2026-08-20T13-00-00.000Z.md";
  const seeded = await request.post("/api/test/meeting-debrief/seed", {
    data: {
      transcript: {
        id: "drive_tasks_dismiss_r1",
        source: {
          sourceSystem: "drive",
          externalFileId: "tasks-dismiss",
          fileName,
          sourceUrl: null,
          checksum: "tasks-dismiss-checksum",
          observedRevision: 1,
          modifiedAt: "2026-08-20T13:05:00.000Z",
        },
        ingestedAt: "2026-08-31T12:00:00.000Z",
        extractorVersion: 1,
        normalizedText: [
          "Dana: We decided to rotate the archive keys on Friday.",
          "Dana: I will own the archive rotation.",
        ].join("\n"),
        meetingDate: "2026-08-20",
        occurrence: null,
        speakers: ["Dana"],
        speakerIdentityMappings: [],
        roster: [],
      },
    },
  });
  expect(seeded.ok(), `seed failed: ${seeded.status()}`).toBe(true);
  const { runId } = (await seeded.json()) as { runId: string };

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`);
      return ((await detail.json()) as { status: string }).status;
    })
    .toBe("done");

  const pendingRow = () =>
    page
      .getByRole("listitem")
      .filter({ hasText: "archive rotation" })
      .filter({ has: page.getByRole("button", { name: "Dismiss" }) });
  const dismissedRow = () =>
    page
      .getByRole("listitem")
      .filter({ hasText: "archive rotation" })
      .filter({ has: page.getByRole("button", { name: "Restore to pending" }) });

  await page.goto("/tasks");
  await expect(pendingRow().first()).toBeVisible();

  // Dismissing is immediate and local-only: no Task appears, and Undo does.
  await pendingRow().first().getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(pendingRow()).toHaveCount(0);
  await expect(dismissedRow().first()).toBeVisible();

  const tasks = (await (await request.get("/api/tasks")).json()) as {
    tasks: Array<{ title: string }>;
  };
  expect(tasks.tasks.map((task) => task.title)).not.toContain("I will own the archive rotation.");
  const dismissed = (await (await request.get("/api/action-items?state=dismissed")).json()) as {
    items: Array<{ proposal: { title: string } }>;
  };
  expect(dismissed.items.map((item) => item.proposal.title)).toContain(
    "I will own the archive rotation.",
  );

  await scanForViolations(page);

  // Undo returns the proposal to pending.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(pendingRow().first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

  // Dismissing again and restoring from the Dismissed history does the same.
  await pendingRow().first().getByRole("button", { name: "Dismiss" }).click();
  await expect(dismissedRow().first()).toBeVisible();
  await dismissedRow().first().getByRole("button", { name: "Restore to pending" }).click();
  await expect(pendingRow().first()).toBeVisible();

  // A dismissal can also be restored from the Debrief's own history.
  const queue = (await (
    await request.get(`/api/action-items?debriefRunId=${encodeURIComponent(runId)}`)
  ).json()) as { items: Array<{ id: string }> };
  expect(queue.items).toHaveLength(1);
  const dismissResponse = await request.post(`/api/action-items/${queue.items[0].id}/dismiss`);
  expect(dismissResponse.ok()).toBe(true);

  await page.goto(`/meeting-debrief/${runId}`);
  await expect(page.getByRole("heading", { name: "Action Item history" })).toBeVisible();
  const historyRow = page
    .getByRole("listitem")
    .filter({ hasText: "archive rotation" })
    .filter({ has: page.getByRole("button", { name: "Restore to pending" }) });
  await expect(historyRow).toBeVisible();
  await historyRow.getByRole("button", { name: "Restore to pending" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "archive rotation" })
      .filter({ has: page.getByRole("link", { name: "Review in Tasks" }) }),
  ).toBeVisible();

  await page.goto("/tasks");
  await expect(pendingRow().first()).toBeVisible();
});

test("tasks journey — a possible duplicate warns, and the owner can still decide", async ({
  page,
  request,
}) => {
  // A Debrief proposes one commitment; the same work is about to be captured
  // twice, once by hand and once by promotion (issue #180).
  const fileName = "Tasks duplicate - 2026-08-21T13-00-00.000Z.md";
  const seeded = await request.post("/api/test/meeting-debrief/seed", {
    data: {
      transcript: {
        id: "drive_tasks_duplicate_r1",
        source: {
          sourceSystem: "drive",
          externalFileId: "tasks-duplicate",
          fileName,
          sourceUrl: null,
          checksum: "tasks-duplicate-checksum",
          observedRevision: 1,
          modifiedAt: "2026-08-21T13:05:00.000Z",
        },
        ingestedAt: "2026-08-31T12:00:00.000Z",
        extractorVersion: 1,
        normalizedText: [
          "Dana: We decided to renew the TLS certificate this quarter.",
          "Dana: I will own the certificate renewal.",
        ].join("\n"),
        meetingDate: "2026-08-21",
        occurrence: null,
        speakers: ["Dana"],
        speakerIdentityMappings: [],
        roster: [],
      },
    },
  });
  expect(seeded.ok(), `seed failed: ${seeded.status()}`).toBe(true);
  const { runId } = (await seeded.json()) as { runId: string };
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`);
      return ((await detail.json()) as { status: string }).status;
    })
    .toBe("done");

  const openTasks = async (): Promise<Array<{ id: string; title: string }>> => {
    const index = (await (await request.get("/api/tasks")).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return index.tasks;
  };

  const queue = (await (await request.get("/api/action-items?state=pending")).json()) as {
    items: Array<{ proposal: { title: string } }>;
  };
  const proposed = queue.items.find((one) => /certificate renewal/i.test(one.proposal.title));
  expect(proposed, "the seeded Debrief proposed the renewal").toBeDefined();
  const title = proposed!.proposal.title;

  await page.goto("/tasks");

  // The first Task with a title is nobody's duplicate: no warning, one row.
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(1);
  const firstId = (await openTasks()).find((task) => task.title === title)!.id;
  await expect(page.locator(`#task-${firstId}`)).toBeVisible();

  // The second attempt warns instead of creating, and the warning links to
  // the Task it is about.
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  const warning = page.locator("div.banner-warn").filter({ hasText: "Possible duplicate." });
  await expect(warning).toBeVisible();
  await page.getByLabel("Search Tasks").fill("a filter hiding the original");
  await expect(page.locator(`#task-${firstId}`)).toHaveCount(0);
  await warning.getByText(`Compare: ${title}`, { exact: true }).click();
  await expect(warning.getByText("Inbox · no due date · open", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue(title);
  await expect(page.getByRole("button", { name: "Add anyway" })).toBeVisible();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(1);

  // Submitting again is the owner's explicit decision, and it creates.
  await page.getByRole("button", { name: "Add anyway" }).click();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(2);

  // Promotion warns the same way. The proposal names Dana, not the owner, so
  // the review first decides who is responsible — the editability that makes
  // the tuple an owner decision rather than an extraction's guess.
  const proposal = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "Dismiss" }) })
    .filter({ hasText: title })
    .first();
  await proposal.getByRole("button", { name: "Create Task", exact: true }).click();
  // The proposal arrives with the meeting's due date; the Tasks above have
  // none. Clearing it — and naming the owner — is the review making the
  // tuple match, which is exactly the editability the panel exists for.
  await proposal.getByLabel("Due date").fill("");
  await proposal.getByLabel("Responsible Person").selectOption("owner");
  await proposal.locator("form").getByRole("button", { name: "Create Task", exact: true }).click();
  await expect(warning).toBeVisible();
  await expect(
    proposal.locator("form").getByRole("button", { name: "Create Task anyway", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(2);

  // And the same explicit decision promotes the proposal regardless.
  await proposal
    .locator("form")
    .getByRole("button", { name: "Create Task anyway", exact: true })
    .click();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(3);

  await scanForViolations(page);
});

test("tasks journey — a duplicate check that fails never stands between the owner and the Task", async ({
  page,
  request,
}) => {
  // The warning is advisory, so an unanswerable check is not an objection
  // (issue #180). Capture must survive the check being unavailable: before
  // #180 this path had no gate at all, and a warning may not invent one.
  const title = `Unreachable check ${Date.now()}`;
  const openTasks = async (): Promise<Array<{ id: string; title: string }>> => {
    const index = (await (await request.get("/api/tasks")).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return index.tasks;
  };

  await page.route("**/api/tasks/duplicates", (route) => route.abort("failed"));
  await page.goto("/tasks");

  // One submit, one Task: the failed check is not a warning and not a wall.
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect
    .poll(async () => (await openTasks()).filter((task) => task.title === title).length)
    .toBe(1);
  await expect(
    page.locator("div.banner-warn").filter({ hasText: "Possible duplicate." }),
  ).toHaveCount(0);
});
