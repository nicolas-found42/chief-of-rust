import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The Person Profiles browser journey (spec #117, Testing Decisions): the same
 * observable operations the API and module-interface tests exercise — search
 * the list, create a Profile explicitly, open its stable detail route, and
 * step back to an exact historical revision — driven through the real UI over
 * a hermetic Workspace. No provider is configured, so creation records only
 * what the owner typed.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("person profiles journey — nav → search → create → detail → revision history", async ({
  page,
}) => {
  // 1. The product area is reachable from explicit navigation, not the Module bar.
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Person Profiles" })
    .click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole("heading", { level: 1, name: "Person Profiles" })).toBeFocused();
  // The hermetic Workspace seeds the V1 Content Research watchlist, and every
  // watch requires a confirmed Person Profile (#134) — so the list opens with
  // those Profiles already present rather than empty.
  await expect(page.getByRole("cell", { name: "Lenny Rachitsky" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pieter Levels" })).toBeVisible();

  // 2. Manual creation is explicit and validates identity inputs.
  await page.getByRole("link", { name: "New profile" }).click();
  await expect(page).toHaveURL(/\/people\/new$/);
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByRole("alert")).toContainText("at least a full name or an email address");

  await page.getByLabel("Full name").fill("Grace Hopper");
  await page.getByLabel("Primary email").fill("grace@example.com");
  await page.getByLabel("Role").fill("Rear Admiral");
  await page.getByLabel("Current employer").fill("US Navy");
  await page.getByLabel("Background").fill("Pioneered compilers.");
  await page.getByRole("button", { name: "Create profile" }).click();

  // 3. The detail route is stable and shows the auditable first revision.
  await expect(page).toHaveURL(/\/people\/person_[0-9a-f]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();
  await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await expect(page.getByText("Revision 1 (current)")).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "grace@example.com" })).toBeVisible();
  await expect(page.getByText("Pioneered compilers.")).toBeVisible();
  await expect(page.getByText("No enrichment diagnostics recorded.")).toBeVisible();

  const profileId = new URL(page.url()).pathname.split("/").pop()!;
  const linkedBriefResponse = await page.request.post(
    "/api/test/seed-person-profile-meeting-brief",
    { data: { profileId } },
  );
  expect(linkedBriefResponse.ok()).toBe(true);
  const linkedRunId = ((await linkedBriefResponse.json()) as { runId: string }).runId;
  await page.getByLabel("Role", { exact: true }).last().fill("Professor of Computer Science");
  await page.getByLabel("What was wrong?").fill("Teaching at Vassar, not serving.");
  await page.getByRole("button", { name: "Append correction" }).click();
  await expect(
    page.getByRole("definition").filter({ hasText: "Professor of Computer Science" }),
  ).toBeVisible();
  await expect(page.getByText(/Correction — revision 1 superseded/)).toContainText(
    "Teaching at Vassar, not serving.",
  );
  await page.goto(`/runs/${linkedRunId}`);
  await expect(page.getByRole("alert")).toContainText("Profile-derived claims need refresh");
  await expect(page.getByRole("alert")).toContainText("revision 1");
  await scanForViolations(page);
  await page.getByRole("button", { name: "Regenerate with current profiles" }).click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`/runs/${linkedRunId}`);
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert", { name: /Profile-derived claims/ })).toHaveCount(0);
  await page.goto(`/runs/${linkedRunId}`);
  await expect(page.getByRole("alert")).toContainText("Profile-derived claims need refresh");
  await page.goto(`/people/${profileId}`);
  await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByLabel("Clear primary email").check();
  await page.getByLabel("Clear current employer").check();
  await page.getByLabel("Clear background").check();
  await page.getByLabel("What was wrong?").fill("Employer and background were false claims.");
  await page.getByRole("button", { name: "Append correction" }).click();
  await expect(page.getByRole("definition").filter({ hasText: "grace@example.com" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("definition").filter({ hasText: "US Navy" })).toHaveCount(0);
  await expect(page.getByText(/Correction — revision 2 superseded/)).toContainText(
    "Employer and background were false claims.",
  );
  // A direct load of the same URL is the same Profile: the route is the resource.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Grace Hopper" })).toBeVisible();

  // 4. Search finds the Profile; a miss says so.
  await page
    .getByRole("navigation", { name: "Products" })
    .getByRole("link", { name: "Person Profiles" })
    .click();
  await expect(page).toHaveURL(/\/people$/);
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible();
  await page.getByLabel("Search").fill("nobody-at-all");
  await expect(page.getByText("No Profiles match that search.")).toBeVisible();
  await page.getByLabel("Search").fill("grace");
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible();

  // 5. The revision history links to the exact recorded revision.
  await page.getByRole("cell", { name: "Grace Hopper" }).getByRole("link").click();
  await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByRole("button", { name: "Revision 1", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Viewing revision 1 exactly as it was recorded",
  );
  await expect(page).toHaveURL(/\/people\/person_[0-9a-f]+\?revision=1$/);
  await expect(page.getByRole("definition").filter({ hasText: "Rear Admiral" })).toBeVisible();
  await page.getByRole("button", { name: /Back to the current revision/ }).click();
  await expect(
    page.getByRole("definition").filter({ hasText: "Professor of Computer Science" }),
  ).toBeVisible();

  // 6. A conflicting duplicate cannot merge until the owner resolves the
  // named fact; the successful decision preserves a readable redirect.
  const conflictingResponse = await page.request.post("/api/people", {
    data: { fullName: "Grace Hopper", role: "Software pioneer" },
  });
  expect(conflictingResponse.ok()).toBe(true);
  const conflictingId = (await conflictingResponse.json()).id as string;
  await page.getByLabel("Find duplicate person").fill("Grace");
  await page.getByLabel("Duplicate person", { exact: true }).selectOption(conflictingId);
  await page.getByRole("button", { name: "Merge profile" }).click();
  await expect(page.getByRole("alert")).toContainText("different role");
  await page.getByLabel("Resolved role").fill("Professor of Computer Science");
  await page.getByLabel("Merge note").fill("Duplicate shell for the same person.");
  await page.getByRole("button", { name: "Merge profile" }).click();
  await expect(page.getByText(/Merge — revision 3 superseded/)).toContainText(
    "Duplicate shell for the same person.",
  );
  await page.goto(`/people/${conflictingId}`);
  await expect(page.getByRole("alert")).toContainText("was merged into");
  await expect(page.getByRole("link", { name: "another Profile" })).toHaveAttribute(
    "href",
    `/people/${profileId}`,
  );

  // 7. Wrong-person evidence can be split to the correct Profile. The old
  // attribution leaves current fact, remains in history, and is disclosed.
  const correctResponse = await page.request.post("/api/people", {
    data: { fullName: "Katherine Johnson" },
  });
  expect(correctResponse.ok()).toBe(true);
  const correctId = (await correctResponse.json()).id as string;
  const evidenceResponse = await page.request.post("/api/test/seed-person-evidence", {
    data: { profileId, evidenceId: "ev_wrong_person" },
  });
  expect(evidenceResponse.ok()).toBe(true);
  await page.goto(`/people/${profileId}`);
  // Maintenance is secondary to the dossier (#209), so a fresh load discloses it again.
  await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByLabel("Evidence").selectOption("ev_wrong_person");
  await page.getByLabel("Move to profile id (optional)").fill(correctId);
  await page.getByLabel("Detach note").fill("This source describes Katherine, not Grace.");
  await page.getByRole("button", { name: "Detach evidence" }).click();
  await expect(page.getByText(/Evidence detached — revision 5 superseded/)).toContainText(
    "This source describes Katherine, not Grace.",
  );
  await expect(page.getByText("Wrong-person evidence")).toHaveCount(0);
  await page.getByRole("link", { name: correctId }).click();
  await expect(page.getByRole("cell", { name: "Wrong-person evidence" })).toBeVisible();

  // 8. The routes the page-wide scans do not walk yet are still axe-clean.
  await page.goto("/people/new");
  await scanForViolations(page);
  await page.goto(`/people/${profileId}`);
  await scanForViolations(page);
});
