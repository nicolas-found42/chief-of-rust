import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ProviderId, RunSummary, TaskOverview } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { configApi, migrationApi, runsApi, type OnboardingStatus } from "../clients/workspace";
import { tasksApi } from "../clients/tasks";
import { WorkSummary } from "../components/WorkSummary";
import { connectionNotice } from "../connectionNotice";
import { homeStatus } from "../homeStatus";
import { useGoogleConnection } from "../useGoogleConnection";
import { formatTime, relativeTime } from "../display";
import { PRODUCT_AREAS } from "../productAreas";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
// PROTOTYPE — throwaway Home UI exploration (?variant=a|b|c). Delete with losers.
import { PrototypeSwitcher } from "../components/PrototypeSwitcher";
import { VariantA, VariantB, VariantC } from "./homePrototypeVariants";

const TERMINAL = new Set(["done", "skipped", "failed"]);

/**
 * The Shell's front door: where the workspace stands, and the way into the
 * Modules (ADR-0010). Since ADR-0014 it distinguishes attention from activity:
 * the rail above carries what needs you, the feed below carries what happened
 * anyway, and the two are different lists with different contracts.
 *
 * `useTitle(null)` resolves to the bare Shell name, which is identical to the
 * `<title>` in index.html — so opening the front door never re-titles the tab,
 * where `useTitle("Home")` would flash "Chief of Staff" → "Home · Chief of
 * Staff" on every visit to the most-visited route.
 */
export function HomePage() {
  useTitle(null);
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const { status, refresh: refreshConnection } = useGoogleConnection();
  const areas = PRODUCT_AREAS;
  // PROTOTYPE — read unconditionally; hooks cannot sit behind the loading gate.
  const [searchParams] = useSearchParams();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [work, setWork] = useState<TaskOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuns((await runsApi.listRuns()).runs);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  /* Canonical work (issue #192), read once per visit. Its own request and its
     own failure: the Runs feed above is a different contract, and a Tasks read
     that fails should not blank the page that owns the Modules. */
  const [workError, setWorkError] = useState<string | null>(null);
  useEffect(() => {
    tasksApi
      .overview()
      .then(setWork)
      .catch((err: unknown) => setWorkError(errorMessage(err)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  /* Post-reset onboarding (spec: Migration and Cutover, step 7) has no other
     persistent surface: the gate hands the user to /onboarding once, and if
     they leave, this is the way back. Asked once per visit — a step completed
     in another tab is picked up the next time Home mounts. A failure is
     silent: the banner is informational, and Home's error state already has a
     voice. */
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  useEffect(() => {
    let live = true;
    migrationApi
      .status()
      .then((payload) => {
        if (live) setOnboarding(payload.onboarding);
      })
      .catch(() => {
        // Silent: no banner rather than a broken one.
      });
    return () => {
      live = false;
    };
  }, []);

  /* Asked once: the provider only changes through Settings, which is a full
     route away, and the poll below has no reason to keep asking. */
  useEffect(() => {
    const load = async () => {
      try {
        setProvider((await configApi.getConfig()).config.provider);
      } catch (err) {
        setError(errorMessage(err));
      }
    };
    void load();
  }, []);

  const activeCount = runs === null ? 0 : runs.filter((run) => !TERMINAL.has(run.status)).length;

  /* The same rule the runs list uses: an interval that exists only while a Run
     can still change (WCAG 2.2.2). The connection refreshes on the same tick
     rather than on a timer of its own — a grant rejected mid-Run is the one
     event that changes it without passing through Settings, and this poll is
     live in exactly that window (ADR-0011). */
  useEffect(() => {
    if (activeCount === 0) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
      void refreshConnection();
    }, 3000);
    return () => clearInterval(timer);
  }, [activeCount, refresh, refreshConnection]);

  if (runs === null || provider === null) {
    return (
      <div className="page">
        <h1 ref={headingRef} tabIndex={-1}>
          Home
        </h1>
        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )}
      </div>
    );
  }

  const notice = connectionNotice(status);
  const { sentence, rows, feed } = homeStatus(runs, provider, notice !== null);
  // PROTOTYPE — sub-shape A: same data fetching above, only rendering swaps.
  const variant = searchParams.get("variant") ?? "current";
  if (variant === "a" || variant === "b" || variant === "c") {
    const data = {
      sentence,
      identity:
        status?.state === "connected"
          ? `Google connected${status.email ? ` as ${status.email}` : ""}`
          : null,
      rows,
      feed,
      areas,
      activeCount,
      runCount: runs.length,
    };
    return (
      <div className="page">
        {variant === "a" && <VariantA data={data} />}
        {variant === "b" && <VariantB data={data} />}
        {variant === "c" && <VariantC data={data} />}
        <PrototypeSwitcher current={variant} />
      </div>
    );
  }

  return (
    <div className="page">
      {/* The head card: the sentence is the one thing Home exists to say, so it
          is the display-scale line and the h1 shrinks to the eyebrow above it.
          The h1 keeps the word "Home" — the tab, the heading outline and the
          focus target all still name the route (WCAG 2.4.2, 2.4.6). */}
      <div className="home-head">
        <h1 ref={headingRef} tabIndex={-1}>
          Home
        </h1>

        {/* Plain text, no links: `.step-link` is a boxed button style, so an
            inline link renders as a button mid-paragraph. */}
        <p className="home-sentence">{sentence}</p>

        {/* The one fact where silence is genuinely ambiguous — an unwarned page
            cannot be told apart from a check that never ran — and this connection
            expires about weekly. Identity only: the expiry warning belongs to the
            Shell banner above, which already reaches this page. The green dot is
            redundant with the words, so forced-colors mode loses nothing. */}
        {status?.state === "connected" && (
          <p className="home-identity">
            Google connected{status.email ? ` as ${status.email}` : ""}
          </p>
        )}
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {/* Post-reset onboarding banner: a status region, not an alert — nothing
          failed. Sits between the head card and the rail/grid, so it is read
          before either. */}
      {onboarding !== null && !onboarding.complete && (
        <div className="banner" role="status">
          Workspace setup is not finished. <Link to="/onboarding">Finish setup</Link>
        </div>
      )}

      {/* The rail leads the markup and the Modules follow, so a reader who takes
          the page in one column meets what needs them before what merely exists
          — and so does anyone tabbing or navigating by heading. Two columns are
          a placement of these two, not a different order of them. */}
      <div className="home-grid">
        <div className="home-rail-column">
          {/* Omitted entirely when empty, rather than rendering an all-clear: the
              sentence has already said it. The heading is hidden because a sighted
              reader takes the label from that sentence, but nothing associates the
              list with it programmatically — and it puts the rail in the heading
              outline beside "Modules" for heading navigation. */}
          {/* Accepted work and the proposals waiting on a decision, before the
              Run feed: what is open is the reason to be here, and what merely
              ran is not (issue #192). Omitted only when the Tasks read failed
              — a Workspace with no Tasks still says so, in zeroes. */}
          <section className="card home-work-card" aria-labelledby="home-work-heading">
            <h2 id="home-work-heading">Your work</h2>
            {workError ? (
              <div className="banner banner-error" role="alert">
                {workError}
              </div>
            ) : work === null ? (
              <p className="muted" role="status">
                Loading work…
              </p>
            ) : (
              <WorkSummary overview={work} />
            )}
          </section>

          {rows.length > 0 && (
            <section className="card home-rail-card">
              <h2 className="visually-hidden">Needs your attention</h2>
              <ul className="home-rail">
                {rows.map((row) => (
                  <li key={row.id} className="home-rail-row">
                    <span>{row.text}</span>
                    {/* The action-button primitive with a pill radius, not a
                        smaller control: a boxed link still owes 44px (WCAG 2.5.8). */}
                    <Link to={row.to} className="action-button primary home-cta">
                      {row.cta}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Attention ≠ activity (ADR-0014): even a quiet Home says what happened.
              Omitted entirely when nothing has ever finished — no zeroes, ever. Each
              entry links to the surface that owns the result (ADR-0051); the Runs
              behind them live on the diagnostics list Settings links to. */}
          {feed.length > 0 && (
            <section className="card home-feed-card">
              <h2>Recent activity</h2>
              <ul className="home-feed">
                {feed.map((entry) => (
                  <li key={entry.id}>
                    <Link to={entry.to} className="home-feed-title">
                      {entry.title}
                    </Link>
                    <span className="muted home-feed-meta">
                      {entry.outcome} ·{" "}
                      <time dateTime={entry.at} title={formatTime(entry.at)}>
                        {relativeTime(entry.at)}
                      </time>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="home-main">
          <h2 className="home-section">Products</h2>
          {/* The four product areas are explicit (spec: Navigation and
              onboarding #1; ADR-0043), not derived from the Module registry —
              the same list the header nav reads, so the two cannot disagree. */}
          <div className="module-grid">
            {areas.map((area, index) => (
              <div className="card module-card" key={area.id}>
                {/* Decorative: the ordinal is the tile's position, which the
                    reading order already carries. */}
                <p className="module-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3>
                  <Link to={area.path}>{area.label}</Link>
                </h3>
                <p className="muted">{area.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* PROTOTYPE — dev-only entry point to ?variant=a|b|c; null in prod builds. */}
      <PrototypeSwitcher current={variant} />
    </div>
  );
}
