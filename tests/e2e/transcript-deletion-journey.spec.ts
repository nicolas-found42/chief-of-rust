import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/**
 * The transcript deletion journey (spec #117, issue #128): the owner reaches
 * the deletion surface from the Review page, deletes a seeded transcript over
 * the real Catalog cascade, reads the disclosure that the remote Drive source
 * and provider records remain untouched, sees the do-not-reingest tombstone,
 * and explicitly restores processing permission so the source can be
 * reingested.
 */
async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

test("transcript deletion journey — delete with disclosure → tombstone → restore → reingest", async ({
  page,
}) => {
  await page.goto("/people");
  await page.getByRole("link", { name: "Review queue" }).click();
  await expect(page.getByRole("heading", { name: "Retained transcripts", level: 2 })).toBeVisible();
  /* Other journeys share this server and may retain their own transcripts;
     this journey's contract is scoped to its own seeded record. */
  await expect(page.getByRole("listitem").filter({ hasText: "Weekly Product Sync" })).toHaveCount(
    0,
  );

  // Seed a real corpus through the real Catalog over the hermetic Workspace.
  const seeded = await page.request.post("/api/test/seed-transcript-corpus");
  expect(seeded.ok()).toBe(true);
  await page.reload();

  const syncCard = page.getByRole("listitem").filter({
    hasText: "Weekly Product Sync — 2026-08-17T13-00-00.000Z.md",
  });
  await expect(syncCard).toHaveCount(1);
  await scanForViolations(page);

  // The delete affordance is inert until the exact confirmation is typed.
  const confirmation = syncCard.getByLabel(/Type DELETE TRANSCRIPT to confirm/);
  await confirmation.fill("delete");
  await expect(syncCard.getByRole("button", { name: "Delete transcript" })).toBeDisabled();
  /* The confirmation disclosure (#122 pattern) surfaces what the cascade
     will remove before the irreversible action. */
  await expect(
    page.getByText(/Deletion will also remove|No registered consumer holds additional/),
  ).toBeVisible();
  await confirmation.fill("DELETE TRANSCRIPT");
  await expect(
    page.getByText(/the remote Drive source and any previously created Gmail, Tasks/),
  ).toBeVisible();

  await syncCard.getByRole("button", { name: "Delete transcript" }).click();

  // The deleted transcript leaves the retained list and appears as a
  // content-free do-not-reingest tombstone.
  await expect(page.getByRole("listitem").filter({ hasText: "Weekly Product Sync" })).toHaveCount(
    0,
  );
  const tombstoneCard = page
    .getByRole("listitem")
    .filter({ hasText: "Do not reingest until processing permission is restored" });
  await expect(tombstoneCard).toHaveCount(1);
  await scanForViolations(page);

  // Restoring processing permission clears the tombstone; the next seeding
  // pass processes the file exactly once again.
  await tombstoneCard.getByRole("button", { name: "Restore processing permission" }).click();
  await expect(page.getByText(/Processing permission restored for seed-sync/)).toBeVisible();
  await expect(tombstoneCard).toHaveCount(0);

  const reseeded = await page.request.post("/api/test/seed-transcript-corpus");
  expect(reseeded.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: "Weekly Product Sync" })).toHaveCount(
    1,
  );
});
