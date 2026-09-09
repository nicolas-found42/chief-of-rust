import { expect, test } from "./fixture";

test("owner onboarding journey — propose → create → confirm → correct → disconnect", async ({
  page,
}) => {
  let googleConnected = true;
  const googleStatus = () => ({
    state: googleConnected ? "connected" : "disconnected",
    email: googleConnected ? "owner-onboarding@example.com" : null,
    redirectUri: "http://127.0.0.1:4319/api/google/callback",
    scopes: [],
    lastConnectedAt: "2026-08-31T12:00:00.000Z",
    expiresAbout: null,
  });
  await page.route("**/api/google/status", async (route) => {
    await route.fulfill({ json: googleStatus() });
  });
  await page.route("**/api/google/disconnect", async (route) => {
    const response = await route.fetch();
    googleConnected = false;
    await route.fulfill({ response });
  });
  const identity = await page.request.post("/api/test/owner-identity", {
    data: { email: "owner-onboarding@example.com" },
  });
  expect(identity.ok()).toBe(true);

  await page.goto("/settings");
  const ownerCard = page.getByRole("group", { name: "Owner Profile" });
  await expect(ownerCard).toContainText("Connected as owner-onboarding@example.com");
  await expect(ownerCard).toContainText("No existing Profile carries this email");
  await expect(ownerCard.getByText("Confirmed", { exact: true })).toHaveCount(0);

  await ownerCard.getByRole("link", { name: "Create one under Person Profiles" }).click();
  await page.getByLabel("Full name").fill("Workspace Owner");
  await page.getByLabel("Primary email").fill("owner-onboarding@example.com");
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page).toHaveURL(/\/people\/person_[0-9a-f]+$/);

  await page.goto("/settings");
  await expect(ownerCard).toContainText("Proposed by the connected email: Workspace Owner");
  await ownerCard.getByRole("button", { name: "Confirm owner Profile" }).click();
  await expect(ownerCard).toContainText("Confirmed — Profile Workspace Owner (revision 1)");

  const status = await page.request.get("/api/onboarding/owner");
  expect(status.ok()).toBe(true);
  expect(await status.json()).toMatchObject({
    confirmed: {
      profileRevision: 1,
      confirmedForGoogleEmail: "owner-onboarding@example.com",
    },
  });

  const changed = await page.request.post("/api/test/owner-identity", {
    data: { email: "corrected-owner@example.com" },
  });
  expect(changed.ok()).toBe(true);
  await page.reload();
  await expect(ownerCard.getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(ownerCard).toContainText("Connected as corrected-owner@example.com");
  await ownerCard
    .getByLabel("Owner Profile")
    .selectOption({ label: "Workspace Owner — owner-onboarding@example.com" });
  await ownerCard.getByRole("button", { name: "Confirm owner Profile" }).click();
  await expect(ownerCard).toContainText("Confirmed — Profile Workspace Owner (revision 1)");

  await page.getByText("Manage Google connection").click();
  await page
    .getByRole("group", { name: "Google" })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(ownerCard.getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(ownerCard).toContainText("Connect a Google account to propose the owner Profile.");
});
