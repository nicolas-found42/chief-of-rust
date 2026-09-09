import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

/**
 * The Content Project browser journey (spec #143, AC 1): the creation path the
 * product actually owns — Brand Voice revisions, one approved Source Target,
 * the Scout Run's ranked shortlist, and selecting an Opportunity to start
 * exactly one governed Content Project (#133) — driven through the real UI
 * over a hermetic Workspace. The fixture Content Scout ports
 * (contentScoutTestPorts under ENABLE_TEST_SEED=1) stand in for the public web
 * and the model seam; no Google, no LLM. The bounded Brand Profile scan path
 * is covered by ui.spec's Content Scout journey; this one pins the Project
 * inputs themselves, so Brand Voice is authored and versioned manually.
 *
 * Project versioning is now driven here rather than parked: the Content
 * Projects tab lists the Project the selection started and its page appends a
 * revision, which spec #147 built the surface for. Brand Profile revisions are
 * still asserted along the way — every acceptance appends one and the UI names
 * the current one.
 *
 * One step still stops at the product boundary rather than fake a surface:
 * - Idempotent re-selection (#133) cannot be driven through the UI: a selected
 *   Opportunity enters the seven-day same-angle cooldown
 *   (ContentScoutStore.opportunityCooldownDisposition), so a later Scout Run
 *   deliberately never re-presents it. The same-Project re-selection contract
 *   stays at the module interface (content-projects.test.ts, "WorkspaceContent
 *   Projects opportunity relationship").
 */
async function seedConfirmedOwner(page: Page): Promise<void> {
  await page.request.post("/api/test/owner-identity", {
    data: { email: "content-owner@example.com" },
  });
  const peopleResponse = await page.request.get("/api/people");
  const people = (await peopleResponse.json()) as { id: string; emails: string[] }[];
  let owner = people.find((profile) => profile.emails.includes("content-owner@example.com"));
  if (!owner) {
    const created = await page.request.post("/api/people", {
      data: { fullName: "Content Workspace Owner", primaryEmail: "content-owner@example.com" },
    });
    expect(created.ok()).toBe(true);
    owner = (await created.json()) as { id: string; emails: string[] };
  }
  const confirmation = await page.request.post("/api/onboarding/owner/confirm", {
    data: { profileId: owner.id },
  });
  expect(confirmation.ok()).toBe(true);
}

test("content project journey — brand voice revisions → scout → select → project started", async ({
  page,
}) => {
  await seedConfirmedOwner(page);

  // 1. The product area is reachable from explicit navigation, not a hidden route.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Content Engine" })
    .click();
  await expect(page).toHaveURL(/\/content-scout$/);
  await expect(page.getByRole("heading", { level: 1, name: "Content Scout" })).toBeFocused();

  // 2. Versioning the inputs a Project will freeze: each Brand Voice acceptance
  //    appends an immutable Markdown revision, and the UI names the new current
  //    one. (The regex accepts both button wordings because the suite's file
  //    order decides whether a revision already exists when this journey runs.)
  await page.getByRole("button", { name: "Brand Profile" }).click();
  await page.getByLabel("Website used as evidence").fill("https://company.example/");
  await page
    .getByLabel("Accepted Markdown")
    .fill(
      [
        "# Brand Profile",
        "",
        "## Positioning",
        "Evidence-led explanations of public changes.",
        "",
        "## Voice",
        "Direct, specific, and useful.",
        "",
        "## Avoided subjects",
        "Unverified rumors.",
        "",
      ].join("\n"),
    );
  await page.getByRole("button", { name: /Accept (Brand Profile|new revision)/ }).click();
  await expect(page.getByText("Brand Profile revision accepted.")).toBeVisible();
  // Assert on the surfaced text first, then extract: the assertion is the
  // check (a non-revision string fails here, with Playwright's diagnostic),
  // and the extraction afterwards only names what the UI already showed.
  const firstRevisionHeading = page.getByText(/^Current revision brand_/);
  await expect(firstRevisionHeading).toHaveText(/Current revision brand_[0-9a-z]+/);
  const firstRevision = (await firstRevisionHeading.textContent())!.match(/brand_[0-9a-z]+/)![0];

  await page
    .getByLabel("Accepted Markdown")
    .fill(
      [
        "# Brand Profile",
        "",
        "## Positioning",
        "Evidence-led explanations of public changes, for operators.",
        "",
        "## Voice",
        "Direct, specific, and useful; no speculation.",
        "",
        "## Avoided subjects",
        "Unverified rumors.",
        "",
      ].join("\n"),
    );
  await page.getByRole("button", { name: /Accept (Brand Profile|new revision)/ }).click();
  await expect(page.getByText("Brand Profile revision accepted.")).toBeVisible();
  const secondRevisionHeading = page.getByText(/^Current revision brand_/);
  await expect(secondRevisionHeading).toHaveText(/Current revision brand_[0-9a-z]+/);
  const secondRevision = (await secondRevisionHeading.textContent())!.match(/brand_[0-9a-z]+/)![0];
  expect(secondRevision).not.toBe(firstRevision);

  // 3. One approved Source Target is what collection runs against. The label
  //    stays distinct from ui.spec's so both journeys' rows coexist.
  await page.getByRole("button", { name: "Sources" }).click();
  await page.getByLabel("Source Adapter").selectOption("rss");
  await page.getByLabel("Name").fill("Fixture Public Research");
  await page.getByLabel("Recurring public URL").fill("https://example.com/fixture.xml");
  await page.getByRole("button", { name: "Approve source" }).click();
  await expect(
    page.getByRole("cell", { name: "Fixture Public Research", exact: false }),
  ).toBeVisible();

  // 4. Scout now: fixture collection and ranking produce one Ready Opportunity
  //    on the shortlist — the surface the Project decision happens on.
  await page.getByRole("button", { name: "Scout now" }).click();
  await expect(page.getByText("The ranked shortlist is ready for your decision.")).toBeVisible();
  await page.getByRole("button", { name: "Shortlist", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ranked shortlist" })).toBeVisible();
  await expect(page.getByText("Explain what the verified change means in practice")).toBeVisible();

  // 5. Selecting the Opportunity starts exactly one governed Content Project —
  //    with the Project's own required inputs, and nothing generated here.
  await page.getByRole("checkbox", { name: /Explain what the verified change/ }).check();
  await page.getByRole("combobox", { name: "Objective" }).selectOption("educate");
  await page.getByLabel("Intended audience").fill("Operations leads");
  await page.getByRole("checkbox", { name: "linkedin standard post" }).check();
  await page
    .getByRole("combobox", { name: "Research mode" })
    .selectOption("existing-workspace-evidence");
  await page.getByRole("button", { name: "Start Project" }).click();
  await expect(
    page.getByText("The selected Opportunities started their Content Projects."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects started" })).toBeVisible();
  const projectBadge = page.locator("code", { hasText: /^project_/ });
  await expect(projectBadge).toBeVisible();
  const projectId = (await projectBadge.textContent())!;
  expect(projectId).toMatch(/^project_/);
  await expect(
    page.getByText(/still require evidence review, an approved Outline Charter/),
  ).toBeVisible();

  // 6. The durable Run receipt carries the same Opportunity → Project
  //    relationship the card shows, and this Run created the Project.
  const state = (await (await page.request.get("/api/content-scout")).json()) as {
    shortlist: { runId: string };
  };
  const runDetail = (await (
    await page.request.get(`/api/runs/${state.shortlist.runId}`)
  ).json()) as {
    status: string;
    result: { projects: { opportunityId: string; projectId: string; created: boolean }[] };
  };
  expect(runDetail.status).toBe("done");
  expect(runDetail.result.projects).toEqual([
    { opportunityId: expect.stringMatching(/^opportunity-/), projectId, created: true },
  ]);

  // 7. The Project is reachable from the product area rather than only from the
  //    Run receipt: the Content Projects tab lists it, and its page opens.
  await page.getByRole("button", { name: "Content Projects" }).click();
  await page.getByRole("link", { name: /Explain what the verified change/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Intent" })).toBeVisible();
  await expect(page.getByText("Operations leads")).toBeVisible();

  // 8. Generation stays closed, and the page names what is missing rather than
  //    refusing blankly — the whole point of the readiness surface.
  await expect(page.getByRole("heading", { level: 2, name: "Readiness" })).toBeVisible();
  await expect(page.getByText(/Generation stays closed until each of these/)).toBeVisible();
  await expect(page.getByText(/has not been reviewed and frozen/)).toBeVisible();

  // 9. Revising intent appends a version rather than editing the last one —
  //    the contract that previously had no surface to be driven through.
  const beforeRevision = (await (
    await page.request.get(`/api/content-engine/projects/${projectId}`)
  ).json()) as { project: { revisions: unknown[] } };
  expect(beforeRevision.project.revisions).toHaveLength(1);

  const revised = await page.request.post(`/api/content-engine/projects/${projectId}/revisions`, {
    data: { audience: "Heads of operations" },
  });
  expect(revised.ok()).toBe(true);

  const afterRevision = (await (
    await page.request.get(`/api/content-engine/projects/${projectId}`)
  ).json()) as { project: { revisions: { audience: string }[] } };
  expect(afterRevision.project.revisions).toHaveLength(2);
  expect(afterRevision.project.revisions[0]?.audience).toBe("Operations leads");
  expect(afterRevision.project.revisions[1]?.audience).toBe("Heads of operations");

  await page.reload();
  await expect(page.getByText("Heads of operations")).toBeVisible();
});
