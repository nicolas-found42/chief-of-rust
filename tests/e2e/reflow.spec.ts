import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

// These scans only read the app. Each parallel worker gets its own hermetic
// Workspace, and each test gets its own browser context and viewport.
// Stateful journey files retain the suite's default serial ordering.
test.describe.configure({ mode: "parallel" });

/**
 * Reflow (WCAG 1.4.10): no route may scroll the page sideways, and no layout
 * may overlap or clip itself, at any window width.
 *
 * The defects this exists to catch were not at the extremes. A flex row that
 * could not shrink broke Settings between 850px and 990px and Transcript review
 * at every width above 650px, while 320px — the width everyone tests — was
 * fine, because the single breakpoint below 640px folded the row and nothing
 * above it did. So the widths below straddle the breakpoint deliberately rather
 * than sampling one phone and one laptop.
 */

/** Every static route, matching the set the a11y scans walk. */
const ROUTES = [
  "/",
  "/runs",
  "/settings",
  "/onboarding",
  "/meetings",
  "/meetings/brief",
  "/meeting-debrief",
  "/content-research",
  "/content-research/trends",
  "/content-scout",
  "/content-engine/projects/project_absent",
  "/people",
  "/people/new",
  "/people/review",
  "/no-such-page",
];

/** 320px is the reflow floor; 650 and 700 are just past the app's only
    breakpoint, where a layout that leans on it has nothing left to fall back
    on; 900 and 1440 are ordinary windows; 1920 proves a wide display cannot be
    relied on to hide a cramped column. */
const WIDTHS = [320, 375, 650, 700, 900, 1024, 1280, 1440, 1920];

type Overflow = { readonly page: number; readonly boxes: readonly string[] };

/**
 * Two questions the DOM can answer directly: does the document scroll
 * sideways, and does any element paint outside the box that lays it out?
 * The second catches an overlap before it grows large enough to move the
 * document, which is how the Settings defect stayed invisible for so long.
 */
function measureOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const boxes: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.clientWidth === 0) continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      /* A container that scrolls is doing its job — .table-scroll holds wide
         tables on purpose. Only a box overflowing visibly is a defect. */
      if (getComputedStyle(el).overflowX !== "visible") continue;
      const name = typeof el.className === "string" ? el.className.trim() : "";
      boxes.push(
        `${el.tagName.toLowerCase()}${name ? `.${name.split(/\s+/).join(".")}` : ""} ` +
          `overflows by ${el.scrollWidth - el.clientWidth}px`,
      );
    }
    return { page: root.scrollWidth - root.clientWidth, boxes };
  });
}

for (const width of WIDTHS) {
  test(`reflow: no sideways scroll or overflowing box at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ROUTES) {
      await page.goto(route);
      /* The shell renders the migration gate until /api/migration/status
         answers, so wait for the real page before measuring it. */
      await expect(page.locator("#main")).toBeVisible();
      await page.waitForLoadState("networkidle");

      const { page: pageOverflow, boxes } = await measureOverflow(page);
      expect(boxes, `${route} at ${width}px`).toEqual([]);
      expect(pageOverflow, `${route} at ${width}px scrolls sideways`).toBe(0);
    }
  });
}

/**
 * The disclosure exists so the tab bar does not cost three rows of a phone's
 * first screen; it is only worth having if it is still operable.
 */
test("reflow: the nav is disclosed below 640px and reachable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await expect(page.locator("#main")).toBeVisible();

  const toggle = page.getByRole("button", { name: "Menu" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("navigation", { name: "Products" })).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();

  /* Following a link closes it: the panel must not stay over the page the tap
     just navigated to. */
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("button", { name: "Menu" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

/** Above the breakpoint the tab bar is the navigation, not a disclosure. */
test("reflow: the nav is always present above 640px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Products" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);
});
