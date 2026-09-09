import type {
  ChannelTrend,
  TrendPoint,
  VideoTrend,
  YoutubeChannel,
  YoutubeRunResult,
  YoutubeTrends,
} from "@chief-of-staff-demo/shared";
import type { Runs } from "../../runs.js";
import { dayBefore } from "./day.js";
import { YOUTUBE_MODULE_ID } from "./module.js";

export interface TrendIndexDeps {
  runs: Runs;
  getChannels: () => YoutubeChannel[];
  /** What the Intake remembers, so the tab can say whether today is in. */
  status: () => { lastRunDay: string | null; todayRecorded: boolean };
  /** The spreadsheet the Module made for itself, or null before it made one. */
  spreadsheet: () => { id: string; url: string } | null;
}

/**
 * The trend, as a Cross-Run index (ADR-0005): the Runs are the record, and this
 * is derived by scanning their results. Nothing writes to it and there is no
 * second copy of the numbers — a Module-scoped rollup file is permitted by that
 * ADR but is exactly the ambiguity it ruled out, and it becomes the right answer
 * against a measurement rather than against a guess.
 *
 * Derived on read, and the scan of the Runs is cached in memory. **Only the scan
 * is cached.** The channel list, the spreadsheet link and what the Intake
 * remembers change for their own reasons and are read fresh every time, so the
 * one thing that can invalidate the cache is the Stage that writes a day's
 * counts. A cache covering more than its one invalidator knows about is exactly
 * the drift this rule exists to prevent.
 */
export class TrendIndex {
  /** The measured days, oldest first. Null until the first read scans them. */
  private days: YoutubeRunResult[] | null = null;

  constructor(private readonly deps: TrendIndexDeps) {}

  read(): YoutubeTrends {
    if (this.days === null) {
      /* Oldest first, so every series reads left to right. Days with no Run are
         simply absent: no API returns a past day's view count, so a gap is the
         truth about what was measured and is never filled in. */
      this.days = this.results().sort((a, b) =>
        a.measuredAt < b.measuredAt ? -1 : a.measuredAt > b.measuredAt ? 1 : 0,
      );
    }
    const days = this.days;
    const status = this.deps.status();
    return {
      channels: this.deps.getChannels().map((channel) => trendFor(channel, days)),
      lastDay: days.length > 0 ? days[days.length - 1]!.day : status.lastRunDay,
      todayRecorded: status.todayRecorded,
      spreadsheet: this.deps.spreadsheet(),
    };
  }

  /** Called by the Stage that writes a day's counts, and by nothing else. */
  invalidate(): void {
    this.days = null;
  }

  /** Every Run's own counts file. The Shell stores them; this Module reads them. */
  private results(): YoutubeRunResult[] {
    const out: YoutubeRunResult[] = [];
    for (const summary of this.deps.runs.list({ module: YOUTUBE_MODULE_ID }).runs) {
      const handle = this.deps.runs.open(summary.id);
      if (!handle) {
        continue;
      }
      const raw = handle.readArtifact("result.json");
      if (raw === null) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as YoutubeRunResult;
        if (typeof parsed.day === "string" && Array.isArray(parsed.channels)) {
          out.push(parsed);
        }
      } catch {
        // A torn result is one missing day, not a broken page.
      }
    }
    return out;
  }
}

/** Views as of the newest measurement at least `days` old, or null if there is none. */
function earlier(points: TrendPoint[], days: number): number | null {
  const latest = points[points.length - 1];
  if (!latest) {
    return null;
  }
  const cutoff = dayBefore(latest.day, days);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index]!.day <= cutoff) {
      return points[index]!.views;
    }
  }
  return null;
}

function change(points: TrendPoint[], days: number): number | null {
  const latest = points[points.length - 1];
  const then = earlier(points, days);
  return latest && then !== null ? latest.views - then : null;
}

function trendFor(channel: YoutubeChannel, days: YoutubeRunResult[]): ChannelTrend {
  const totals: TrendPoint[] = [];
  const seriesByVideo = new Map<string, TrendPoint[]>();
  const titles = new Map<string, string>();
  /* The videos the newest Run saw. One that has left the channel keeps its
     history on disk and in the spreadsheet, and drops out of the table: the
     Module grows no view for things that no longer exist. */
  let latestVideoIds: string[] = [];
  let failedIds: string[] = [];

  for (const result of days) {
    const counts = result.channels.find((entry) => entry.channelId === channel.id);
    if (!counts) {
      continue;
    }
    totals.push({
      day: result.day,
      measuredAt: result.measuredAt,
      views: counts.videos.reduce((sum, video) => sum + video.viewCount, 0),
    });
    for (const video of counts.videos) {
      titles.set(video.id, video.title);
      const series = seriesByVideo.get(video.id) ?? [];
      series.push({ day: result.day, measuredAt: result.measuredAt, views: video.viewCount });
      seriesByVideo.set(video.id, series);
    }
    latestVideoIds = counts.videos.map((video) => video.id);
    failedIds = counts.failedIds;
  }

  const videos: VideoTrend[] = latestVideoIds.map((id) => {
    const points = seriesByVideo.get(id) ?? [];
    return {
      id,
      title: titles.get(id) ?? id,
      latest: points[points.length - 1]?.views ?? 0,
      change7: change(points, 7),
      change30: change(points, 30),
      points,
    };
  });
  /* The videos carrying the channel first, which is the question the table
     exists to answer. */
  videos.sort((a, b) => b.latest - a.latest);

  return {
    channelId: channel.id,
    handle: channel.handle,
    title: channel.title,
    totals,
    latest: totals[totals.length - 1]?.views ?? 0,
    change7: change(totals, 7),
    change30: change(totals, 30),
    videos,
    failedIds,
  };
}
