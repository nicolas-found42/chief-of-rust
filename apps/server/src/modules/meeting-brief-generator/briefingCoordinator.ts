import type {
  DailyBriefing,
  DailyBriefingWork,
  DailyBriefingState,
  WeeklyBriefing,
  WeeklyBriefingState,
} from "@chief-of-staff-demo/shared";
import { DateTime } from "luxon";
import type { Runs } from "../../runs.js";
import type { WorkspaceMeetings } from "../../meetings/store.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { buildDailyBriefing, dayBoundsFor } from "./dailyBriefing.js";
import { buildWeeklyBriefing, weekBoundsFor } from "./weeklyBriefing.js";
import { renderDailyBriefingEmail } from "./output.js";

interface MeetingBriefingCoordinatorOptions {
  runs: Runs;
  meetings: WorkspaceMeetings;
  now: () => Date;
  getTimezone: () => string;
  getInternalDomains: () => string[];
  getOwnerEmail: () => string | null;
  /** The Tasks product's bounded Task projection (issue #192); absent when none is composed. */
  getBriefingWork?: () => DailyBriefingWork;
  isOwnerProfileConfirmed?: () => boolean;
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  briefingEmails?: boolean;
  log?: (message: string) => void;
}

/** Daily/Weekly Briefing content and email policy behind one host delegate. */
export class MeetingBriefingCoordinator {
  private lastDailyBriefingDay: string | null = null;
  private dailyBriefingCache: DailyBriefing | null = null;
  private dailyBriefingError: string | null = null;
  private dailyBriefingDirty: { date: string; regenAtMs: number } | null = null;
  private lastDailyEmailDay: string | null = null;
  private lastWeeklyBriefingWeek: string | null = null;
  private weeklyBriefingCache: WeeklyBriefing | null = null;
  private weeklyBriefingError: string | null = null;
  private weeklyBriefingDirty: { weekStart: string; regenAtMs: number } | null = null;
  private readonly regenQuietMs = 15 * 60 * 1000;

  constructor(private readonly options: MeetingBriefingCoordinatorOptions) {}

  /** The stores the Daily Briefing derives from, resolved per build. */
  private dailyDeps() {
    return {
      meetings: this.options.meetings,
      runs: this.options.runs,
      ...(this.options.getBriefingWork ? { work: this.options.getBriefingWork } : {}),
    };
  }

  markBriefingsStale(now: Date, timezone: string): void {
    const regenAtMs = now.getTime() + this.regenQuietMs;
    this.dailyBriefingDirty = { date: dayBoundsFor(now, timezone).date, regenAtMs };
    this.weeklyBriefingDirty = { weekStart: weekBoundsFor(now, timezone).weekStart, regenAtMs };
  }

  notifyActionItemsChanged(now = this.options.now(), timezone = this.options.getTimezone()): void {
    if (this.dailyBriefingCache !== null || this.weeklyBriefingCache !== null) {
      this.markBriefingsStale(now, timezone);
    }
  }

  refreshStaleIfDue(now: Date): void {
    const timezone = this.options.getTimezone();
    const nowMs = now.getTime();
    const date = dayBoundsFor(now, timezone).date;
    const weekStart = weekBoundsFor(now, timezone).weekStart;
    if (this.dailyBriefingDirty?.date === date && nowMs >= this.dailyBriefingDirty.regenAtMs) {
      this.dailyBriefingDirty = null;
      this.refreshDaily(now, timezone);
    } else if (this.dailyBriefingDirty !== null && this.dailyBriefingDirty.date !== date) {
      this.dailyBriefingDirty = null;
    }
    if (
      this.weeklyBriefingDirty?.weekStart === weekStart &&
      nowMs >= this.weeklyBriefingDirty.regenAtMs
    ) {
      this.weeklyBriefingDirty = null;
      this.refreshWeekly(now, timezone);
    } else if (
      this.weeklyBriefingDirty !== null &&
      this.weeklyBriefingDirty.weekStart !== weekStart
    ) {
      this.weeklyBriefingDirty = null;
    }
  }

  refreshDaily(
    now = this.options.now(),
    timezone = this.options.getTimezone(),
  ): DailyBriefingState {
    this.lastDailyBriefingDay = dayBoundsFor(now, timezone).date;
    this.dailyBriefingDirty = null;
    try {
      this.dailyBriefingCache = buildDailyBriefing(this.dailyDeps(), now, timezone);
      this.dailyBriefingError = null;
    } catch (error) {
      this.dailyBriefingError = error instanceof Error ? error.message : String(error);
    }
    return { briefing: this.dailyBriefingCache, error: this.dailyBriefingError, stale: false };
  }

  getDaily(now = this.options.now(), timezone = this.options.getTimezone()): DailyBriefingState {
    const date = dayBoundsFor(now, timezone).date;
    if (this.lastDailyBriefingDay !== date) return this.refreshDaily(now, timezone);
    if (
      this.dailyBriefingDirty?.date === date &&
      now.getTime() >= this.dailyBriefingDirty.regenAtMs
    ) {
      this.dailyBriefingDirty = null;
      return this.refreshDaily(now, timezone);
    }
    if (this.dailyBriefingDirty !== null && this.dailyBriefingDirty.date !== date) {
      this.dailyBriefingDirty = null;
    }
    if (this.dailyBriefingDirty?.date !== date) {
      let fresh: DailyBriefing | null | undefined;
      try {
        fresh = buildDailyBriefing(this.dailyDeps(), now, timezone);
      } catch {
        fresh = undefined;
      }
      if (
        fresh !== undefined &&
        JSON.stringify(fresh) !== JSON.stringify(this.dailyBriefingCache) &&
        (this.dailyBriefingCache !== null || fresh !== null)
      ) {
        this.markBriefingsStale(now, timezone);
      }
    }
    return {
      briefing: this.dailyBriefingCache,
      error: this.dailyBriefingError,
      stale: this.dailyBriefingDirty?.date === date,
    };
  }

  refreshWeekly(
    now = this.options.now(),
    timezone = this.options.getTimezone(),
  ): WeeklyBriefingState {
    this.lastWeeklyBriefingWeek = weekBoundsFor(now, timezone).weekStart;
    this.weeklyBriefingDirty = null;
    try {
      this.weeklyBriefingCache = buildWeeklyBriefing(
        { meetings: this.options.meetings, runs: this.options.runs },
        now,
        timezone,
        this.options.getInternalDomains(),
      );
      this.weeklyBriefingError = null;
    } catch (error) {
      this.weeklyBriefingError = error instanceof Error ? error.message : String(error);
    }
    return { briefing: this.weeklyBriefingCache, error: this.weeklyBriefingError, stale: false };
  }

  getWeekly(now = this.options.now(), timezone = this.options.getTimezone()): WeeklyBriefingState {
    const weekStart = weekBoundsFor(now, timezone).weekStart;
    if (this.lastWeeklyBriefingWeek !== weekStart) return this.refreshWeekly(now, timezone);
    if (
      this.weeklyBriefingDirty?.weekStart === weekStart &&
      now.getTime() >= this.weeklyBriefingDirty.regenAtMs
    ) {
      this.weeklyBriefingDirty = null;
      return this.refreshWeekly(now, timezone);
    }
    if (this.weeklyBriefingDirty !== null && this.weeklyBriefingDirty.weekStart !== weekStart) {
      this.weeklyBriefingDirty = null;
    }
    if (this.weeklyBriefingDirty?.weekStart !== weekStart) {
      let fresh: WeeklyBriefing | null | undefined;
      try {
        fresh = buildWeeklyBriefing(
          { meetings: this.options.meetings, runs: this.options.runs },
          now,
          timezone,
          this.options.getInternalDomains(),
        );
      } catch {
        fresh = undefined;
      }
      if (
        fresh !== undefined &&
        JSON.stringify(fresh) !== JSON.stringify(this.weeklyBriefingCache) &&
        (this.weeklyBriefingCache !== null || fresh !== null)
      ) {
        this.markBriefingsStale(now, timezone);
      }
    }
    return {
      briefing: this.weeklyBriefingCache,
      error: this.weeklyBriefingError,
      stale: this.weeklyBriefingDirty?.weekStart === weekStart,
    };
  }

  async refreshDailyIfMorning(now: Date): Promise<void> {
    const timezone = this.options.getTimezone();
    const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
    if (!local.isValid || local.hour < 6) return;
    if (this.lastDailyBriefingDay === dayBoundsFor(now, timezone).date) return;
    this.refreshDaily(now, timezone);
    await this.sendDailyEmailIfDue(now, timezone);
  }

  async refreshWeeklyIfMonday(now: Date): Promise<void> {
    const timezone = this.options.getTimezone();
    const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
    if (!local.isValid || local.weekday !== 1 || local.hour < 6) return;
    if (this.lastWeeklyBriefingWeek === weekBoundsFor(now, timezone).weekStart) return;
    this.refreshWeekly(now, timezone);
  }

  async sendDailyEmailIfDue(
    now = this.options.now(),
    timezone = this.options.getTimezone(),
  ): Promise<void> {
    try {
      const provider = this.options.gmailDeliveryProvider;
      if (this.options.briefingEmails !== true || !provider) return;
      const date = dayBoundsFor(now, timezone).date;
      if (this.lastDailyEmailDay === date) return;
      const state = this.getDaily(now, timezone);
      if (state.error !== null || state.briefing === null || !this.options.getOwnerEmail()) return;
      if (this.options.isOwnerProfileConfirmed && !this.options.isOwnerProfileConfirmed()) return;
      const deliveryId = `mb-daily-${date}`;
      if (!(await provider.findByDeliveryId(deliveryId))) {
        const rendered = renderDailyBriefingEmail(state.briefing);
        await provider.send({ ...rendered, deliveryId });
      }
      this.lastDailyEmailDay = date;
    } catch (error) {
      this.options.log?.(
        `daily briefing email failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
