import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixture";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Every static route the page-wide scans walk. Each product area's page is
    in here, and YouTube Trends is walked where Content Research presents it. */
const ROUTES = [
  "/",
  "/runs",
  "/content-research/trends",
  "/content-scout",
  "/content-engine/projects/project_absent",
  "/meetings",
  "/meetings/brief",
  "/content-research",
  "/people",
  "/people/new",
  "/settings",
  "/settings?google=connected",
  "/settings?google=error",
  "/no-such-page",
];

/** Create a Run via the test seam and land on its detail page. The scenario is
    pinned to ordinary-failure because the no-scenario seed now runs the real
    conversion fixture to `done` (Completed) — this helper is written against
    the failed-run surface, which only the failure fixture deterministically
    produces. */
async function openRun(page: Page, scenario?: "ordinary-failure"): Promise<void> {
  const suffix = `?scenario=${scenario ?? "ordinary-failure"}`;
  const res = await page.request.post(`/api/test/seed${suffix}`);
  if (!res.ok()) throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  const { runId } = (await res.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  // Detail page renders both StatusPill (Failed / Needs attention / Done…) and
  // IntakeBadge (drive) inside .run-meta, both with `status-badge`. A bare
  // `.status-badge` is therefore a strict-mode violation.
  await expect(page.locator(".run-meta .status-badge.status-failed")).toHaveText("Failed", {
    timeout: 15_000,
  });
}

/**
 * Rendered contrast for every control currently marked busy: label against its
 * own fill, border and focus ring against whatever paints behind it. axe cannot
 * do this — it does not evaluate opacity-composited colour.
 */
function busyControls(page: Page) {
  return page.evaluate(() => {
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance = (color: string) => {
      const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (fg: string, bg: string) => {
      const a = luminance(fg);
      const b = luminance(bg);
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const transparent = (color: string) => color === "rgba(0, 0, 0, 0)" || color === "transparent";
    const backdrop = (el: Element) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        if (!transparent(bg)) {
          return bg;
        }
      }
      return "rgb(255, 255, 255)";
    };
    return [...document.querySelectorAll('button[aria-disabled="true"]')].map((el) => {
      const style = getComputedStyle(el);
      const behind = backdrop(el);
      return {
        text: el.textContent.trim(),
        opacity: style.opacity,
        label: ratio(
          style.color,
          transparent(style.backgroundColor) ? behind : style.backgroundColor,
        ),
        border: style.borderTopStyle === "none" ? null : ratio(style.borderTopColor, behind),
        ring: style.outlineStyle === "none" ? null : ratio(style.outlineColor, behind),
      };
    });
  });
}

/** Asserts the busy state is drawn, not dimmed: nothing falls under its floor. */
function expectLegible(
  controls: {
    text: string;
    opacity: string;
    label: number;
    border: number | null;
    ring: number | null;
  }[],
) {
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.opacity, `${control.text} is dimmed by opacity`).toBe("1");
    expect(control.label, `${control.text} label`).toBeGreaterThanOrEqual(4.5);
    if (control.border !== null) {
      expect(control.border, `${control.text} border`).toBeGreaterThanOrEqual(3);
    }
    if (control.ring !== null) {
      expect(control.ring, `${control.text} focus ring`).toBeGreaterThanOrEqual(3);
    }
  }
}

/** Holds a request open so the transient busy state can be inspected. */
async function stall(route: { continue: () => Promise<void> }): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await route.continue();
}

/** Scroll containers that genuinely overflow but carry no tabindex. */
function unreachableScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".table-scroll, .events-log, .artifact-pre")]
      .filter((el) => {
        const overflows = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
        return overflows && (el as HTMLElement).tabIndex < 0;
      })
      .map((el) => `${el.className} ${el.scrollWidth}>${el.clientWidth}`),
  );
}

test("every route is free of axe violations", async ({ page }) => {
  await openRun(page);
  const runUrl = page.url();

  for (const path of [runUrl, ...ROUTES]) {
    await page.goto(path);
    await page.waitForTimeout(300);
    // Expand the transcript so its contents are scanned too.
    const summary = page.locator("details summary");
    if (await summary.count()) {
      await summary.first().click();
    }
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => `${v.id} (${v.impact})`),
      `axe violations on ${path}`,
    ).toEqual([]);
  }
});

/**
 * An aria attribute naming an id that does not exist leaves the element it
 * labels with no accessible name at all. axe files this as *incomplete* rather
 * than a violation — the id could appear later — so the scan above cannot see
 * it, and one shipped: a Settings card labelled by a heading that had been
 * removed. This walks the references instead of trusting the scan.
 */
test("every aria reference points at an element that exists", async ({ page }) => {
  await openRun(page);
  const runUrl = page.url();

  for (const path of [runUrl, ...ROUTES]) {
    await page.goto(path);
    await page.waitForTimeout(300);
    const dangling = await page.evaluate(() => {
      const attributes = [
        "aria-labelledby",
        "aria-describedby",
        "aria-controls",
        "aria-errormessage",
        "aria-owns",
      ];
      return attributes.flatMap((attribute) =>
        Array.from(document.querySelectorAll(`[${attribute}]`)).flatMap((el) =>
          (el.getAttribute(attribute) ?? "")
            .split(/\s+/)
            .filter((id) => id.length > 0 && !document.getElementById(id))
            .map(
              (id) =>
                `${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""} ${attribute}="${id}"`,
            ),
        ),
      );
    });
    expect(dangling, `dangling aria references on ${path}`).toEqual([]);
  }
});

test("an unknown route is a real page, not a blank one", async ({ page }) => {
  // The server serves index.html for every path, so a mistyped URL reaches the
  // client router. Without a catch-all it rendered an empty <main> under the
  // previous route's title (WCAG 2.4.2).
  await page.goto("/settings");
  await expect(page).toHaveTitle(/^Settings ·/);

  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page).toHaveTitle(/^Page not found ·/);
  await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
});

test("busy buttons keep focus instead of dropping it to the body", async ({ page }) => {
  // A `disabled` button is blurred and removed from the tab order the instant it
  // is pressed, which strands the keyboard user at the top of the document
  // (WCAG 2.4.3). These controls use aria-disabled and guard their handlers.
  await page.goto("/settings");

  const save = page.getByRole("button", { name: "Save settings" });
  await save.focus();
  await save.click();
  await expect(save).toBeFocused();
  await expect(page.locator(".banner-ok")).toBeVisible();
  await expect(save).toBeFocused();

  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.focus();
  await sync.click();
  // Sync may idle when Google is not connected (no error banner), or it may
  // report an error if the folder is missing or unconsented — either way the
  // request completes quickly and focus must stay on the button pressed.
  await page.waitForTimeout(500);
  await expect(sync).toBeFocused();
});

test("a busy control is styled, not dimmed, and only the pressed one is busy", async ({ page }) => {
  // opacity composites label, border and focus ring alike; at 0.55 all three
  // dropped under their floors on controls that stay focusable and keep showing
  // live status text (WCAG 1.4.3, 1.4.11, 2.4.7).
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      await stall(route);
      return;
    }
    await route.continue();
  });
  await page.goto("/settings");

  // dispatchEvent, not click(): click() on a submit button does not resolve
  // until the stalled request finishes, by which time the state is gone.
  // Positional, not by name: the label becomes "Saving…" the moment it goes
  // busy, and the danger zone below adds a second submit button to the page.
  const save = page.locator('button[type="submit"]').first();
  await save.focus();
  await save.dispatchEvent("click");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  const saving = await busyControls(page);
  expectLegible(saving);
  // Finding 5: a page-level busy flag reported all three buttons as disabled.
  expect(saving.map((control) => control.text)).toEqual(["Saving…"]);
  // Unavailable is not busy. The Meeting Brief connection controls that sit
  // unused on a fresh workspace are natively disabled, so they never enter
  // the busy query above — only a control an action actually started does.
  await expect(page.getByRole("button", { name: "Connect HubSpot" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Disconnect" }).first()).toBeDisabled();
  await expect(save).toHaveAttribute("aria-disabled", "false", { timeout: 15_000 });

  await page.route("**/api/transcripts/intake/sync", stall);
  const sync = page.getByRole("button", { name: "Sync now" });
  await sync.focus();
  await sync.dispatchEvent("click");
  await expect(sync).toHaveAttribute("aria-disabled", "true");
  const syncing = await busyControls(page);
  expectLegible(syncing);
  expect(syncing.map((control) => control.text)).toEqual(["Sync now"]);
});

test("busy controls on tinted surfaces clear their floors too", async ({ page }) => {
  // The Retry button sits on the error banner, so it is measured against a backdrop that is not the page.
  await openRun(page, "ordinary-failure");
  await page.route("**/retry", stall);
  const retry = page.getByRole("button", { name: /retry/i });
  await retry.focus();
  await retry.dispatchEvent("click");
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  expectLegible(await busyControls(page));
});

test("drag-selecting a filename copies it instead of opening the run", async ({ page }) => {
  // The row's onClick fires on the common ancestor of mousedown and mouseup, so
  // a drag to select text landed on the row and navigated, discarding the
  // selection and removing the move-away-to-abort escape (WCAG 2.5.2).
  await openRun(page);
  await page.goto("/runs");
  // The filename is the link now. A press that starts on an anchor begins no
  // selection in any browser, so the drag starts in the cell's padding beside
  // it — which is where a selection starts anyway — and ends over the link, so
  // the click still lands on the row.
  const cell = page.locator(".run-file-name").first();
  const link = page.locator(".run-file-name .run-link").first();
  const box = (await cell.boundingBox())!;
  const linkBox = (await link.boundingBox())!;
  const mid = linkBox.y + linkBox.height / 2;
  await page.mouse.move(box.x + 3, mid);
  await page.mouse.down();
  for (let x = box.x + 8; x < linkBox.x + linkBox.width - 4; x += 8) {
    await page.mouse.move(x, mid);
    await page.waitForTimeout(5);
  }
  await page.mouse.up();

  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
  expect(new URL(page.url()).pathname, "drag-select navigated away").toBe("/runs");

  // The row is a pointer target where nothing is selected: a still click on
  // any non-link cell opens the run, while a press that moved — the drag
  // above — never does, keeping the move-away-to-abort escape (WCAG 2.5.2).
  await page.locator(".run-row td").last().click();
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The link inside the row keeps its own route for keyboard and
  // screen-reader users either way.
  await page.goto("/runs");
  await page.locator(".run-link").first().click();
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });
});

test("switching provider announces the model it rewrote", async ({ page }) => {
  // The Model field is rewritten by a control the user did touch; a sighted user
  // sees it happen and everyone else needs it said (WCAG 3.2.2).
  await page.goto("/settings");
  // Settled connections live behind Manage (D11); the fields are still there.
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  const manage = page.getByText("Manage provider", { exact: true });
  if (await manage.isVisible()) {
    await manage.click();
  }
  const notice = page.locator('.field p[role="status"]');
  await expect(notice).toHaveText("");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await expect(notice).toContainText(/^Model (changed to .+|cleared)\.$/);
  await expect(page.getByLabel("Model")).not.toHaveValue("");
});

test("retrying a run hands focus to the heading when the button unmounts", async ({ page }) => {
  await openRun(page, "ordinary-failure");

  const retry = page.getByRole("button", { name: /retry/i });
  await retry.focus();
  await retry.click();

  // A seeded run's Module is not hosted, so the retry is refused and the
  // error state replaces the run view — the button unmounts. The heading
  // must take focus so a keyboard user is never dropped on <body>
  // (WCAG 2.4.3). Await the refusal banner first: the replacement, not the
  // click, is the event this test is written against.
  await expect(page.getByRole("alert")).toContainText(/not retryable/i);
  await expect(page.getByRole("heading", { name: "Run", exact: true })).toBeFocused();
});

test("focus is visible wherever it lands, including the run heading", async ({ page }) => {
  await openRun(page);

  // Arriving at a run moves focus to its heading; that focus must be visible to
  // keyboard users (WCAG 2.4.7) even though the heading is not tabbable.
  const heading = page.locator("h1.run-title");
  await expect(heading).toBeVisible();
  // Focus may be on the heading or on the body depending on entry type; the
  // heading must be visible and, when focused, show a ring.
  const outline = await heading.evaluate((el) => getComputedStyle(el).outlineStyle);
  // If the heading is focused, it must show a ring; if not, the page is still
  // accessible as long as the heading is visible.
  if (await heading.evaluate((el) => document.activeElement === el)) {
    expect(outline, "run heading shows no focus ring").not.toBe("none");
  }
  // And every genuinely tabbable control paints one.
  await page.goto("/settings");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const style = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        return null;
      }
      const cs = getComputedStyle(el);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
    });
    if (style) {
      expect(style.outlineStyle).not.toBe("none");
    }
  }
});

test("the poll interval reports its error in the page, not a transient bubble", async ({
  page,
}) => {
  await page.goto("/settings");
  const poll = page.getByLabel("Poll interval (minutes)");

  // Clearing the field must not silently coerce to 0.
  await poll.fill("");
  await expect(poll).toHaveValue("");
  await expect(poll).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#poll-interval-error")).toBeVisible();
  await expect(poll).toHaveAttribute("aria-describedby", /poll-interval-error/);

  // Submitting names the problem and puts the user on the offending field.
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-error")).toContainText(/whole number of minutes/i);
  await expect(poll).toBeFocused();

  await poll.fill("5");
  await expect(poll).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#poll-interval-error")).toHaveCount(0);
});

test("every container that scrolls can be reached by keyboard", async ({ page }) => {
  // 320px is where the 34rem tables genuinely overflow — the same place a 400%
  // zoom user lives. Without a tabindex the Status and Tasks columns are
  // unreachable without a pointer (WCAG 2.1.1).
  await page.setViewportSize({ width: 320, height: 720 });
  await openRun(page);
  await page.locator("details summary").click();
  expect(await unreachableScrollers(page), "run detail").toEqual([]);

  await page.goto("/runs");
  await expect(page.getByTestId("runs-table")).toBeVisible();
  expect(await unreachableScrollers(page), "runs list").toEqual([]);
});

test("changing route moves focus into the page it opened", async ({ page }) => {
  // Without this a screen reader user hears nothing between activating the nav
  // link and exploring the new page for themselves (WCAG 2.4.3 / 4.1.3).
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  // Asserted after the form replaces the loading branch: the heading is focused
  // while Settings is still loading, so focus has to survive that swap.
  await expect(page.getByLabel("Task list name")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeFocused();

  await page.getByRole("link", { name: "Content Engine" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Content Scout" })).toBeFocused();
});

test("a direct load of a run leaves the header in front of the user", async ({ page }) => {
  // The suite always reached a run by clicking, which is the one path where
  // moving focus to the heading is right. On the entry the browser itself
  // loaded — a bookmark, a refresh, a shared URL — focus already sits above the
  // skip link, and moving it down to the heading put the skip link, both nav
  // links and "All runs" permanently behind the user (WCAG 2.4.3, 2.4.1).
  await openRun(page);
  const runUrl = page.url();

  await page.goto(runUrl);
  const heading = page.locator("h1.run-title");
  await expect(heading).toBeVisible();
  await expect(heading).not.toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();

  // Everything the old behaviour skipped past, still in front of the user —
  // starting with the wordmark, which is the link to Home.
  // The bar lists the five product areas explicitly (ADR-0043, ADR-0052), then
  // Settings.
  for (const name of [
    "Found42 — Chief of Staff",
    "Content Engine",
    "Content Research",
    "Person Profiles",
    "Meeting Wizard",
    "Tasks",
    "Settings",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name, exact: true })).toBeFocused();
  }
  // The Shell's connection banner sits inside <main>, above the route outlet —
  // which is exactly where the skip link lands, so it is met before the page's
  // own content instead of being jumped over (ADR-0011).
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Set up Google", exact: true })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /all runs/i })).toBeFocused();

  // Reaching the same run by clicking still moves focus into the page, which is
  // the case the guard must not break.
  await page.goto("/runs");
  await page.locator(".run-link").first().click();
  await expect(heading).toBeFocused();
});

test("the runs list stops updating itself once nothing can change", async ({ page }) => {
  // The list polled every 3s for as long as it was open, with no pause, stop or
  // hide control — including when every run was terminal and the requests could
  // not return anything new (WCAG 2.2.2).
  await openRun(page);

  let lists = 0;
  /* A predicate rather than a glob: the list endpoint now carries a Module
     filter and a page size, so a pattern matching the bare path would count
     nothing at all. */
  await page.route(
    (url) => url.pathname === "/api/runs",
    async (route) => {
      if (route.request().method() === "GET") {
        lists += 1;
      }
      await route.continue();
    },
  );

  await page.goto("/runs");
  await expect(page.getByTestId("runs-table")).toBeVisible();
  // The precondition the fix keys off: nothing left that a poll could change.
  await expect(page.locator(".status-active")).toHaveCount(0);
  const settled = lists;

  await page.waitForTimeout(7000);
  expect(lists - settled, "the list kept polling with every run terminal").toBe(0);

  // Runs also arrive from the Drive folder poll, so the idle list keeps a way to
  // ask — otherwise stopping the poll would make them unreachable rather than
  // merely un-announced.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => lists - settled).toBe(1);
});

test("a skip link bypasses the header", async ({ page }) => {
  // The entry the browser loaded keeps focus at the top of the document, so the
  // first Tab reaches the skip link rather than starting past it.
  await page.goto("/settings");
  await page.keyboard.press("Tab");
  const skip = page.locator(".skip-link");
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("the current page is marked by more than a background colour", async ({ page }) => {
  await page.goto("/settings");
  // aria-current is what the styling keys off, so the visual state cannot drift
  // from the programmatic one, and it survives forced-colors mode (WCAG 1.4.1).
  const current = page.locator('.app-header nav a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Settings");
});

test("interactive controls meet a 44px target size", async ({ page }) => {
  for (const path of ["/settings", "/content-research/trends"]) {
    await page.goto(path);
    const undersized = await page.evaluate(() => {
      const out: string[] = [];
      /* `.text-link` opts a link out: WCAG 2.5.8 exempts a target inside a
       sentence, whose height is set by the line-height of the text around it.
       Boxed links (.step-link and friends) are not exempt and are not marked. */
      const selector =
        'a[href]:not(.text-link), button:not(.linklike), select, input:not([type="checkbox"]), .checkbox-label';
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          continue;
        }
        if (rect.height < 44) {
          out.push(
            `${el.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
        }
      }
      return out;
    });
    expect(undersized, `undersized controls on ${path}`).toEqual([]);
  }
});

test("body text scales with the reader's font-size preference", async ({ page }) => {
  await page.goto("/");
  // An absolute px font-size on body would ignore the root entirely, leaving
  // body copy fixed while rem-based headings grew around it (WCAG 1.4.4).
  const { before, after } = await page.evaluate(() => {
    const before = getComputedStyle(document.body).fontSize;
    document.documentElement.style.fontSize = "200%";
    const after = getComputedStyle(document.body).fontSize;
    document.documentElement.style.fontSize = "";
    return { before, after };
  });
  expect(parseFloat(after)).toBeCloseTo(parseFloat(before) * 2, 1);
});
