import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { AllRunsPage } from "./pages/AllRunsPage";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { HomePage } from "./pages/HomePage";
import { ContentResearchPage } from "./pages/ContentResearchPage";
import { ContentScoutPage } from "./pages/ContentScoutPage";
import { ContentProjectDetailPage } from "./pages/ContentProjectDetailPage";
import { MeetingPage } from "./pages/MeetingPage";
import { MeetingsWeeklyPage } from "./pages/MeetingsWeeklyPage";
import { MeetingsOverviewPage } from "./pages/MeetingsOverviewPage";
import { MeetingBriefPage } from "./pages/MeetingBriefPage";
import { MeetingDebriefDetailPage } from "./pages/MeetingDebriefDetailPage";
import { MeetingDebriefPage } from "./pages/MeetingDebriefPage";
import { MigrationGatePage } from "./pages/MigrationGatePage";
import { NewPersonProfilePage } from "./pages/NewPersonProfilePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OnboardingSetupPage } from "./pages/OnboardingSetupPage";
import { PeoplePage } from "./pages/PeoplePage";
import { PersonProfileDetailPage } from "./pages/PersonProfileDetailPage";
import { TranscriptReviewPage } from "./pages/TranscriptReviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { YoutubePage } from "./pages/YoutubePage";
import { migrationApi, type MigrationStatus } from "./clients/workspace";
import { isCurrentArea, PRODUCT_AREAS } from "./productAreas";
import { useIsLoadedEntry } from "./usePageFocus";

/* The one width the Shell changes shape at, shared with the stylesheet's
   reflow block so the disclosure and the layout cannot disagree. */
const COMPACT_NAV = "(max-width: 640px)";

/* Routes that are mostly table. They read better than the 1080px prose measure
   allows, so they opt out of it (see .app-main-wide). Exact paths only — a Run
   or a Profile detail page is prose and keeps the measure. */
const WIDE_ROUTES = ["/runs", "/people", "/people/review", "/meeting-debrief"];

/** True while the viewport is narrow enough that the tab bar is disclosed
    rather than always present. Read from the same media query the stylesheet
    uses, not from a width comparison that could drift from it. */
function useCompactNav(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_NAV).matches);
  useEffect(() => {
    const query = window.matchMedia(COMPACT_NAV);
    const sync = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return compact;
}

/**
 * The Shell. Before any route renders, the boot gate asks /api/migration/status
 * once: a pre-cutover Workspace renders the migration gate instead of the whole
 * product shell, so no product route — and no product API call — happens while
 * the reset is pending. The server's 503 preHandler on normal /api/* routes is
 * the backstop, not the primary defense.
 */
export function App() {
  // Records the history entry the browser loaded, before any route can navigate
  // off it. Asked for here rather than in the pages so the capture cannot depend
  // on which route happened to match first.
  useIsLoadedEntry();

  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const { pathname } = useLocation();
  const compactNav = useCompactNav();
  const [navOpen, setNavOpen] = useState(false);
  /* Following a link is the end of the menu's job. Without this the disclosed
     panel stays over the page the tap just navigated to. */
  useEffect(() => setNavOpen(false), [pathname]);

  useEffect(() => {
    let live = true;
    migrationApi
      .status()
      .then((payload) => {
        if (live) setStatus(payload);
      })
      .catch((err) => {
        if (live) setStatusError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  /* Re-reads the migration status once the in-process cutover has run: the
     boot read is stale by definition the moment the reset confirms, and only
     the gate page knows that moment. */
  const refreshMigrationStatus = useCallback(() => {
    migrationApi
      .status()
      .then((payload) => setStatus(payload))
      .catch((err) => setStatusError(err instanceof Error ? err.message : String(err)));
  }, []);

  /* Gated: the shell's landmarks hold (skip link, header, main) but the header
     carries the wordmark only — no product navigation invites a route whose
     every API call would be refused. */
  if (status?.state === "required") {
    return (
      <div className="app-shell">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="app-header">
          <Link className="app-title" to="/">
            Found42 — Chief of Staff
          </Link>
        </header>
        <main className="app-main" id="main" tabIndex={-1}>
          <MigrationGatePage onCutOver={refreshMigrationStatus} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Bypass block: off-screen until focused. The landmark set already
          covers 2.4.1 for anyone navigating by landmark, but a magnifier user
          without those shortcuts otherwise re-traverses the header on every
          page. */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        {/* The wordmark is the way back to the front door, and it stays outside
            any <nav>: Home is not a product area, and a link in there would
            both relabel it as one in the accessibility tree and add a second
            candidate to the nav's current-page indicator. A plain Link rather
            than a NavLink for the same reason — the current state belongs to
            the tab bar, and an aria-current with nothing drawn for it is
            exactly the drift the nav styling avoids. */}
        <Link className="app-title" to="/">
          Found42 — Chief of Staff
        </Link>
        {/* Below 640px the five links cost three rows of the first screen, so
            they are disclosed rather than always drawn. The button only exists
            at that width — a hidden control the layout never uses would still
            be in the tab order, and `hidden` overridden by a media query is a
            state assistive technology and CSS can disagree about. */}
        {compactNav && (
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            Menu
          </button>
        )}
        {(!compactNav || navOpen) && (
          <div className="app-nav" id="app-nav">
            {/* Product areas are explicit (spec: Navigation and onboarding #1;
                ADR-0043, ADR-0052), not derived from the Module registry:
                Person Profiles and Tasks are Workspace resources with their own
                surfaces, not Modules, and the five areas name ownership, not
                backend registration. Nav and Home's cards read the same list,
                so the two cannot disagree. */}
            {/* A plain Link with the current state stated here, rather than a
                NavLink: a product area owns routes outside its own path prefix
                — Meeting Wizard presents the Debrief journey at
                /meeting-debrief — and NavLink can only match the prefix, so the
                whole nav went blank on those pages and the Debrief journey read
                as though it sat outside the product that owns it. */}
            <nav aria-label="Products">
              {PRODUCT_AREAS.map((area) => (
                <Link
                  key={area.id}
                  to={area.path}
                  aria-current={isCurrentArea(area, pathname) ? "page" : undefined}
                >
                  {area.label}
                </Link>
              ))}
            </nav>
            <nav aria-label="Settings">
              <NavLink to="/settings">Settings</NavLink>
            </nav>
          </div>
        )}
      </header>
      <main
        className={WIDE_ROUTES.includes(pathname) ? "app-main app-main-wide" : "app-main"}
        id="main"
        tabIndex={-1}
      >
        {/* Inside <main>, above the outlet: the skip link targets #main, so a
            banner here is the first thing a keyboard user meets after skipping,
            where one in a new row above <main> would be jumped straight over.
            No Module renders it (ADR-0011). */}
        <ConnectionBanner />
        {statusError && (
          <div className="banner banner-error" role="alert">
            {statusError}
          </div>
        )}
        {status === null && !statusError && <p className="muted">Loading…</p>}
        <Routes>
          <Route path="/" element={<HomePage />} />
          {/* A Shell page, not a tab: the bar renders product areas (spec:
              Navigation and onboarding #1), and no product surface links here —
              the list stays reachable from Settings' Diagnostics and from a
              failure's technical details, for diagnosis only (ADR-0051). */}
          <Route path="/runs" element={<AllRunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          {/* The migration gate, reachable by URL when not gated: the page
              itself reports that no migration is needed. While gated, the boot
              gate above renders it for every route. */}
          <Route
            path="/migration"
            element={<MigrationGatePage onCutOver={refreshMigrationStatus} />}
          />
          {/* Only reachable post-completion: the gate holds /onboarding closed
              like every other route. */}
          <Route path="/onboarding" element={<OnboardingSetupPage />} />
          {/* YouTube Trends is presented under Content Research (spec:
              /content-research/trends); the legacy top-level route is gone. */}
          <Route path="/content-research/trends" element={<YoutubePage />} />
          <Route path="/content-scout" element={<ContentScoutPage />} />
          <Route
            path="/content-engine/projects/:projectId"
            element={<ContentProjectDetailPage />}
          />
          {/* Meeting Wizard (ADR-0043): Overview plus the sibling Brief
      journey; Brief and Debrief lifecycle state stays separate. The
      legacy /meeting-brief product route is gone — not-found. */}
          <Route path="/meetings" element={<MeetingsOverviewPage />} />
          <Route path="/meetings/weekly" element={<MeetingsWeeklyPage />} />
          <Route path="/meetings/:meetingId" element={<MeetingPage />} />
          <Route path="/meetings/brief" element={<MeetingBriefPage />} />
          <Route path="/meetings/brief/:occurrenceKey" element={<MeetingBriefPage />} />
          <Route path="/meeting-debrief" element={<MeetingDebriefPage />} />
          <Route path="/meeting-debrief/:runId" element={<MeetingDebriefDetailPage />} />
          <Route path="/content-research" element={<ContentResearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/new" element={<NewPersonProfilePage />} />
          <Route path="/people/:profileId" element={<PersonProfileDetailPage />} />
          <Route path="/people/review" element={<TranscriptReviewPage />} />
          {/* Tasks (ADR-0052): the canonical record of accepted work, and the
              queue of Action Items a Meeting Debrief proposed. */}
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="app-footer">
        <span>
          Drafts are created, mail is never sent — except Meeting Briefs, which go only to your
          connected account.
        </span>
      </footer>
    </div>
  );
}
