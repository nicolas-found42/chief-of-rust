import type { YoutubeChannel } from "@chief-of-staff-demo/shared";
import { workspaceLayout } from "../../paths.js";
import { loadState, saveState, type WorkspaceState } from "../../state.js";
import { localDay } from "./day.js";

/**
 * How often the Intake looks. Modest on purpose: what decides whether a Run is
 * due is the remembered date, not the interval, so the interval only bounds how
 * long after 06:00 the day's Run starts.
 */
const TICK_MINUTES = 15;

/**
 * The hour, local time, from which the day's Run may start. A machine woken at
 * nine still records that day, and a machine left on records it in the morning.
 */
const RUN_FROM_HOUR = 6;

/** The Intake's whole decision, as a pure function of the clock and what it remembers. */
export function dueNow(now: Date, lastRunDay: string | null): boolean {
  if (now.getHours() < RUN_FROM_HOUR) {
    return false;
  }
  return lastRunDay !== localDay(now);
}

export class NothingToMeasureError extends Error {
  constructor() {
    super("Add a channel first — there is nothing to measure.");
    this.name = "NothingToMeasureError";
  }
}

export interface YoutubeIntakeDeps {
  getChannels: () => YoutubeChannel[];
  workspaceDir: string;
  /**
   * Creates the Run for `day` and enqueues its work; resolves as soon as it
   * exists. The day is the Intake's decision and travels with the Run, so
   * nothing downstream re-derives it from a clock.
   */
  startRun: (day: string) => Promise<string>;
  /** Test seam: the clock. Every rule here is a rule about dates. */
  now: () => Date;
  log: (message: string) => void;
}

/**
 * One Run per calendar day, without a scheduler.
 *
 * The Shell grows no scheduling primitive for this: building one for a single
 * customer repeats the mistake ADR-0009's rejected option identified. What this
 * needs is a tick and a remembered date, and it owns both.
 */
export class YoutubeIntake {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A tick and a manual run must not both create today's Run. */
  private inFlight: Promise<string | null> | null = null;

  constructor(private readonly deps: YoutubeIntakeDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.tickSafely();
    }, TICK_MINUTES * 60_000);
    void this.tickSafely();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickSafely(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.deps.log(
        `Daily check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Start today's Run if it is due. Returns its id, or null if it is not. */
  async tick(): Promise<string | null> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const started = this.runDue();
    this.inFlight = started;
    try {
      return await started;
    } finally {
      this.inFlight = null;
    }
  }

  private async runDue(): Promise<string | null> {
    const now = this.deps.now();
    if (!dueNow(now, this.remembered())) {
      return null;
    }
    return await this.begin(localDay(now));
  }

  /**
   * A person asking. The hour rule does not apply — that exists so an unattended
   * machine picks a sensible moment — but the one-Run-per-day rule does, and
   * refusing out loud is the whole point: pressing a button twice must not put
   * two points on one day of the trend.
   */
  async runNow(): Promise<string> {
    const day = localDay(this.deps.now());
    /* View counts move through the day, so a person may measure as often as
       they like. Every Run is kept: each one is a real measurement, and the
       trend reads them in `measuredAt` order. Only the automatic schedule
       below stays at one Run per day. */
    const started = await this.begin(day);
    if (started === null) {
      throw new NothingToMeasureError();
    }
    return started;
  }

  /** What the Intake remembers, for the tab and for the refusal above. */
  status(): { lastRunDay: string | null; todayRecorded: boolean } {
    const lastRunDay = this.remembered();
    return { lastRunDay, todayRecorded: lastRunDay === localDay(this.deps.now()) };
  }

  private async begin(day: string): Promise<string | null> {
    if (this.deps.getChannels().length === 0) {
      /* Nothing to measure is not a missed day: the date stays unrecorded, so
         adding a channel this afternoon still records today. */
      return null;
    }
    const runId = await this.deps.startRun(day);
    /* Recorded once the Run exists, and never again for this day: a failed Run
       is retried in place through the reopen path, so nothing anywhere has to
       define "the latest Run for a day". */
    this.remember(day);
    this.deps.log(`Recording ${day} as run ${runId}`);
    return runId;
  }

  private remembered(): string | null {
    const layout = workspaceLayout(this.deps.workspaceDir);
    return loadState(layout.stateFile).youtubeTrends.lastRunDay;
  }

  /** Load-modify-save, so another writer's state is not lost (as the Drive Intake does). */
  private remember(day: string): void {
    const layout = workspaceLayout(this.deps.workspaceDir);
    const state: WorkspaceState = loadState(layout.stateFile);
    state.youtubeTrends.lastRunDay = day;
    saveState(layout.stateFile, state);
  }
}
