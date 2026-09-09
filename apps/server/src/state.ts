import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * YouTube Trends' own key. Durability comes from a remembered date, never from a
 * timer: an interval timer resets on every restart, so a laptop restarted every
 * few days would never fire one.
 */
interface YoutubeTrendsState {
  /** The last calendar day a Run was started for, local time. */
  lastRunDay: string | null;
}

export interface WorkspaceState {
  youtubeTrends: YoutubeTrendsState;
}

export function loadState(stateFile: string): WorkspaceState {
  const empty: WorkspaceState = {
    youtubeTrends: { lastRunDay: null },
  };
  if (!existsSync(stateFile)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      youtubeTrends?: { lastRunDay?: unknown };
    };
    const youtubeTrends = parsed.youtubeTrends ?? {};
    return {
      youtubeTrends: {
        /* A state file written before this Module existed has no day, which
           reads as "no Run yet" — exactly right. */
        lastRunDay: typeof youtubeTrends.lastRunDay === "string" ? youtubeTrends.lastRunDay : null,
      },
    };
  } catch {
    return empty;
  }
}

export function saveState(stateFile: string, state: WorkspaceState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}
