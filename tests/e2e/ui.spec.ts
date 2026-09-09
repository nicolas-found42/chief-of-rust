import { expect, serverPort, test } from "./fixture";
import AxeBuilder from "@axe-core/playwright";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

test("Drive folder is the only Intake; Runs list and Drive settings are visible", async ({
  page,
}) => {
  await page.goto("/runs");
  // Upload dropzone is gone — Drive folder is the sole Intake
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All runs" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript intake" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Choose folder/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("settings round-trips with redacted secrets", async ({ page }) => {
  await page.goto("/settings");
  // Exact: "Provider API key" and the "Extraction provider" group also
  // contain the substring "Provider".
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("mock");

  // Secrets are never echoed back: every password input is empty.
  const secretValues = await page
    .locator('input[type="password"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(secretValues.length).toBeGreaterThan(0);
  expect(secretValues.every((value) => value === "")).toBe(true);

  const manage = page.getByText("Manage provider", { exact: true });
  if (await manage.isVisible()) await manage.click();
  await page.getByLabel("Research evaluation judge", { exact: true }).fill("independent-judge");
  await page
    .getByLabel("Person evidence extraction and identity", { exact: true })
    .fill("research-extractor");
  await page.getByLabel("Task list name").fill("E2E Followups");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".banner-ok")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Research evaluation judge", { exact: true })).toHaveValue(
    "independent-judge",
  );
  await expect(
    page.getByLabel("Person evidence extraction and identity", { exact: true }),
  ).toHaveValue("research-extractor");

  await page.reload();
  await expect(page.getByLabel("Task list name")).toHaveValue("E2E Followups");
  await expect(page.getByText("Not connected", { exact: false })).toBeVisible();
});

test("Ollama is an advanced choice, and OpenRouter is the recommendation", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Connections" }).waitFor();
  const manage = page.getByText("Manage provider", { exact: true });
  if (await manage.isVisible()) {
    await manage.click();
  }
  const provider = page.getByLabel("Provider", { exact: true });
  /* Issue #198: OpenRouter leads the choices as the recommendation, and this
     test-mode server is one of the two places mock may appear at all. */
  await expect(provider.locator("option").first()).toHaveText("OpenRouter (recommended)");
  await expect(provider.getByRole("option", { name: /^mock/ })).toHaveCount(1);
  /* Ollama is not offered beside the cloud providers; it lives under Advanced. */
  await expect(provider.getByRole("option", { name: /Ollama/ })).toHaveCount(0);
  await page.getByText("Advanced local-model settings", { exact: true }).click();
  await page.getByRole("button", { name: "Use Ollama (local model)" }).click();
  await expect(provider).toHaveValue("ollama");
  await expect(page.getByLabel("Ollama base URL")).toBeVisible();
  /* Leave the shared Workspace's form state as it was found. */
  await provider.selectOption("mock");
  await expect(provider).toHaveValue("mock");
});

test("an unconfigured workspace gets the setup wizard, not two bare fields", async ({ page }) => {
  await page.goto("/settings");

  // Seven steps, in the order the console forces them (ADR-0013 froze the
  // sequence), rendered as a wizard: progress visible, exactly one step open.
  const steps = page.locator(".setup-steps > li");
  const toggle = (index: number) => steps.nth(index).locator("button.wizard-step-toggle");
  await expect(steps).toHaveCount(7);
  await expect(page.locator(".wizard-progress")).toHaveText("Step 1 of 7");
  await expect(toggle(0)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Create a project", exact: true })).toBeVisible();

  // Moving on collapses the walked-past step to a ✓ line and opens one more.
  await toggle(1).click();
  await expect(page.locator(".wizard-progress")).toHaveText("Step 2 of 7");
  await expect(toggle(0)).toHaveAttribute("aria-expanded", "false");
  await expect(steps.nth(0)).toHaveClass(/done/);
  await expect(page.getByRole("link", { name: "Enable the Tasks API", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a project", exact: true })).toHaveCount(0);

  // The scopes step carries its exact values, each offered to copy so none has
  // to be typed out. YouTube joined them under ADR-0016, which is the one real
  // cost of that decision: every existing connection consents once more.
  // Gmail send joined them for the Meeting Brief owner-only auto-send
  // (ADR-0034), with the same consent cost.
  // Google Tasks is not among them: it is the one optional surface, asked for
  // only once the owner enables it as a Task Destination (issue #184).
  await toggle(4).click();
  await expect(page.locator(".setup-copy > code")).toHaveText([
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
  await expect(page.locator(".copy-button")).toHaveCount(6);
  await expect(
    page.getByRole("button", { name: "Copy https://www.googleapis.com/auth/tasks", exact: true }),
  ).toHaveCount(0);

  // The redirect URI is built from the port the server is actually on, so a
  // value hardcoded to another port — as the UI used to carry — fails here.
  await toggle(5).click();
  await expect(page.locator(".setup-copy > code")).toHaveText([
    `http://localhost:${serverPort}/api/google/callback`,
  ]);
  await expect(page.getByRole("button", { name: "Copy Redirect URI", exact: true })).toBeVisible();

  // The credential step is the last, and its sign-in button is Google-branded.
  await toggle(6).click();
  await expect(page.getByRole("button", { name: /Save and sign in with Google/ })).toBeVisible();
});

test("signing in without a client id reports Google's refusal in the page", async ({ page }) => {
  await page.goto("/settings");

  // Credential fields live in the last wizard step (ADR-0013); open it first
  // (steps are collapsed by default, only step 0 open). The previous layout
  // kept them always visible, so the test failed when they moved.
  const steps = page.locator(".setup-steps > li");
  const last = steps.last().locator("button.wizard-step-toggle");
  await last.click();
  // Pressing sign-in with nothing filled in saves an empty client and asks the
  // server for a consent URL, which it refuses. That refusal has to land as
  // readable text, not a console error (WCAG 3.3.1).
  const signIn = page.getByRole("button", { name: /Save and sign in with Google/ });
  await signIn.focus();
  await signIn.click();
  // The wording is the connection's own (googleFailureHint), so the refusal the
  // user reads here is the same sentence a Run shows when it fails for this state.
  await expect(page.locator(".banner-error")).toContainText(/not set up/i);
  await expect(page.locator(".banner-error")).toContainText(/Settings/);
  // The control the user pressed keeps focus rather than dropping it (WCAG 2.4.3).
  await expect(signIn).toBeFocused();
});

test("the Shell says Google is not set up on every page, and not on Settings", async ({ page }) => {
  // The banner used to belong to the runs page, so it reached the one Module
  // that happened to own `/` and nowhere else. Scoped to the Shell's own live
  // region, because the Settings card renders warnings of its own.
  const shellBanner = page.locator('main > [role="status"] .banner-warn');

  for (const path of ["/", "/runs", "/content-scout"]) {
    await page.goto(path);
    // Shell vocabulary: Tasks and Gmail are Google surfaces, where the old
    // string named Transcript's own pipeline stages.
    await expect(shellBanner, `banner on ${path}`).toContainText(
      "Google is not set up, so nothing can be created in Tasks or Gmail.",
    );
    // The footer is the other piece of Shell chrome on every page, and it has
    // to name the one shipped exception to draft-only (ADR-0034) or it tells
    // the person something untrue about a Module they can turn on.
    await expect(page.locator(".app-footer"), `footer on ${path}`).toContainText(
      "mail is never sent — except Meeting Briefs, which go only to your connected account",
    );
  }

  // Absent on Settings, where it would sit directly above a card that says the
  // same thing in detail. The region itself stays mounted — a live region that
  // unmounts re-announces itself on the next navigation.
  await page.goto("/settings");
  await expect(shellBanner).toHaveCount(0);
  await expect(page.locator('main > [role="status"]')).toHaveCount(1);

  // And it routes to the place that fixes it.
  await page.goto("/");
  await shellBanner.getByRole("link", { name: "Set up Google" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".setup-steps")).toBeVisible();
});

test("primary actions are reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/runs");

  // Drive is the only Intake — no upload button, but the page still has a heading and a way to check
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All runs" })).toBeVisible();
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator("h1.run-title")).toBeVisible();
  // Each route carries its own title, suffixed with the Shell's name — not with
  // the name of a Module, which is what this used to say.
  await expect(page).toHaveTitle(/· Chief of Staff$/);

  // Runs are reachable from the list without a pointer.
  await page.goto("/runs");
  // The seeded Run is the keyboard subject: its fixture writes
  // transcript.txt, so Files exists to exercise once the disclosure opens.
  const runLink = page.locator(`.run-link[href="/runs/${runId}"]`);
  await expect(runLink).toBeVisible();
  await runLink.press("Enter");
  await page.waitForURL(/\/runs\/run_/, { timeout: 15_000 });

  // The capped-height log can be scrolled from the keyboard, and the Run's
  // files stay plain links under "Files" — native links, so keyboard users
  // reach and open them like every other control. The transcript-module
  // pre-block they replaced is retired (issue #142).
  await expect(page.locator(".events-log")).toHaveAttribute("tabindex", "0");
  await page.locator("details summary").click();
  const fileLink = page.locator(".run-files a").first();
  await expect(fileLink).toBeVisible();
  await fileLink.focus();
  await expect(fileLink).toBeFocused();
});

test("the page never scrolls sideways at a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/", "/runs", "/settings"]) {
    await page.goto(path);
    const overflows = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth > root.clientWidth + 1;
    });
    expect(overflows, `${path} scrolls horizontally at 320px`).toBe(false);
  }
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Settings & Health" }).click();
  const contentScoutOverflows = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth + 1;
  });
  expect(contentScoutOverflows, "Content Scout Settings scrolls horizontally at 320px").toBe(false);
});

test("Content Scout Settings exposes safe cleanup and non-color runtime health", async ({
  page,
}) => {
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Settings & Health" }).click();

  await expect(page.getByRole("heading", { name: "Storage & retention" })).toBeVisible();
  await expect(page.getByText("Durable records", { exact: true })).toBeVisible();
  await expect(page.getByText("Retained evidence transcripts", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "External runtimes" })).toBeVisible();
  await expect(page.getByText(/browser\.chromium: Available/)).toBeVisible();
  await expect(page.getByText(/python\.pyktok: Unsupported/)).toBeVisible();

  const preview = page.getByRole("button", { name: "Preview temporary cleanup" });
  await preview.focus();
  await preview.press("Enter");
  await expect(page.getByText("Temporary-data cleanup preview is ready.")).toBeVisible();
  await expect(page.getByText("Nothing is eligible for temporary-data cleanup.")).toBeVisible();
  await expect(preview).toBeFocused();
  await expect(page.getByRole("button", { name: /Delete .*expired temporary/ })).toHaveCount(0);
});

test("the front door is Home, and the Shell's runs list lives at /runs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  // Titled after the Shell with no suffix, so opening the most-visited route
  // never re-titles the tab (WCAG 2.4.2 is satisfied by the app's own name).
  await expect(page).toHaveTitle("Chief of Staff");

  // Home loads provider + runs async (shows Loading… first). Wait for the
  // sentence that only exists after both resolve.
  await expect(page.locator(".home-sentence")).toBeVisible();

  // A status surface, not a Module's page in different chrome: Intake and the
  // runs table stay with the pages that own them.
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toHaveCount(0);

  // No assertion that "Recent activity" is absent: ADR-0014 revised ADR-0010 and
  // gives Home exactly that feed, so its presence is the contract, not a leak.
  // Whether it renders depends on whether finished Runs exist, which the shared
  // hermetic server makes order-dependent — so the front-door contract pinned
  // here is the absence of Module-owned Intake and tables, which is invariant.

  // Ticket 12 honesty rule: with Google disconnected the Runs page stays
  // silent about watching — no liveness line, no stale promise.
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All runs");
  await expect(page.getByTestId("intake-liveness")).toHaveCount(0);

  // One card per product area, from the same explicit list the header nav
  // renders (productAreas.ts; ADR-0043), so the two cannot disagree about
  // what exists. Counted by role rather than by the layout's class names,
  // which are the bento's business and not a contract.
  await page.goto("/");
  await expect(page.locator(".home-sentence")).toBeVisible();
  /* The product tiles, not every h3 in main: the Home work card carries its
     own group headings at the same level (issue #192). */
  const tiles = page.locator("main#main .module-grid").getByRole("heading", { level: 3 });
  await expect(tiles).toHaveCount(5);
  await expect(tiles.filter({ hasText: "Content Engine" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Content Research" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Person Profiles" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Meeting Wizard" })).not.toContainText("Planned");
  await expect(tiles.filter({ hasText: "Tasks" })).not.toContainText("Planned");

  /* The card links bind to the product grid, not all of main: a finished
     scheduled Run can land a feed link naming the same area ("Content
     Research daily"), and a main-scoped role query cannot tell them apart. */
  const areaTiles = page.locator(".module-grid");
  for (const [label, path] of [
    ["Content Engine", "/content-scout"],
    ["Content Research", "/content-research"],
    ["Person Profiles", "/people"],
    ["Meeting Wizard", "/meetings"],
    ["Tasks", "/tasks"],
  ] as const) {
    await expect(areaTiles.getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  // The header nav carries exactly the five product areas (spec: Navigation
  // and onboarding #1; ADR-0043, ADR-0052) — explicit, never derived from the
  // Module registry — so there is no Modules bar to enumerate.
  const productsNav = page.locator('.app-header nav[aria-label="Products"]');
  await expect(productsNav.getByRole("link")).toHaveCount(5);
  await expect(page.locator('.app-header nav[aria-label="Modules"]')).toHaveCount(0);
  for (const [label, path] of [
    ["Content Engine", "/content-scout"],
    ["Content Research", "/content-research"],
    ["Person Profiles", "/people"],
    ["Meeting Wizard", "/meetings"],
    ["Tasks", "/tasks"],
  ] as const) {
    await expect(productsNav.getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  await areaTiles.getByRole("link", { name: "Content Engine" }).click();
  await expect(page).toHaveURL(/\/content-scout$/);
  // Dropzone is gone — Drive folder is the Intake. And a Module's page is not
  // a Runs surface any more: with Transcript → Tasks retired (#142) the
  // Shell's cross-Module list at /runs is the only Runs list there is, so
  // nothing here renders a table of its own Runs.
  await expect(page.getByTestId("dropzone")).toHaveCount(0);
  await expect(page.getByTestId("runs-table")).toHaveCount(0);
  await page.getByRole("link", { name: "Found42 — Chief of Staff" }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
});

test("the Shell lists every Module's runs, and a Module's page lists only its own", async ({
  page,
}) => {
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);

  // The cross-Module list is a Shell page, reached by route rather than by tab:
  // a Runs tab would be the bar's first entry that is not a Module (ADR-0014).
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "All runs" })).toBeVisible();
  await expect(page.getByTestId("runs-table")).toBeVisible();
  await expect(page.locator(".runs-table thead")).toContainText("Module");
  // An Intake's name is a Module's private vocabulary, so it is not a column here.
  await expect(page.locator(".runs-table thead")).not.toContainText("Source");
  await expect(page.getByRole("navigation", { name: "Products" })).not.toContainText("runs");

  /* Transcript → Tasks was the last Module with a Runs page of its own, and
     it is retired (issue #142). The cross-Module list is now the only Runs
     list there is, so what remains to assert is that it is complete and
     Module-attributed rather than that it differs from a per-Module one. */

  // A Run's detail page is the Shell's half — the stage timeline, events and
  // files — with a Module's own view only when its Module contributes one.
  // The seed-fixture Module contributes none, and Transcript → Tasks (whose
  // ResultView drew the receipt) is retired (#142): "What happened" and the
  // timeline are the tail every Run carries.
  await page.locator(".run-link").first().click();
  await page.waitForURL(/\/runs\/run_/);
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.locator(".timeline-row").first()).toBeVisible();
});

test("partial Content Scout diagnostics stay visible and accessible", async ({ page }) => {
  const profile = await page.request.post("/api/content-scout/brand-profile", {
    data: {
      markdown: "# Brand Profile\n\n## Positioning\nPractical, evidence-led guidance.\n",
      websiteUrl: "https://company.example",
    },
  });
  expect(profile.ok()).toBe(true);
  for (const source of [
    {
      adapterId: "rss",
      label: "Available feed",
      url: "https://available.example/feed.xml",
    },
    {
      adapterId: "instagram",
      label: "Experimental public account",
      url: "https://instagram.example/public-account",
    },
  ]) {
    const response = await page.request.post("/api/content-scout/sources", { data: source });
    expect(response.ok()).toBe(true);
  }
  const started = await page.request.post("/api/content-scout/run");
  expect(started.ok()).toBe(true);
  const { runId } = (await started.json()) as { runId: string };
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/runs/${runId}`);
      return ((await response.json()) as { status: string }).status;
    })
    .toBe("blocked");

  await page.goto("/content-scout");
  const warning = page.locator(".banner-warn", { hasText: "Collection is degraded" });
  await expect(warning).toContainText("instagram response shape change");
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

  await warning.getByRole("link", { name: "Open diagnostics" }).click();
  await expect(page.getByRole("heading", { name: "Content Scout receipt" })).toBeVisible();
  const table = page.getByRole("table", { name: "Source Adapter summary" });
  await expect(table.getByRole("columnheader", { name: "Error classifications" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Last successful request" })).toBeVisible();
  const attempts = page.getByText("instagram Source Adapter attempt receipts", { exact: true });
  await attempts.click();
  await expect(page.getByText("embedded_public_data", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/^expected_public_evidence_missing \(cause 1, sha256:/),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
});

test("Content Scout goes from bounded Brand Profile scan to a started Content Project", async ({
  page,
}) => {
  await page.request.post("/api/test/owner-identity", {
    data: { email: "owner-onboarding@example.com" },
  });
  const peopleResponse = await page.request.get("/api/people");
  const people = (await peopleResponse.json()) as { id: string; emails: string[] }[];
  let owner = people.find((profile) => profile.emails.includes("owner-onboarding@example.com"));
  if (!owner) {
    const created = await page.request.post("/api/people", {
      data: { fullName: "Workspace Owner", primaryEmail: "owner-onboarding@example.com" },
    });
    expect(created.ok()).toBe(true);
    owner = (await created.json()) as { id: string; emails: string[] };
  }
  const confirmation = await page.request.post("/api/onboarding/owner/confirm", {
    data: { profileId: owner.id },
  });
  expect(confirmation.ok()).toBe(true);
  await page.goto("/content-scout");
  await expect(page.getByRole("heading", { level: 1, name: "Content Scout" })).toBeVisible();

  await page.getByRole("button", { name: "Brand Profile" }).click();
  await page.getByLabel("Company website URL").fill("https://company.example/");
  await page.getByRole("button", { name: "Scan website" }).click();
  await expect(page.getByRole("heading", { name: "Review website evidence" })).toBeVisible();
  await expect(
    page.getByText("Depth 1 · https://company.example/blog", { exact: false }),
  ).toContainText("Default transient");
  await page.getByRole("button", { name: /^Accept \d+ selected sections?/ }).click();
  await expect(page.getByText(/^Current revision brand_/)).toBeVisible();

  // The scan Run's detail page renders its receipt: a brand-profile-scan
  // result carries evidence counts, not the discovery adapter table, and
  // rendering it through the discovery shape once blanked the whole app.
  await page.goto("/runs");
  await page
    .getByRole("link", { name: /Content Scout Brand Profile proposal/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Content Scout receipt" })).toBeVisible();
  await expect(page.getByText(/pages crawled/)).toContainText("included in the evidence");
  await page.goto("/content-scout");
  await page.getByRole("button", { name: "Sources" }).click();
  await page.getByLabel("Source Adapter").selectOption("rss");
  await page.getByLabel("Name").fill("Example Research");
  await page.getByLabel("Recurring public URL").fill("https://example.com/research.xml");
  await page.getByRole("button", { name: "Approve source" }).click();
  await expect(page.getByRole("cell", { name: "Example Research", exact: false })).toBeVisible();

  /* The Run this journey creates is asserted by id: earlier journeys leave
     content-scout state behind, so global shortlist/run patterns do not hold. */
  const scoutStarted = await page.request.post("/api/content-scout/run");
  expect(scoutStarted.ok()).toBe(true);
  const { runId } = (await scoutStarted.json()) as { runId: string };
  await expect
    .poll(async () => {
      const state = (await (await page.request.get("/api/content-scout")).json()) as {
        shortlist: { runId: string; opportunities: { state: string }[] } | null;
      };
      return (
        state.shortlist?.runId === runId &&
        state.shortlist.opportunities.some((opportunity) => opportunity.state === "ready")
      );
    })
    .toBe(true);
  /* Shortlist is the default view on /content-scout. */
  await page.goto("/content-scout");
  await expect(page.getByText("Explain what the verified change means in practice")).toBeVisible();
  await page.getByRole("checkbox", { name: /Explain what the verified change/ }).check();
  /* Selecting an Opportunity starts one governed Content Project — with the
     Project's own required inputs, and nothing generated at selection time. */
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
  const projectCard = page.getByRole("heading", { name: "Projects started" });
  await expect(projectCard).toBeVisible();
  const projectBadge = page.locator("code", { hasText: /^project_/ });
  await expect(projectBadge).toBeVisible();
  const projectId = await projectBadge.textContent();
  expect(projectId).toMatch(/^project_/);

  /* Contract, asserted on this journey's own Run by id: the selection started
     exactly one governed Content Project carrying the Opportunity, and the Run
     holds no pack or Notion residue. The Run itself ends done when no Ready
     opportunity remains and blocked otherwise — either is contract-true. */
  const detail = (await await page.request.get(`/api/runs/${runId}`).then((r) => r.json())) as {
    status: string;
    result: {
      projects: { opportunityId: string; projectId: string; created: boolean }[];
    } | null;
    files: string[];
  };
  expect(["done", "blocked"]).toContain(detail.status);
  expect(detail.result?.projects).toEqual([
    { opportunityId: expect.any(String), projectId, created: true },
  ]);
  expect(detail.files.filter((file) => /notion|^draft-/i.test(file))).toEqual([]);
});

test("Content Research presents YouTube Trends, and the trends page refuses a bad paste while you are looking at it", async ({
  page,
}) => {
  // The journey starts where the product puts it: under Content Research.
  await page.goto("/content-research");
  await page.getByRole("link", { name: "YouTube Trends" }).click();
  await expect(page).toHaveURL(/\/content-research\/trends$/);
  await expect(page.getByRole("heading", { level: 1, name: "YouTube Trends" })).toBeVisible();
  // Before there is any data the tab says what will happen, rather than showing
  // an empty screen with no explanation.
  const empty = page.locator(".card", { hasText: "No channels yet" });
  await expect(empty).toContainText("checked against YouTube straight away");

  // The legacy custom-URL form is refused with the forms that work — Google
  // publishes no route from it to a channel id, and the search fallback would
  // make the Module fragile in a way invisible until it tracked the wrong
  // channel.
  await page.getByLabel("Channel URL").fill("https://www.youtube.com/c/Found42");
  await page.getByRole("button", { name: "Add channel" }).click();
  const refusal = page.locator(".field-error");
  await expect(refusal).toContainText("youtube.com/@name");
  await expect(refusal).toContainText("youtube.com/channel/UC");

  // A well-formed address gets as far as Google, which this workspace has not
  // connected — and the refusal is the connection's own wording, the same
  // sentence a Run shows for the same state.
  await page.getByLabel("Channel URL").fill("https://www.youtube.com/@found42");
  await page.getByRole("button", { name: "Add channel" }).click();
  await expect(refusal).toContainText(/not set up/i);

  // And a manual run with nothing to measure says so rather than recording an
  // empty day.
  await page.getByRole("button", { name: "Record today" }).click();
  await expect(page.locator(".banner-error")).toContainText("Add a channel first");

  // The spreadsheet is created from the Module's own settings surface, not by
  // the first Run: a link buried in a Run record scrolls out of Home's feed.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "YouTube Trends" })).toBeVisible();
  const create = page.getByRole("button", { name: "Create the spreadsheet" });
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.locator("section:has(#section-youtube) .field-error")).toContainText(
    /not set up/i,
  );
});

test("Home enumerates what needs doing, and the rail itemises it", async ({ page }) => {
  // Guarantees one failed Run whatever ran before this: the ordinary-failure
  // fixture creates a Run that fails at extract with the genuine-failure
  // wording, and carries no connection flag — it is not an expiry story.
  const seed = await page.request.post("/api/test/seed?scenario=ordinary-failure");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };
  await page.goto(`/runs/${runId}`);
  await expect(page.locator(".run-meta .status-badge.status-failed")).toHaveText("Failed", {
    timeout: 15_000,
  });
  await expect(page.locator(".run-meta")).toContainText("Failed during");
  await expect(page.locator(".run-meta")).not.toContainText("Stopped during");
  // The fixture carries no connection flag, so the banner is the
  // genuine-failure kind and the way out is Retry, not Reconnect: retryable
  // (failed at extract, never convert) and showRetry (nothing reconnectable
  // to wait for) are both true here. Reconnect belongs to connection-flagged
  // failures, covered by the sign-in refusal and the meeting journeys.
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator(".timeline-row .status-failed")).toHaveText("Failed");
  await page.goto("/");
  // One clause per rail condition, in the rail's order, with the true total of
  // failures rather than the number of rows shown. No "Nothing needs you." —
  // there plainly is.
  await expect(page.locator(".home-sentence")).toHaveText(
    /^\d+ runs? failed, and the extraction provider is a stand-in\.$/,
  );

  // The rail is labelled for heading navigation even though the label is not
  // drawn: a sighted reader takes it from the sentence above.
  await expect(page.getByRole("heading", { level: 2, name: "Needs your attention" })).toHaveCount(
    1,
  );

  // The provider row carries the consequence and the way out, which is what the
  // sentence deliberately leaves out — and it claims nothing about what
  // extraction would have produced, since that is a Module's stage.
  const mockRow = page.locator(".home-rail-row", { hasText: "mock provider" });
  await expect(mockRow).toContainText(
    "Runs are using the mock provider, so nothing real is extracted",
  );
  await expect(mockRow.getByRole("link", { name: "Choose a provider" })).toHaveAttribute(
    "href",
    "/settings",
  );

  // This workspace was never configured; that is not the expected weekly
  // expiry, so its Run retains the genuine-failure treatment and opens the
  // diagnostic instead of offering the expiry-specific reconnect action.
  const failedRow = page.locator(".home-rail-row", {
    has: page.locator(`a[href="/runs/${runId}"]`),
  });
  await expect(failedRow).toContainText("failed");
  await expect(failedRow.getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    `/runs/${runId}`,
  );
});

test("conversion failures show separate person guidance and shape-only diagnostics", async ({
  page,
}) => {
  const seed = await page.request.post("/api/test/seed?scenario=conversion-failure");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };

  await page.goto(`/runs/${runId}`);
  await expect(page.locator(".banner-error")).toContainText(
    "This file is corrupt or does not match its format. Replace or repair the file.",
  );
  await page.getByText("Technical details", { exact: true }).click();
  const events = page.locator(".events-log");
  await expect(events).toContainText('"classification":"invalid_file"');
  await expect(events).toContainText('"format":"json"');
  await expect(events).toContainText('"step":"parse_json"');
  await expect(events).toContainText('"bytes":28');
  await expect(page.locator("body")).not.toContainText("PRIVATE TRANSCRIPT MARKER");
});

test("Home reflows to one column, and a connected workspace says whose it is", async ({ page }) => {
  // The connection this workspace does not have, answered at the API rather
  // than stored: the tests above and below expect a workspace with no Google
  // credentials, and a stub leaves it that way.
  await page.route("**/api/google/status", async (route) => {
    await route.fulfill({
      json: {
        state: "connected",
        email: "owner@example.com",
        redirectUri: "http://127.0.0.1:4319/api/google/callback",
        scopes: [],
        lastConnectedAt: new Date().toISOString(),
        expiresAbout: null,
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  // Identity only, and only when connected — the expiry warning is the Shell
  // banner's job (ADR-0011). How it is drawn is design judgement; that it is
  // said is the contract.
  await expect(page.getByText("Google connected as owner@example.com")).toBeVisible();

  // Two columns where they fit, one where they do not. Asserted as tracks
  // rather than pixels: what reflow owes the reader is a single column, not a
  // particular width (WCAG 1.4.10). The 320px test above already covers the
  // other half — that nothing clips or scrolls sideways once it collapses.
  const tracks = () =>
    page
      .locator(".home-grid")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(await tracks()).toBe(2);
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await tracks()).toBe(1);

  // And it collapses attention-first. In one column the page is read top to
  // bottom, so the rail above the tiles is the difference between meeting what
  // needs you and scrolling past four Modules to find it.
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  await page.goto("/");
  const rail = await page.locator(".home-rail-card").boundingBox();
  const tiles = await page.locator(".module-grid").boundingBox();
  expect(rail, "attention rail").not.toBeNull();
  expect(tiles, "module tiles").not.toBeNull();
  expect(rail!.y).toBeLessThan(tiles!.y);
});

/* Last in the file, and it puts the workspace back: it is the only test here
   that stores Google credentials, and everything above expects a workspace with
   none. */
test("credentials saved but no successful sign-in keeps the steps on the page", async ({
  page,
}) => {
  // Where a beginner lands when the first sign-in fails — a wrong redirect URI,
  // an API left disabled, or closing the consent screen. The connection reads
  // `disconnected`, exactly like a deliberate sign-out, and this used to
  // collapse every instruction behind a "Change the OAuth client" summary at
  // precisely the moment they were needed.
  await page.request.put("/api/config", {
    data: {
      google: {
        clientId: "000000000000-onboarding.apps.googleusercontent.com",
        clientSecret: "not-a-real-secret",
      },
    },
  });

  try {
    await page.goto("/settings");

    await expect(page.locator(".setup-steps > li")).toHaveCount(7);
    // Open on the page, not behind a Manage summary (D11), and not collapsed
    // into a wizard someone must first discover (D12).
    await expect(page.locator(".wizard")).toBeVisible();
    // And it says why the steps are still here, rather than only "Not connected".
    await expect(page.locator(".banner-warn")).toContainText(/no sign-in has succeeded yet/i);
    // Credential fields are in the last wizard step, collapsed by default
    const credSteps = page.locator(".setup-steps > li");
    await credSteps.last().locator("button.wizard-step-toggle").click();
    // The credentials already stored are the ones in the field, so the person can
    // see and correct the value that failed.
    await expect(page.getByLabel("OAuth client ID")).toHaveValue(
      "000000000000-onboarding.apps.googleusercontent.com",
    );
  } finally {
    await page.request.put("/api/config", {
      data: { google: { clientId: "", clientSecret: "" } },
    });
  }
});

test("choosing a work account drops the test-user step", async ({ page }) => {
  await page.goto("/settings");

  // A Workspace account can set the consent screen to Internal, which needs no
  // test users at all — and skipping test users on External is the one mistake
  // with no recovery on Google's own page (Error 403: access_denied). So the
  // step list differs, and the choice is made before the steps rather than
  // explained inside them.
  await expect(page.locator(".setup-steps > li")).toHaveCount(7);
  const steps = page.locator(".setup-steps > li");
  await expect(steps.nth(3).locator("button.wizard-step-toggle")).toContainText("test user");
  await steps.nth(3).locator("button.wizard-step-toggle").click();
  await expect(page.getByRole("link", { name: "Open Audience", exact: true })).toBeVisible();

  await page.getByRole("radio", { name: /work account/ }).check();

  await expect(page.locator(".setup-steps > li")).toHaveCount(6);
  await expect(page.getByRole("link", { name: "Open Audience", exact: true })).toHaveCount(0);
  // And the step that remains tells them which radio to pick in the console.
  // The open index survives the switch, so progress renumbers against the
  // shorter list. "Internal" lives in step 3's body (Google Auth Platform)
  // which is collapsed as done — open it to read the body, or check the
  // audience hint that is always visible. The hint alone names the
  // work-account path this way, so pin it rather than the bare word, which
  // three elements carry.
  await expect(
    page.getByText("A work account can set the consent screen to Internal"),
  ).toBeVisible();
  await expect(page.locator(".wizard-progress")).toHaveText("Step 4 of 6");
  await page.getByRole("radio", { name: /personal account/ }).check();
  await expect(page.locator(".setup-steps > li")).toHaveCount(7);
  await expect(page.locator(".wizard-progress")).toHaveText("Step 4 of 7");
});

/* Last of all, because it empties the Workspace: the danger zone's repeatable
   generated-data clear (issue #144), the successor to the one-time migration
   gate. Everything above seeded state this deletes, so it runs after them and
   puts the Workspace back to empty rather than to demo data. */
test("the danger zone clears all generated data behind a typed phrase", async ({ page }) => {
  const seed = await page.request.post("/api/test/seed");
  if (!seed.ok()) throw new Error(`seed failed: ${seed.status()} ${await seed.text()}`);
  const { runId } = (await seed.json()) as { runId: string };

  await page.goto("/runs");
  await expect(page.locator(`a[href="/runs/${runId}"]`)).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Danger zone" })).toBeVisible();
  const card = page.getByRole("group", { name: "Clear all generated data" });
  await card.getByText("Show what this deletes, and run it").click();
  // The disclosure names what would go, counted from the live Workspace.
  await expect(card.getByText(/currently \d+ records/)).toBeVisible();

  // The phrase gates the button: a mistyped phrase leaves it disabled.
  await page.getByLabel(/Type .* to confirm/).fill("clear all data");
  await expect(page.getByRole("button", { name: "Delete all generated data" })).toBeDisabled();

  await page.getByLabel(/Type .* to confirm/).fill("CLEAR ALL DATA");
  await page.getByRole("button", { name: "Delete all generated data" }).click();

  await expect(page.getByText("Directories removed")).toBeVisible();
  await page.goto("/runs");
  await expect(page.getByText("No runs yet")).toBeVisible();
});
