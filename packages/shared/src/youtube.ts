import { z } from "zod/v3";

/**
 * YouTube Trends: the Module's own shapes. Here beside the transcript Module's
 * for the same reason — the web app and the server both need them.
 *
 * The Shell's `ConfigSchema` names the channel shape, because it validates the
 * one config file and a strict schema cannot hold an unknown slot. That is the
 * whole of its knowledge: it stores what is below and interprets none of it.
 */

/**
 * A channel as stored: resolved once when it was added, so no Run ever
 * re-resolves or guesses. The id is the only part Google promises is stable.
 */
export const YoutubeChannelSchema = z.strictObject({
  /** Google's channel id, `UC…`. */
  id: z.string(),
  /** The `@handle`, when the channel has one. Display and re-finding only. */
  handle: z.string(),
  title: z.string(),
  /** The channel's uploads playlist, read from `contentDetails` when added. */
  uploadsPlaylistId: z.string(),
  addedAt: z.string(),
});
export type YoutubeChannel = z.infer<typeof YoutubeChannelSchema>;

/** One video as one Run saw it. */
export interface YoutubeVideoCount {
  id: string;
  title: string;
  viewCount: number;
}

/** One channel as one Run saw it. */
export interface YoutubeChannelCounts {
  channelId: string;
  handle: string;
  title: string;
  videos: YoutubeVideoCount[];
  /**
   * Ids the statistics call did not answer for — deleted, private, or gone.
   * Named here so three lost videos read as three lost videos rather than as a
   * broken automation.
   */
  failedIds: string[];
}

/** `result.json` for one daily Run: the day's counts, and nothing derived. */
export interface YoutubeRunResult {
  version: 1;
  /** The local calendar day measured, `YYYY-MM-DD`. May repeat across Runs. */
  day: string;
  measuredAt: string;
  channels: YoutubeChannelCounts[];
}

/**
 * One measurement. Days with no Run are absent, never interpolated, and a day
 * measured more than once contributes one point per Run — `measuredAt`, not
 * `day`, is what orders and distinguishes them.
 */
export interface TrendPoint {
  day: string;
  measuredAt: string;
  views: number;
}

export interface VideoTrend {
  id: string;
  title: string;
  /** Views as of the newest Run that saw this video. */
  latest: number;
  /** Change since the newest measurement at least 7 days old; null if none. */
  change7: number | null;
  /** Change since the newest measurement at least 30 days old; null if none. */
  change30: number | null;
  points: TrendPoint[];
}

export interface ChannelTrend {
  channelId: string;
  handle: string;
  title: string;
  /** The channel's total views, one point per Run, oldest first. */
  totals: TrendPoint[];
  latest: number;
  change7: number | null;
  change30: number | null;
  /** The videos the newest Run saw. One that has left the channel keeps its
   *  history on disk and drops out of here. */
  videos: VideoTrend[];
  /** Ids the newest Run could not read. */
  failedIds: string[];
}

/**
 * GET /api/youtube/trends — the Cross-Run index (ADR-0005): derived by scanning
 * Run results, never a second copy of the numbers. It reads nothing from Google,
 * so an expired connection does not blank a page of data already measured.
 */
export interface YoutubeTrends {
  channels: ChannelTrend[];
  /** The last day a Run recorded, or null before the first one. */
  lastDay: string | null;
  /** Whether today is already recorded, so the tab can say why a manual run refuses. */
  todayRecorded: boolean;
  /**
   * The spreadsheet this Module made for itself, or null before it has made
   * one. Kept here rather than in a Run record so the link survives the Run
   * scrolling out of Home's feed.
   */
  spreadsheet: { id: string; url: string } | null;
}

/** POST /api/youtube/channels body. */
export const AddChannelSchema = z.strictObject({ url: z.string().min(1) });
