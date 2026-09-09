import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The semantic transcript relevance journey (spec #117, issue #127): the
 * owner reaches the Review surface from Person Profiles, searches the real
 * seeded transcript corpus through the real index, reads bounded cited
 * results with their diagnostics, and records confirm / reject / unresolved
 * decisions. Nothing here touches a Profile: the lane's whole point is that
 * unconfirmed similarity never becomes fact.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("semantic transcript relevance journey — nav → search → confirm → reject → leave unresolved", async ({
  page,
}) => {
  // 1. The Review surface hangs off the Person Profiles product area.
  await page.goto("/people");
  await page.getByRole("link", { name: "Review queue" }).click();
  await expect(page).toHaveURL(/\/people\/review$/);
  await expect(page.getByRole("heading", { level: 1, name: "Transcript review" })).toBeFocused();
  await expect(
    page.getByText("No relevance candidates yet. Search the corpus to find reviewable excerpts."),
  ).toBeVisible();

  // 2. Seed a real corpus through the real Catalog over the hermetic Workspace.
  const seeded = await page.request.post("/api/test/seed-transcript-corpus");
  expect(seeded.ok()).toBe(true);

  // 3. Search finds the relevant conversation and cites it verbatim.
  await page
    .getByLabel("Search the transcript corpus")
    .fill("export button timing out on large accounts");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  /* The page also lists the retained transcript corpus for deletion
     (issue #128); scope every assertion to the relevance results list. */
  const relevanceItems = page.locator("ul.relevance-list").first();
  const syncCard = relevanceItems.getByRole("listitem").filter({
    hasText: "Weekly Product Sync — 2026-08-17T13-00-00.000Z.md",
  });
  await expect(syncCard).toHaveCount(1);
  await expect(syncCard.locator("blockquote")).toContainText(
    "export button timing out on large accounts",
  );
  await expect(syncCard.getByText("Pending review")).toBeVisible();
  await expect(syncCard.getByText(/Index or model version/)).toBeVisible();
  await expect(
    page.getByText(/Nothing here is a fact: confirm, reject, or leave each result unresolved/),
  ).toBeVisible();
  await scanForViolations(page);

  // 4. Confirming is an explicit, auditable relevance decision — and no more:
  //    the surface says so instead of implying the result became a fact.
  await syncCard.getByRole("button", { name: "Confirm relevance" }).click();
  await expect(
    page.getByText(
      "Relevance confirmed. It is now an auditable relevance decision — it still does not change any Profile.",
    ),
  ).toBeVisible();
  await expect(syncCard.getByText("Confirmed")).toBeVisible();
  await expect(syncCard.getByRole("button", { name: "Confirm relevance" })).toHaveCount(0);

  // 5. A second search surfaces another conversation; the owner rejects it.
  await page.getByLabel("Search the transcript corpus").fill("investor update draft churn numbers");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  const boardCard = relevanceItems.getByRole("listitem").filter({
    hasText: "Board Prep — 2026-08-19T10-00-00.000Z.md",
  });
  await expect(boardCard).toHaveCount(1);
  await expect(boardCard.getByText("Pending review")).toBeVisible();
  await boardCard.getByRole("button", { name: "Reject" }).click();
  await expect(boardCard.getByText("Rejected")).toBeVisible();

  // 6. A third result can be left unresolved explicitly.
  await page.getByLabel("Search the transcript corpus").fill("onboarding flow plan-selection step");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  const unresolvedCard = relevanceItems
    .getByRole("listitem")
    .filter({ hasText: "Weekly Product Sync — 2026-08-17T13-00-00.000Z.md" })
    .filter({ hasText: "plan-selection" });
  await expect(unresolvedCard).toHaveCount(1);
  await unresolvedCard.getByRole("button", { name: "Leave unresolved" }).click();
  await expect(unresolvedCard.getByText("Left unresolved")).toBeVisible();

  // 7. Review state filters make the remaining work and the decisions readable.
  await page.getByLabel("Review state").selectOption("pending");
  await expect(page.getByText("No results in that review state.")).toBeVisible();
  await page.getByLabel("Review state").selectOption("confirmed");
  await expect(syncCard).toHaveCount(1);
  await page.getByLabel("Review state").selectOption("rejected");
  await expect(boardCard).toHaveCount(1);
  await page.getByLabel("Review state").selectOption("unresolved");
  await expect(unresolvedCard).toHaveCount(1);

  // 8. A miss says so instead of inventing similarity.
  await page.getByLabel("Search the transcript corpus").fill("quarterly xylophone budget");
  await page.getByRole("button", { name: "Search transcripts" }).click();
  await expect(page.getByText("No new relevance candidates.")).toBeVisible();
  await page.getByLabel("Review state").selectOption("all");
  await expect(relevanceItems.getByRole("listitem")).toHaveCount(3);
  await scanForViolations(page);
});
