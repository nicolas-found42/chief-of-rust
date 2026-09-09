import AxeBuilder from "@axe-core/playwright";
import type { APIResponse, Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** The `id` field of a Profile-creation response, narrowed at the HTTP boundary. */
async function createdProfileId(response: APIResponse): Promise<string> {
  const body: unknown = await response.json();
  if (body && typeof body === "object" && "id" in body && typeof body.id === "string") {
    return body.id;
  }
  throw new Error("Profile creation answered without an id.");
}

async function scanForViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, results.violations.map((v) => v.id).join(", ")).toEqual([]);
}

/**
 * The Person Profile lifecycle browser journey (ticket #122): archive and
 * restore are explicit reversible state surfaced on the list and the detail
 * page, privacy deletion demands its own typed confirmation, a refusal renders
 * the disclosure it carries instead of an opaque failure, and a deletion ends
 * on the receipt and the content-free tombstone. The dependent-configuration
 * and residual-artifact disclosures are exercised against the same response
 * bodies the routes answer with, fulfilled at the network seam because the
 * hermetic Workspace's composition root registers no consumer that reports
 * active configuration or residual documents.
 */
test("person profile lifecycle journey — archive badge → archive → restore → typed confirmation → refused delete → receipt → tombstone", async ({
  page,
}) => {
  const created = await page.request.post("/api/people", {
    data: { fullName: "Anita Borg", primaryEmail: "anita@example.com" },
  });
  expect(created.ok()).toBe(true);
  const profileId = await createdProfileId(created);

  // 1. The list classifies state: an active Profile reads as Active at a glance.
  await page.goto("/people");
  const row = page.getByRole("row", { name: /Anita Borg/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell", { name: "Active" })).toBeVisible();

  // 2. Archiving from the detail page is explicit and reversible state.
  await page.goto(`/people/${profileId}`);
  if (await page.getByText("Profile maintenance and revision history", { exact: true }).count())
    await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByRole("button", { name: "Archive profile" }).click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore profile" })).toBeVisible();

  // 3. The archived Profile leaves the default list and reads as Archived.
  await page.goto("/people");
  await expect(page.getByRole("row", { name: /Anita Borg/ })).toHaveCount(0);
  await page.getByLabel("Include archived").check();
  const disclosed = page.getByRole("row", { name: /Anita Borg/ });
  await expect(disclosed).toBeVisible();
  await expect(disclosed.getByRole("cell", { name: "Archived" })).toBeVisible();

  // 4. Restoring makes the same canonical identity selectable again.
  await page.goto(`/people/${profileId}`);
  if (await page.getByText("Profile maintenance and revision history", { exact: true }).count())
    await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByRole("button", { name: "Restore profile" }).click();
  await expect(page.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive profile" })).toBeVisible();
  await page.goto("/people");
  const activeAgain = page.getByRole("row", { name: /Anita Borg/ });
  await expect(activeAgain).toBeVisible();
  await expect(activeAgain.getByRole("cell", { name: "Active" })).toBeVisible();

  // 5. Privacy deletion demands its own distinct typed confirmation before
  //    anything happens; a wrong confirmation refuses and deletes nothing.
  await page.goto(`/people/${profileId}`);
  if (await page.getByText("Profile maintenance and revision history", { exact: true }).count())
    await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByRole("button", { name: "Privacy delete this profile…" }).click();
  await expect(page.getByText("Source documents that will remain")).toBeVisible();
  await expect(
    page.getByText(
      /Immutable transcript and public-source documents are never deleted with the Profile/,
    ),
  ).toBeVisible();
  await page.getByLabel("Type DELETE PROFILE to confirm").fill("archive");
  await page.getByRole("button", { name: "Permanently delete this profile" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Privacy deletion requires the exact confirmation DELETE PROFILE.",
  );
  await expect(page.getByRole("heading", { level: 1, name: "Anita Borg" })).toBeVisible();

  // 6. A refused deletion renders the disclosure it carries: which active
  //    configuration still points here and which immutable documents remain.
  await page.route(`**/api/people/${profileId}/privacy-delete`, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "active-dependencies",
        message:
          "Pause or re-point every active dependent configuration before privacy-deleting this Profile.",
        lifecycle: {
          profileId,
          profileRevision: 1,
          archivedAt: null,
          dependentConfigurations: [
            {
              id: "watch_anita",
              consumer: "content-research",
              label: "Anita weekly watch",
              state: "active",
              availableActions: ["pause", "repoint"],
              profileId,
            },
          ],
          residualSourceArtifacts: [
            { artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true },
          ],
        },
      }),
    });
  });
  await page.getByLabel("Type DELETE PROFILE to confirm").fill("DELETE PROFILE");
  await page.getByRole("button", { name: "Permanently delete this profile" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Pause or re-point every active dependent configuration",
  );
  await expect(
    page.getByText("One active configuration still points at this Profile."),
  ).toBeVisible();
  await expect(page.getByText("Anita weekly watch")).toBeVisible();
  await expect(page.getByText("(content-research)")).toBeVisible();
  await expect(page.getByText("resolve by: pause or re-point")).toBeVisible();
  await expect(page.getByText(/not deleted with the Profile/)).toBeVisible();
  await expect(page.getByText(/Transcript transcript_42 — separate source deletion/)).toBeVisible();
  await page.unroute(`**/api/people/${profileId}/privacy-delete`);

  // 7. A successful deletion ends on the receipt and the content-free
  //    tombstone, and the profile route keeps answering 410 with it.
  await page.getByLabel("Type DELETE PROFILE to confirm").fill("DELETE PROFILE");
  await page.getByRole("button", { name: "Permanently delete this profile" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Profile privacy-deleted" }),
  ).toBeVisible();
  await expect(
    page.getByText(/A content-free tombstone keeps existing references resolvable/),
  ).toBeVisible();
  await expect(page.getByText("What the deletion accounted for")).toBeVisible();
  await expect(page.getByText("0 — no remote provider data was deleted")).toBeVisible();
  await expect(page.getByText("Source documents that remain")).toBeVisible();
  await scanForViolations(page);

  await page.goto(`/people/${profileId}`);
  if (await page.getByText("Profile maintenance and revision history", { exact: true }).count())
    await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Profile privacy-deleted" }),
  ).toBeVisible();
  await expect(page.getByText(/were deleted on/)).toBeVisible();
  await expect(page.getByText("What the deletion accounted for")).toBeVisible();

  // 8. The receipt discloses the immutable source documents that remain until
  //    each is separately deleted — as references, never by title.
  const residual = await page.request.post("/api/people", {
    data: { fullName: "Katherine Johnson" },
  });
  expect(residual.ok()).toBe(true);
  const residualId = await createdProfileId(residual);
  await page.route(`**/api/people/${residualId}/privacy-delete`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: `profile-deletion-${residualId}`,
        profileId: residualId,
        deletedAt: "2026-08-31T16:00:00.000Z",
        removed: {
          canonicalProfileRecords: 1,
          revisions: 1,
          evidence: 0,
          aliases: 0,
          candidates: 0,
          mappings: 0,
          decisions: 0,
          activeLinks: 0,
          personSnapshots: 0,
        },
        tombstone: { profileId: residualId, deletedAt: "2026-08-31T16:00:00.000Z" },
        residualSourceArtifacts: [
          { artifactId: "transcript_42", kind: "transcript", separateDeleteSupported: true },
          { artifactId: "source_7", kind: "public-source", separateDeleteSupported: false },
        ],
        remoteProviderOperations: 0,
      }),
    });
  });
  await page.goto(`/people/${residualId}`);
  await page.getByText("Profile maintenance and revision history", { exact: true }).click();
  await page.getByRole("button", { name: "Privacy delete this profile…" }).click();
  await page.getByLabel("Type DELETE PROFILE to confirm").fill("DELETE PROFILE");
  await page.getByRole("button", { name: "Permanently delete this profile" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Profile privacy-deleted" }),
  ).toBeVisible();
  await expect(page.getByText(/Transcript transcript_42 — separate source deletion/)).toBeVisible();
  await expect(
    page.getByText(/Public source source_7 — no separate source deletion is available/),
  ).toBeVisible();
  await page.unroute(`**/api/people/${residualId}/privacy-delete`);
});
