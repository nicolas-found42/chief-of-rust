import { expect, test } from "./fixture";

/**
 * The post-cutover product boundary (#143 AC 5).
 *
 * The consolidation (ADR-0043) deliberately removed whole product surfaces
 * instead of deprecating them: "There is no old-route compatibility" (consolidation
 * spec § Migration and Cutover; ADR-0044, ADR-0045). A stale bookmark must land
 * on the Shell's normal not-found page, never on a deprecated route that 200s
 * forever or on a blank <main> (WCAG 2.4.2). This spec enumerates every retired
 * product route — each verified against the route table of the revision that
 * removed it (`git show <sha>:apps/web/src/App.tsx`) — and proves the positive
 * side of the same boundary: the four product areas (ADR-0043), the Shell's
 * Runs list, and Settings are all reachable.
 */
const RETIRED_ROUTES = [
  // #142 retired the founding Module: existed at 169ab77~1, gone at 066d2b0 (ADR-0045).
  "/transcript",
  // #142 retired the remaining Idea Engine surfaces: existed at 9cd2bb3~1, gone at 169ab77
  // (ADR-0043 rejected "retain as a legacy mode").
  "/idea-engine",
  // #135 presented YouTube Trends under Content Research: existed at 9cd2bb3~1,
  // gone at 3e6efc9 (ADR-0044 — "/youtube is gone, not deprecated").
  "/youtube",
  // #136 built the Meeting Wizard around /meetings: /meeting-brief existed at
  // 3e6efc9 (and earlier — cba05ec introduced it), gone at ab8c761 (App.tsx
  // comment: "the legacy /meeting-brief product route is gone — not-found").
  "/meeting-brief",
  // Content Scout's pre-consolidation page: existed at 4d686b4~1, replaced by
  // the Content Scout UI at 4d686b4 (issue #92 movement).
  "/hot-take",
  // Prototype-era leftovers, retired before the Module program: /prototype/home
  // existed only at 75b227d, gone by 353dc06; /setup and /artifacts existed in
  // the pre-rebuild app (d9b9b8b, 4340231), gone at the rebuild reset d6b72da.
  // None matches any current route, so all prove the same catch-all.
  "/prototype/home",
  "/setup",
  "/artifacts",
];

test("every retired product route falls to the Shell's normal not-found", async ({ page }) => {
  for (const route of RETIRED_ROUTES) {
    // The server serves index.html for every path, so this reaches the client
    // router's catch-all (a11y.spec "an unknown route is a real page, not a
    // blank one"). Assert the full not-found surface — heading, copy, and the
    // way home — so a blank <main> or an empty 200 cannot pass.
    await page.goto(route);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
      `${route} must render the Shell's not-found page`,
    ).toBeVisible();
    await expect(page).toHaveTitle(/^Page not found ·/);
    await expect(
      page.getByText("That address doesn’t match a run or a settings page."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
  }
});

test("the complete product surface is reachable — five areas, Shell Runs, Settings", async ({
  page,
}) => {
  await page.goto("/");

  // The nav bars are the explicit product map (ADR-0043: "Product navigation
  // is therefore explicit rather than derived from the Module registry"):
  // exactly five top-level product areas, then Settings. There is no Modules
  // bar any more — the registry is not a navigation contract.
  const productsNav = page.locator('nav[aria-label="Products"]');
  await expect(productsNav.getByRole("link")).toHaveCount(5);
  await expect(page.locator('nav[aria-label="Modules"]')).toHaveCount(0);
  for (const [name, href] of [
    ["Content Engine", "/content-scout"],
    ["Content Research", "/content-research"],
    ["Person Profiles", "/people"],
    ["Meeting Wizard", "/meetings"],
    ["Tasks", "/tasks"],
  ] as const) {
    await expect(
      productsNav.getByRole("link", { name }),
      `${name} must be a nav area`,
    ).toHaveAttribute("href", href);
  }
  await expect(
    page.locator('nav[aria-label="Settings"]').getByRole("link", { name: "Settings" }),
  ).toHaveAttribute("href", "/settings");

  // Each product area answers with its own page, not just a link. Shell Runs
  // has no tab by design (ADR-0014: a Shell page, not a Module tab) — Home's
  // feed links into it — so its reachability is proven by the h1 it serves.
  for (const [route, heading] of [
    ["/content-scout", "Content Scout"],
    ["/content-research", "Content Research — what is resonating, for whom, and why"],
    ["/meetings", "Meeting Wizard"],
    ["/people", "Person Profiles"],
    ["/tasks", "Tasks"],
    ["/runs", "All runs"],
    ["/settings", "Settings"],
  ] as const) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { level: 1 }),
      `${route} must render its page heading`,
    ).toHaveText(heading);
  }
});
