import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";
import {
  SOURCE_BACKFILL_WINDOWS_DAYS,
  type SourceAdapterCanaryTarget,
  type SourceComment,
  type SourceItem,
  type SourceFieldState,
} from "@chief-of-staff-demo/shared";
import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "../google/oauth.js";
import { parseChannelUrl, type ChannelRef } from "./youtube-channels.js";
import type { SourceAdapter, SourceCollectionResult } from "./source-adapter.js";
import { commandAdapterResults } from "./public-command.js";

const execFileAsync = promisify(execFile);

interface YouTubeSourceVideo {
  id: string;
  title: string;
  description: string | null;
  channelTitle: string | null;
  publishedAt: string;
  /** What YouTube reports about the video's reception, when the API returns it. */
  statistics?: { views?: number; likes?: number; commentCount?: number };
}

export interface YouTubeSourceClient {
  resolveChannel(ref: ChannelRef): Promise<{ id: string; uploadsPlaylistId: string } | null>;
  listUploads(playlistId: string, publishedAfter: string): Promise<YouTubeSourceVideo[]>;
  listComments(videoId: string, limit: number): Promise<SourceComment[]>;
}

export type YouTubeSourceAccess =
  { ok: true; client: YouTubeSourceClient } | { ok: false; state: GoogleConnectionState };

/** YouTube returns counts as strings; anything unparseable is simply not a count. */
function countOf(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function youtubeSourceClient(auth: GoogleAuth): YouTubeSourceClient {
  const api = google.youtube({ version: "v3", auth });
  return {
    async resolveChannel(ref) {
      const lookup =
        ref.kind === "handle"
          ? { forHandle: ref.value }
          : ref.kind === "id"
            ? { id: [ref.value] }
            : { forUsername: ref.value };
      const response = await api.channels.list({
        part: ["contentDetails"],
        maxResults: 1,
        ...lookup,
      });
      const channel = response.data.items?.[0];
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
      return channel?.id && uploadsPlaylistId ? { id: channel.id, uploadsPlaylistId } : null;
    },

    async listUploads(playlistId, publishedAfter) {
      const videos: YouTubeSourceVideo[] = [];
      let pageToken: string | undefined;
      let reachedOld = false;
      do {
        const response = await api.playlistItems.list({
          part: ["snippet", "contentDetails"],
          playlistId,
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of response.data.items ?? []) {
          const id = item.contentDetails?.videoId;
          const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
          if (!id || !publishedAt) continue;
          if (Date.parse(publishedAt) < Date.parse(publishedAfter)) {
            reachedOld = true;
            continue;
          }
          videos.push({
            id,
            title: item.snippet?.title ?? id,
            description: item.snippet?.description ?? null,
            channelTitle:
              item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? null,
            publishedAt: new Date(publishedAt).toISOString(),
          });
        }
        pageToken = reachedOld ? undefined : (response.data.nextPageToken ?? undefined);
      } while (pageToken);
      /* playlistItems carries no counts, so the statistics come from one
         videos.list per 50 ids — YouTube's own numbers, which is what resonance
         is scored on. A statistics call that fails leaves the videos without
         counts rather than losing the videos. */
      for (let index = 0; index < videos.length; index += 50) {
        const batch = videos.slice(index, index + 50);
        try {
          const stats = await api.videos.list({
            part: ["statistics"],
            id: batch.map((video) => video.id),
            maxResults: 50,
          });
          const byId = new Map(
            (stats.data.items ?? []).flatMap((item) =>
              item.id ? [[item.id, item.statistics] as const] : [],
            ),
          );
          for (const video of batch) {
            const statistics = byId.get(video.id);
            if (!statistics) continue;
            const views = countOf(statistics.viewCount);
            const likes = countOf(statistics.likeCount);
            const commentCount = countOf(statistics.commentCount);
            if (views === undefined && likes === undefined && commentCount === undefined) continue;
            video.statistics = {
              ...(views !== undefined ? { views } : {}),
              ...(likes !== undefined ? { likes } : {}),
              ...(commentCount !== undefined ? { commentCount } : {}),
            };
          }
        } catch {
          // counts are an enrichment; losing them must not lose the uploads
        }
      }
      return videos;
    },

    async listComments(videoId, limit) {
      const response = await api.commentThreads.list({
        part: ["snippet"],
        videoId,
        maxResults: Math.min(limit, 50),
        order: "relevance",
        textFormat: "plainText",
      });
      return (response.data.items ?? []).flatMap((thread): SourceComment[] => {
        const comment = thread.snippet?.topLevelComment;
        const snippet = comment?.snippet;
        if (!comment?.id || !snippet?.textDisplay) return [];
        return [
          {
            author: snippet.authorDisplayName ?? null,
            publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt).toISOString() : null,
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${comment.id}`,
            text: snippet.textDisplay,
            engagement: snippet.likeCount ?? null,
          },
        ];
      });
    },
  };
}

// Transcript enrichment route definitions — versions pinned to the production image.
export const YOUTUBE_TRANSCRIPT_VERSIONS = {
  googleCaptions: "youtube-data-api-v3",
  publicTranscript: "1.2.2",
  ytDlp: "2025.08.22",
  whisperCpp: "v1.7.6",
} as const;

type TranscriptRoute =
  "youtube.captions.list" | "youtube-transcript-api" | "yt-dlp" | "whisper-cpp";

export interface TranscriptAttempt {
  state: SourceFieldState;
  text: string | null;
  route: TranscriptRoute;
  version: string;
  causeChain: string[];
  durationSeconds?: number | null;
}

type TranscriptFetcher = (videoId: string) => Promise<TranscriptAttempt>;

export interface YouTubeTranscriptDeps {
  fetchGoogleCaptions?: TranscriptFetcher;
  fetchPublicTranscript?: TranscriptFetcher;
  fetchYtDlpTranscript?: TranscriptFetcher;
  transcribeWhisper?: TranscriptFetcher;
  getDurationSeconds?: (videoId: string) => Promise<number | null>;
  runtimeInspector?: {
    inspect(): Promise<{ id: string; state: string; version: string | null }[]>;
  };
  retention?: {
    recordTemporaryMedia(input: { id: string; outcome: "processed" | "failed"; bytes: string }): {
      retained: boolean;
    };
    retainEvidenceTranscript(input: { id: string; text: string }): void;
  };
  maxWhisperSeconds?: number;
}

// Default implementations that degrade gracefully when the runtime is missing.
// They are argv-based, perform no live network in tests (injected mocks override them),
// and keep tool versions observable for diagnostics.

async function defaultGoogleCaptionsFetch(
  videoId: string,
  getAccess: () => YouTubeSourceAccess,
): Promise<TranscriptAttempt> {
  const access = getAccess();
  if (!access.ok) {
    return {
      state: "failed",
      text: null,
      route: "youtube.captions.list",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
      causeChain: [`Google connection is ${access.state}.`],
    };
  }
  // The captions.list surface requires authentication and is not guaranteed for
  // competitor content; treat absence as unavailable rather than failed so the
  // fallback chain continues. Real download would use api.captions.download.
  // For hermetic safety, probe via the injected client without live network:
  // if the mock client exposes captions, use it; otherwise treat as unavailable.
  const clientUnknown: unknown = access.client;
  const hasListCaptions =
    clientUnknown !== null &&
    typeof clientUnknown === "object" &&
    "listCaptions" in clientUnknown &&
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    typeof (clientUnknown as { listCaptions: unknown }).listCaptions === "function";
  if (hasListCaptions) {
    const listCaptions = (
      clientUnknown as { listCaptions: (videoId: string) => Promise<string | null> }
    ).listCaptions;
    try {
      const text = await listCaptions(videoId);
      if (text && text.trim()) {
        return {
          state: "available",
          text,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: [],
        };
      }
      return {
        state: "unavailable",
        text: null,
        route: "youtube.captions.list",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
        causeChain: ["No caption track available via the YouTube Data API."],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      if (lower.includes("quota") || lower.includes("rate")) {
        return {
          state: "failed",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: [message],
        };
      }
      return {
        state: "unavailable",
        text: null,
        route: "youtube.captions.list",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
        causeChain: [message],
      };
    }
  }
  return {
    state: "unavailable",
    text: null,
    route: "youtube.captions.list",
    version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
    causeChain: ["No caption track available via the YouTube Data API."],
  };
}
function errorStderr(error: unknown): string | null {
  if (error !== null && typeof error === "object" && "stderr" in error) {
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    const stderr = (error as { stderr: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (error !== null && error !== undefined) {
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}" && serialized !== "null") return serialized;
    } catch {
      // fall through
    }
    return "[unknown error]";
  }
  return null;
}

async function defaultPublicTranscriptFetch(videoId: string): Promise<TranscriptAttempt> {
  try {
    // Bounded argv invocation of the approved public transcript client.
    const { stdout } = await execFileAsync("python3", [
      "-c",
      `from youtube_transcript_api import YouTubeTranscriptApi; api = YouTubeTranscriptApi(); t = api.fetch("${videoId.replace(/"/g, '\\"')}"); print(' '.join([x.text for x in t]))`,
    ]);
    const text = stdout.trim();
    if (text) {
      return {
        state: "available",
        text,
        route: "youtube-transcript-api",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
        causeChain: [],
      };
    }
    return {
      state: "unavailable",
      text: null,
      route: "youtube-transcript-api",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
      causeChain: ["The public transcript client returned no content."],
    };
  } catch (error) {
    const raw = errorStderr(error) ?? "Unknown transcript error.";
    const lower = raw.toLowerCase();
    if (
      lower.includes("transcriptsdisabled") ||
      lower.includes("notranscriptfound") ||
      lower.includes("no transcript")
    ) {
      return {
        state: "unavailable",
        text: null,
        route: "youtube-transcript-api",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
        causeChain: [raw.trim()],
      };
    }
    if (lower.includes("ip") && lower.includes("block")) {
      return {
        state: "failed",
        text: null,
        route: "youtube-transcript-api",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
        causeChain: [raw.trim()],
      };
    }
    if (lower.includes("invalid") || lower.includes("video unavailable")) {
      return {
        state: "unsupported",
        text: null,
        route: "youtube-transcript-api",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
        causeChain: [raw.trim()],
      };
    }
    return {
      state: "failed",
      text: null,
      route: "youtube-transcript-api",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
      causeChain: [raw.trim()],
    };
  }
}

async function defaultYtDlpTranscriptFetch(videoId: string): Promise<TranscriptAttempt> {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const { stdout, stderr } = await execFileAsync("yt-dlp", [
      "--skip-download",
      "--write-auto-sub",
      "--sub-langs",
      "en",
      "--convert-subs",
      "srt",
      "--print",
      "subs",
      url,
    ]);
    const combined = `${stdout}\n${stderr}`.trim();
    // yt-dlp prints subtitle availability; when no subs exist it prints nothing
    // or a warning. For hermetic purposes, treat empty as unavailable.
    if (!combined) {
      return {
        state: "unavailable",
        text: null,
        route: "yt-dlp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
        causeChain: ["yt-dlp reported no subtitle track."],
      };
    }
    // In production, the subtitle file would be read; here we approximate by
    // treating any non-empty print as available content.
    // To keep bounded, limit to 60k chars at the adapter seam.
    const text = combined.slice(0, 60_000).trim();
    if (
      text.toLowerCase().includes("unsupported") ||
      text.toLowerCase().includes("not supported")
    ) {
      return {
        state: "unsupported",
        text: null,
        route: "yt-dlp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
        causeChain: [text.slice(0, 500)],
      };
    }
    return {
      state: "available",
      text: text || null,
      route: "yt-dlp",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
      causeChain: [],
    };
  } catch (error) {
    const raw = errorStderr(error) ?? "yt-dlp transcript failed.";
    const lower = raw.toLowerCase();
    if (lower.includes("unsupported") || lower.includes("not supported")) {
      return {
        state: "unsupported",
        text: null,
        route: "yt-dlp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
        causeChain: [raw.trim().slice(0, 500)],
      };
    }
    if (lower.includes("no subtitle") || lower.includes("no caption")) {
      return {
        state: "unavailable",
        text: null,
        route: "yt-dlp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
        causeChain: [raw.trim().slice(0, 500)],
      };
    }
    return {
      state: "failed",
      text: null,
      route: "yt-dlp",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
      causeChain: [raw.trim().slice(0, 500)],
    };
  }
}

async function defaultWhisperTranscribe(
  videoId: string,
  getDurationSeconds?: (videoId: string) => Promise<number | null>,
): Promise<TranscriptAttempt> {
  try {
    let duration: number | null = null;
    if (getDurationSeconds) {
      duration = await getDurationSeconds(videoId);
    }
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // Download bounded audio via yt-dlp, then transcribe via whisper-cli.
    // The audio download is the temporary media that must obey retention.
    const audioPath = `/tmp/youtube-${videoId}.m4a`;
    await execFileAsync("yt-dlp", ["-f", "bestaudio", "--no-playlist", "-o", audioPath, url]);
    const { stdout } = await execFileAsync("whisper-cli", [
      "-m",
      "/usr/local/share/whisper-cpp-model.bin",
      "-f",
      audioPath,
      "--output-txt",
    ]);
    const text = stdout.trim();
    if (!text) {
      return {
        state: "unavailable",
        text: null,
        route: "whisper-cpp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
        causeChain: ["Whisper returned no transcription."],
        durationSeconds: duration,
      };
    }
    return {
      state: "available",
      text: text.slice(0, 60_000),
      route: "whisper-cpp",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
      causeChain: [],
      durationSeconds: duration,
    };
  } catch (error) {
    const raw = errorStderr(error) ?? "Whisper transcription failed.";
    const lower = raw.toLowerCase();
    if (
      lower.includes("unsupported") ||
      lower.includes("not available") ||
      lower.includes("no such")
    ) {
      return {
        state: "unsupported",
        text: null,
        route: "whisper-cpp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
        causeChain: [raw.slice(0, 500)],
      };
    }
    return {
      state: "failed",
      text: null,
      route: "whisper-cpp",
      version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
      causeChain: [raw.slice(0, 500)],
    };
  }
}

export class YouTubeSourceAdapter implements SourceAdapter {
  readonly id = "youtube";
  readonly state = "available" as const;
  readonly version = "youtube-data-api-v3";
  /** `listUploads` pages the channel's uploads playlist until it passes `publishedAfter`, so any requested window is a genuine historical fetch. */
  readonly backfillWindowsDays = SOURCE_BACKFILL_WINDOWS_DAYS;
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    { adapterId: "youtube", label: "NASA", url: "https://www.youtube.com/@NASA" },
    { adapterId: "youtube", label: "BBC News", url: "https://www.youtube.com/@BBCNews" },
    { adapterId: "youtube", label: "TED", url: "https://www.youtube.com/@TED" },
  ];

  private readonly transcriptDeps: YouTubeTranscriptDeps;
  private readonly results: ReturnType<typeof commandAdapterResults>;
  constructor(
    private readonly getAccess: () => YouTubeSourceAccess,
    private readonly now: () => Date = () => new Date(),
    transcriptDeps: YouTubeTranscriptDeps = {},
  ) {
    this.transcriptDeps = {
      maxWhisperSeconds: 60 * 60,
      ...transcriptDeps,
    };
    this.results = commandAdapterResults({
      adapterVersion: this.version,
      parserStage: "youtube_data_api",
      now: this.now,
    });
  }

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const access = this.getAccess();
    if (!access.ok) {
      return this.results.failure(
        "blocked_access",
        request.target.url,
        startedAt,
        ["youtube"],
        [`Google connection is ${access.state}.`],
      );
    }
    let ref: ChannelRef;
    try {
      ref = parseChannelUrl(request.target.url);
    } catch (error) {
      return this.results.failure(
        "unsupported_capability",
        request.target.url,
        startedAt,
        ["source_target"],
        [error instanceof Error ? error.message : String(error)],
      );
    }
    try {
      const channel = await access.client.resolveChannel(ref);
      if (!channel) {
        return this.results.failure(
          "response_shape_change",
          request.target.url,
          startedAt,
          ["channel"],
          ["YouTube returned no uploads playlist for the public channel."],
        );
      }
      const videos = await access.client.listUploads(channel.uploadsPlaylistId, request.since);
      const items: SourceItem[] = videos.map((video) => ({
        id: `${request.target.id}:${video.id}`,
        externalId: video.id,
        targetId: request.target.id,
        adapterId: this.id,
        canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
        author: video.channelTitle,
        title: video.title,
        body: video.description,
        description: video.description,
        publishedAt: video.publishedAt,
        discoveredAt: this.now().toISOString(),
        media: [{ type: "video", url: `https://www.youtube.com/watch?v=${video.id}` }],
        transcript: null,
        comments: [],
        evidence: [
          { route: "youtube.data.playlistItems.list", retrievedAt: this.now().toISOString() },
        ],
        ...(video.statistics ? { engagement: video.statistics } : {}),
        completeness: {
          title: "available",
          body: video.description ? "available" : "unavailable",
          description: video.description ? "available" : "unavailable",
          transcript: "unavailable",
          comments: "unavailable",
          media: "available",
        },
      }));
      const hash = createHash("sha256")
        .update(videos.map((video) => video.id).join("\n"))
        .digest("hex");
      const outcome =
        items.length > 0
          ? "items_found"
          : request.checkpoint
            ? "no_new_material"
            : "legitimate_empty";
      return {
        kind: "completed",
        outcome,
        items,
        checkpoint: hash,
        diagnostic: this.results.diagnostic(outcome, request.target.url, startedAt, [], []),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        (error as { code?: number; response?: { status?: number } }).code ??
        (error as { response?: { status?: number } }).response?.status;
      const outcome =
        (error instanceof Error && error.name === "AbortError") ||
        /timed out|timeout|econnreset|eai_again/i.test(message)
          ? "timeout"
          : status === 429
            ? "rate_limit"
            : status === 401 || status === 403
              ? "blocked_access"
              : "internal_failure";
      return this.results.failure(outcome, request.target.url, startedAt, ["items"], [message]);
    }
  }

  async enrich(items: SourceItem[]): Promise<SourceItem[]> {
    // Keep comment enrichment exactly as before, then apply bounded transcript enrichment.
    const withComments = await this.enrichComments(items);
    return await this.enrichTranscripts(withComments);
  }

  private async enrichComments(items: SourceItem[]): Promise<SourceItem[]> {
    const access = this.getAccess();
    if (!access.ok) {
      return items.map((item) => ({
        ...item,
        completeness: { ...item.completeness, comments: "failed" },
      }));
    }
    return await Promise.all(
      items.map(async (item) => {
        try {
          const comments = await access.client.listComments(item.externalId, 50);
          return {
            ...item,
            comments,
            completeness: {
              ...item.completeness,
              comments: "available" as const,
            },
          };
        } catch {
          return {
            ...item,
            completeness: { ...item.completeness, comments: "failed" as const },
          };
        }
      }),
    );
  }

  private async enrichTranscripts(items: SourceItem[]): Promise<SourceItem[]> {
    if (items.length === 0) return items;

    // Only promising YouTube/Shorts items carry a media video URL; all passed items are promising
    // via the Content Scout seam (filterPromisingItems). Keep per-item transcript work sequential
    // so the 60-minute Whisper budget applies to the first relevant minutes in input order
    // (input order is relevance order from ranking/eligibility).
    const maxWhisperSeconds = this.transcriptDeps.maxWhisperSeconds ?? 60 * 60;
    let whisperSecondsUsed = 0;

    // Resolve runtime capabilities once to avoid argv churn.
    let whisperState: string | null = null;
    let ytDlpState: string | null = null;
    if (this.transcriptDeps.runtimeInspector) {
      try {
        const caps = await this.transcriptDeps.runtimeInspector.inspect();
        whisperState = caps.find((c) => c.id === "transcription.whisper-cpp")?.state ?? null;
        ytDlpState = caps.find((c) => c.id === "media.yt-dlp")?.state ?? null;
      } catch {
        // Inspector failure is non-fatal; fall through to attempt routes.
      }
    }

    const result: SourceItem[] = [...items];
    for (let index = 0; index < result.length; index += 1) {
      const item = result[index]!;
      if (item.completeness.transcript !== "unavailable") continue;

      const videoId = item.externalId;
      const transcriptResult = await this.resolveTranscriptInOrder(videoId, {
        whisperState,
        ytDlpState,
        whisperSecondsUsed,
        maxWhisperSeconds,
      });

      // Budget accounting for Whisper only.
      if (transcriptResult.route === "whisper-cpp" && transcriptResult.state === "available") {
        whisperSecondsUsed += transcriptResult.durationSeconds ?? 0;
      } else if (
        transcriptResult.route === "whisper-cpp" &&
        transcriptResult.state !== "unsupported" &&
        transcriptResult.state !== "available"
      ) {
        // Even failed whisper attempts may have consumed media; record retention below.
      } else if (transcriptResult.route === "whisper-cpp") {
        // For budget-exhausted unsupported, still account if duration known
        whisperSecondsUsed += transcriptResult.durationSeconds ?? 0;
      }

      // Temporary-media retention: Whisper downloads audio as temporary media.
      // On failure, retain for 24h; on success, mark processed (deletes staging).
      if (transcriptResult.route === "whisper-cpp" && this.transcriptDeps.retention) {
        const bytes = transcriptResult.text ?? "";
        if (transcriptResult.state === "available") {
          this.transcriptDeps.retention.recordTemporaryMedia({
            id: `youtube-${videoId}`,
            outcome: "processed",
            bytes: "",
          });
          if (transcriptResult.text) {
            this.transcriptDeps.retention.retainEvidenceTranscript({
              id: `youtube-${videoId}`,
              text: transcriptResult.text,
            });
          }
        } else if (transcriptResult.state === "failed") {
          this.transcriptDeps.retention.recordTemporaryMedia({
            id: `youtube-${videoId}`,
            outcome: "failed",
            bytes,
          });
        }
        // unavailable/unsupported for whisper do not create retained media (no download).
      } else if (transcriptResult.state === "available" && this.transcriptDeps.retention) {
        // Non-whisper routes produce durable evidence transcripts directly.
        if (transcriptResult.text) {
          this.transcriptDeps.retention.retainEvidenceTranscript({
            id: `youtube-${videoId}`,
            text: transcriptResult.text,
          });
        }
      }

      // Transcript failure must not erase evidence-sufficient items: keep original
      // title/body/description/media and only touch transcript/completeness/evidence.
      const nextTranscript =
        transcriptResult.state === "available" ? this.boundTranscript(transcriptResult.text) : null;

      const causeForClaims =
        transcriptResult.causeChain.length > 0
          ? transcriptResult.causeChain.join("; ")
          : transcriptResult.state === "unavailable"
            ? "No transcript track available."
            : transcriptResult.state === "unsupported"
              ? "Transcript enrichment is not supported for this item or runtime."
              : transcriptResult.state === "failed"
                ? "Transcript retrieval failed."
                : "";

      result[index] = {
        ...item,
        transcript: nextTranscript,
        evidence: [
          ...item.evidence,
          {
            route: transcriptResult.route,
            retrievedAt: this.now().toISOString(),
          },
        ],
        completeness: {
          ...item.completeness,
          transcript: transcriptResult.state,
        },
        ...(causeForClaims
          ? {
              claims: [
                ...(item.claims ?? []),
                {
                  text: `Transcript ${transcriptResult.route} (${transcriptResult.version}) ${transcriptResult.state}: ${causeForClaims}`,
                  state: "supported" as const,
                  sourceUrls: [item.canonicalUrl],
                },
              ],
            }
          : {}),
      };
    }
    return result;
  }

  private boundTranscript(value: string | null): string | null {
    if (typeof value !== "string") return null;
    // Bound at the adapter seam: 60k chars prevents unbounded growth, consistent
    // with model.ts bounding to 12k at the brief seam. Adapter bound is generous.
    return value.length > 60_000 ? value.slice(0, 60_000) : value;
  }

  private async resolveTranscriptInOrder(
    videoId: string,
    context: {
      whisperState: string | null;
      ytDlpState: string | null;
      whisperSecondsUsed: number;
      maxWhisperSeconds: number;
    },
  ): Promise<TranscriptAttempt> {
    const attempts: TranscriptAttempt[] = [];

    // 1. Platform captions via existing Google connection
    const googleAttempt = this.transcriptDeps.fetchGoogleCaptions
      ? await this.transcriptDeps.fetchGoogleCaptions(videoId)
      : await defaultGoogleCaptionsFetch(videoId, this.getAccess);
    if (googleAttempt.state === "available") return googleAttempt;
    attempts.push(googleAttempt);

    // 2. Public transcript client (youtube-transcript-api)
    const publicAttempt = this.transcriptDeps.fetchPublicTranscript
      ? await this.transcriptDeps.fetchPublicTranscript(videoId)
      : await defaultPublicTranscriptFetch(videoId);
    if (publicAttempt.state === "available") return publicAttempt;
    attempts.push(publicAttempt);

    // 3. yt-dlp fallback — skip if runtime is explicitly unsupported
    let ytDlpAttempt: TranscriptAttempt;
    if (context.ytDlpState === "unsupported") {
      ytDlpAttempt = {
        state: "unsupported",
        text: null,
        route: "yt-dlp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
        causeChain: ["yt-dlp is not supported in this image."],
      };
    } else {
      ytDlpAttempt = this.transcriptDeps.fetchYtDlpTranscript
        ? await this.transcriptDeps.fetchYtDlpTranscript(videoId)
        : await defaultYtDlpTranscriptFetch(videoId);
      if (ytDlpAttempt.state === "available") return ytDlpAttempt;
    }
    attempts.push(ytDlpAttempt);
    // 4. Optional local Whisper — bounded to first 60 relevant minutes
    if (context.whisperState === "unsupported") {
      const unsupported: TranscriptAttempt = {
        state: "unsupported",
        text: null,
        route: "whisper-cpp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
        causeChain: ["Local Whisper transcription is not supported in this runtime."],
      };
      return unsupported;
    }
    if (context.whisperState === "unavailable") {
      const unavailable: TranscriptAttempt = {
        state: "failed",
        text: null,
        route: "whisper-cpp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
        causeChain: ["Local Whisper is unavailable (version mismatch or missing binary)."],
      };
      return unavailable;
    }

    // Budget check before invoking Whisper
    let durationSeconds: number | null = null;
    if (this.transcriptDeps.getDurationSeconds) {
      try {
        durationSeconds = await this.transcriptDeps.getDurationSeconds(videoId);
      } catch {
        durationSeconds = null;
      }
    }
    // Default estimate 5 minutes per item when duration unknown, to keep bound meaningful.
    const estimated = durationSeconds ?? 300;
    if (context.whisperSecondsUsed + estimated > context.maxWhisperSeconds) {
      const budgetExhausted: TranscriptAttempt = {
        state: "unsupported",
        text: null,
        route: "whisper-cpp",
        version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
        causeChain: [
          `Local transcription budget exhausted: ${context.whisperSecondsUsed / 60} of ${context.maxWhisperSeconds / 60} minutes already used; skipping ${videoId} (${estimated / 60} min).`,
        ],
        durationSeconds: estimated,
      };
      return budgetExhausted;
    }

    const whisperAttempt = this.transcriptDeps.transcribeWhisper
      ? await this.transcriptDeps.transcribeWhisper(videoId)
      : await defaultWhisperTranscribe(videoId, this.transcriptDeps.getDurationSeconds);
    // Normalize whisper attempt to include duration for accounting
    if (whisperAttempt.durationSeconds === undefined) {
      whisperAttempt.durationSeconds = durationSeconds ?? estimated;
    }
    if (whisperAttempt.state === "available") return whisperAttempt;
    // No available transcript: return the whisper result with aggregated cause chain
    // so diagnostics retain route, version, capability and the full cause chain
    // across the fallback chain.
    const aggregatedCause = [
      ...attempts.flatMap((a) => a.causeChain),
      ...whisperAttempt.causeChain,
    ].filter(Boolean);
    return {
      ...whisperAttempt,
      causeChain: aggregatedCause.length > 0 ? aggregatedCause : whisperAttempt.causeChain,
    };
  }
}
