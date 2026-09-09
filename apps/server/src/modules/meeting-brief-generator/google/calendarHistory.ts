import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import {
  GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";
import {
  readErrorCode,
  readErrorStatus,
  sanitizeArtifactVersion,
  sanitizeEvidence,
} from "../enrichment/helpers.js";
import { runArtifactLifecycle } from "./artifactLifecycle.js";

export interface CalendarHistoryEvent {
  id: string;
  summary: string;
  startAt: string;
  attendees?: string[];
}

export interface CalendarHistoryProvider {
  listPastMeetings(
    guestEmail: string,
    maxResults: number,
    before: string,
  ): Promise<CalendarHistoryEvent[]>;
}

export function createCalendarHistoryProvider(auth: GoogleAuth): CalendarHistoryProvider {
  return {
    async listPastMeetings(
      guestEmail: string,
      maxResults: number,
      before: string,
    ): Promise<CalendarHistoryEvent[]> {
      const calendar = google.calendar({ version: "v3", auth });
      const timeMax = before;
      // Look back 90 days, bounded
      const timeMin = new Date(Date.parse(timeMax) - 90 * 24 * 60 * 60 * 1000).toISOString();
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        maxResults: maxResults * 3, // fetch extra to filter by guest
        singleEvents: true,
        orderBy: "startTime",
        q: guestEmail,
      });
      const items = res.data.items ?? [];
      const filtered = items
        .filter((e) => {
          if (!e.id) return false;
          const attendees = (e.attendees ?? []).map((a) => (a.email ?? "").toLowerCase());
          return attendees.includes(guestEmail.toLowerCase());
        })
        .slice(0, maxResults)
        .map((e) => ({
          id: e.id!,
          summary: e.summary ?? "",
          startAt: e.start?.dateTime ?? e.start?.date ?? "",
          attendees: (e.attendees ?? []).map((a) => a.email ?? ""),
        }));
      return filtered;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

export type FakeCalendarMode = "normal" | "unavailable";

export interface FakeCalendarHistoryOptions {
  mode?: FakeCalendarMode;
  failFirstFor?: Set<string>;
  unavailableError?: unknown;
  pastMeetings?: Map<string, CalendarHistoryEvent[]>;
}

export class FakeCalendarHistoryProvider implements CalendarHistoryProvider {
  private mode: FakeCalendarMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private pastMeetings: Map<string, CalendarHistoryEvent[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();
  constructor(opts: FakeCalendarHistoryOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError =
      opts.unavailableError ??
      Object.assign(new Error("Calendar unavailable"), { status: 503, code: 503 });
    this.pastMeetings = opts.pastMeetings ?? new Map<string, CalendarHistoryEvent[]>();
  }

  setPastMeetings(guestEmail: string, events: CalendarHistoryEvent[]): void {
    this.pastMeetings.set(guestEmail.toLowerCase(), events);
  }

  setMode(mode: FakeCalendarMode): void {
    this.mode = mode;
  }

  addFailFirstFor(guestEmail: string): void {
    this.failFirstFor.add(guestEmail.toLowerCase());
  }

  getCallCount(guestEmail: string): number {
    return this.callCounts.get(guestEmail.toLowerCase()) ?? 0;
  }
  async listPastMeetings(
    guestEmail: string,
    maxResults: number,
    _before: string,
  ): Promise<CalendarHistoryEvent[]> {
    void _before;
    void maxResults;
    const key = guestEmail.toLowerCase();
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(key) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient calendar failure"), { status: 500 });
    }
    const all = this.pastMeetings.get(key) ?? [];
    // Deduplicate by id
    const seen = new Set<string>();
    const deduped: CalendarHistoryEvent[] = [];
    for (const e of all) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        deduped.push(e);
      }
    }
    return deduped;
  }
}

export async function enrichCalendarHistory(
  provider: CalendarHistoryProvider,
  eventVersion: string,
  guestEmail: string,
  before: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifact: GoogleEnrichmentArtifact;
  section: MeetingBriefEnrichmentSection;
  filename: string;
}> {
  const normalized = guestEmail.toLowerCase();
  const key = googleEnrichmentKey(eventVersion, normalized, "calendar-history");
  const stableRef = key;
  const maxResults = GOOGLE_ENRICHMENT_MAX_CALENDAR_HISTORY;
  const filename = `calendar-history-${normalized.replace(/[^a-z0-9]/g, "_")}-${sanitizeArtifactVersion(eventVersion)}.json`;

  const settled = await runArtifactLifecycle({
    ctx,
    filename,
    eventVersion,
    async lookup(attempts) {
      const events = await provider.listPastMeetings(normalized, maxResults, before);
      if (events.length === 0) {
        return {
          key,
          eventVersion,
          guestEmail: normalized,
          source: "calendar-history",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
      }
      const limited = events.slice(0, maxResults);
      const truncated = events.length > maxResults;
      const evidence = limited.map((e) =>
        sanitizeEvidence(e.summary || `Meeting ${e.id} at ${e.startAt}`),
      );
      const references = limited.map(
        (e) => `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(e.id)}`,
      );
      return {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "calendar-history",
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          untrusted: true,
          ...(truncated ? { truncated: true } : {}),
          attempts,
        },
        stableRef,
      };
    },
    failure(error, attempts) {
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "calendar-history",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          untrusted: true,
          attempts,
        },
        stableRef,
      };
    },
    onRetry(_error, attempt) {
      ctx.event("calendar_history_retry", { guest: normalized, attempt });
    },
    onSettled(artifact) {
      if (artifact.status === "empty") {
        ctx.event("calendar_history_empty", {
          guest: normalized,
          attempts: artifact.diagnostics.attempts,
        });
      } else if (artifact.status === "completed") {
        ctx.event("calendar_history_completed", {
          guest: normalized,
          count: artifact.evidence.length,
        });
      } else {
        ctx.event("calendar_history_failed", {
          guest: normalized,
          error: artifact.diagnostics.reason?.slice(0, 200) ?? "unknown error",
        });
      }
    },
  });
  return { ...settled, filename };
}
