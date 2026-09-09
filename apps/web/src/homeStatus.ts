import type { ProviderId, RunSummary } from "@chief-of-staff-demo/shared";
import { isExpectedConnectionExpiry, runDisplayName, statusLabel } from "./display";

interface RailRow {
  /** React key, and the identity of the thing the row is about. */
  id: string;
  text: string;
  cta: string;
  to: string;
}

/** One finished Run in Home's activity feed (ADR-0014). */
interface FeedEntry {
  id: string;
  title: string;
  /** Outcome in display vocabulary, with the detail that earns it. */
  outcome: string;
  /** ISO timestamp of the Run, for the relative time beside it. */
  at: string;
  to: string;
}
/**
 * Where a finished Run's result lives in the product (ADR-0051): the surface
 * that owns it, never the Run. Each arm mirrors the owning Module's `path` in
 * useModules.ts, with two exceptions. Meeting Debrief deep-links: its detail
 * page is addressed by the Run id, so the feed can name the debrief itself
 * where the Module path can only name the index. Transcript falls back to its
 * review queue, the surface that still owns the retained corpus now the
 * Transcript Module is retired. A Module with no product surface left at all
 * falls back to the Shell's diagnostics list, which Settings links to.
 */
function owningSurfaceForRun(run: RunSummary): string {
  switch (run.module) {
    case "meeting-brief-generator":
      return "/meetings/brief";
    case "meeting-debrief":
      return `/meeting-debrief/${encodeURIComponent(run.id)}`;
    case "content-scout":
      return "/content-scout";
    case "content-research":
      return "/content-research";
    case "youtube-trends":
      return "/content-research/trends";
    case "transcript":
      return "/people/review";
    default:
      return `/runs/${run.id}`;
  }
}

export interface HomeStatus {
  /** One line stating where you stand. Always present, whatever the state. */
  sentence: string;
  /** A row per thing needing action; empty means the rail is omitted entirely. */
  rows: RailRow[];
  /**
   * Recently finished Runs, newest first, capped — attention is not activity
   * (ADR-0014). Failed Runs stay out: the rail above already owns them, and a
   * second list to scan for problems is what ADR-0010 rejected.
   */
  feed: FeedEntry[];
}

/**
 * ADR-0008 aborts the whole outputs batch on a rejected grant, and the first Run
 * after a weekly expiry always fails, so several simultaneous failures are
 * routine rather than hypothetical. Uncapped, the rail would rebuild the Runs
 * list Home deliberately does not have.
 */
const MAX_FAILED_ROWS = 3;

/** The feed is a headline, not an inventory (ADR-0014). */
const MAX_FEED = 5;

/**
 * Home's sentence and attention rail, from what the Shell can observe.
 *
 * A condition earns a rail row by being **standing, Shell-observable and
 * actionable**, and by not already being visible where the user is standing —
 * which is why the Google connection is absent from both the rail and the
 * clauses below: the Shell banner says it on every page. The full rule and the
 * candidates it excludes are in ADR-0010.
 *
 * The sentence and the rail are computed together on purpose. The sentence
 * enumerates exactly the conditions the rail itemises, so the summary cannot
 * drift from the detail: the sentence carries the bare fact ("1 run failed"),
 * the row carries the consequence and the way out.
 *
 * `hasNotice` is whether the Shell banner is saying anything — see the
 * `Nothing needs your attention.` clause below, the one part of the sentence that
 * speaks for the whole page rather than for the part Home owns.
 */
export function homeStatus(
  runs: RunSummary[],
  provider: ProviderId,
  hasNotice: boolean,
): HomeStatus {
  const needsAction = runs.filter((run) => run.status === "failed");
  const interrupted = needsAction.filter((run) => isExpectedConnectionExpiry(run.connectionState));
  const failed = needsAction.filter((run) => !isExpectedConnectionExpiry(run.connectionState));
  const blocked = runs.filter((run) => run.status === "blocked");
  const active = runs.filter((run) => run.status === "pending" || run.status === "running");
  /* A fresh workspace defaults to `mock`, so this is the likeliest reason a
     beginner's first upload quietly does nothing useful. It speaks only at the
     level the Shell legitimately knows: the provider is Shell configuration,
     but extraction is a Module stage (ADR-0003), so the row must not claim what
     extraction would have produced. */
  const mock = provider === "mock";

  /* An expiry is reconnect-fixable, so the rail names that fix instead of
     pointing at the Run. Every other failure still opens its diagnostic. */
  const rows: RailRow[] = needsAction.slice(0, MAX_FAILED_ROWS).map((run) =>
    isExpectedConnectionExpiry(run.connectionState)
      ? {
          id: run.id,
          text: `${runDisplayName(run)} could not finish because Google needs reconnecting`,
          cta: "Reconnect",
          to: "/settings",
        }
      : {
          id: run.id,
          text: `${runDisplayName(run)} failed`,
          cta: "Open",
          to: `/runs/${run.id}`,
        },
  );
  /* The tail of the failed rows, not a condition of its own — so it sits with
     the rows it summarises rather than after the provider. */
  if (needsAction.length > MAX_FAILED_ROWS) {
    const hiddenRuns = needsAction.slice(MAX_FAILED_ROWS);
    const hidden = hiddenRuns.length;
    const hiddenExpiryCount = hiddenRuns.filter((run) =>
      isExpectedConnectionExpiry(run.connectionState),
    ).length;
    const outcome =
      hiddenExpiryCount === hidden
        ? hidden === 1
          ? "needs reconnecting"
          : "need reconnecting"
        : hiddenExpiryCount === 0
          ? "failed"
          : "need attention";
    rows.push({
      id: "more-failed",
      text: `${hidden} more run${hidden === 1 ? "" : "s"} ${outcome}`,
      cta: "See all runs",
      to: "/runs",
    });
  }
  for (const run of blocked) {
    rows.push({
      id: run.id,
      text: `${runDisplayName(run)} is waiting${run.wait?.reason ? `: ${run.wait.reason}` : ""}`,
      cta: "Open",
      to: `/runs/${run.id}`,
    });
  }
  if (mock) {
    rows.push({
      id: "mock-provider",
      text: "Runs are using the mock provider, so nothing real is extracted",
      cta: "Choose a provider",
      to: "/settings",
    });
  }

  /* Newest first: the feed is what happened lately, not an inventory. Runs
     without a stored createdAt sort last by falling back to their id — a
     comparison that never lies about being arbitrary. */
  const finished = runs
    .filter((run) => run.status === "done" || run.status === "skipped")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const feed: FeedEntry[] = finished.slice(0, MAX_FEED).map((run) => {
    /* The Module's own line about what it did, or why it stopped. The Shell
       does not derive either — it renders what the Run recorded. */
    const detail = run.status === "skipped" ? run.skipReason : run.summary;
    return {
      id: run.id,
      title: runDisplayName(run),
      outcome: detail ? `${statusLabel(run.status)} — ${detail}` : statusLabel(run.status),
      at: run.createdAt,
      to: owningSurfaceForRun(run),
    };
  });

  /* One clause per rail condition, in the rail's order. The count is the true
     total, not the capped row count. */
  const clauses: string[] = [];
  if (interrupted.length > 0) {
    clauses.push(
      `${interrupted.length} run${interrupted.length === 1 ? " needs" : "s need"} reconnecting`,
    );
  }
  if (failed.length > 0) {
    clauses.push(`${failed.length} run${failed.length === 1 ? "" : "s"} failed`);
  }
  if (blocked.length > 0) {
    clauses.push(`${blocked.length} run${blocked.length === 1 ? " is" : "s are"} waiting for you`);
  }
  if (mock) {
    clauses.push("the extraction provider is a stand-in");
  }

  return { sentence: sentenceFor(clauses, runs.length, active.length, hasNotice), rows, feed };
}

function sentenceFor(
  clauses: string[],
  runCount: number,
  activeCount: number,
  hasNotice: boolean,
): string {
  if (clauses.length > 0) {
    /* Capitalised before the prefix, not after: the provider clause starts
       lowercase and can lead the sentence on its own. */
    const enumerated = `${capitalise(join(clauses))}.`;
    return runCount === 0 ? `Nothing has run yet. ${enumerated}` : enumerated;
  }

  /* "Nothing has run yet." claims no all-clear, so it never takes the clause
     below — there is nothing to reassure anyone about yet. */
  if (runCount === 0) {
    return "Nothing has run yet.";
  }

  const standing =
    activeCount > 0
      ? `${activeCount} run${activeCount === 1 ? "" : "s"} in progress.`
      : "All caught up.";

  /* The enumeration above is rail-scoped; this clause is page-scoped, because
     it is a claim about the reader's obligations rather than about the
     workspace. Home cannot make it while the banner above is asking for
     something — including a banner that is only warning about an expiry due
     soon, which exists to get a sign-in *before* a Run fails. The feed below
     the sentence carries the activity, so quiet no longer has to mean silent
     (ADR-0014). */
  return hasNotice ? standing : `${standing} Nothing needs your attention.`;
}

function join(parts: string[]): string {
  if (parts.length <= 1) {
    return parts.join("");
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
