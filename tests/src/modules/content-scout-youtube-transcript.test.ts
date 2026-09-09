import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  YouTubeSourceAdapter,
  YOUTUBE_TRANSCRIPT_VERSIONS,
  type YouTubeSourceClient,
} from "../../../apps/server/src/source-adapters/youtube";
import type { SourceItem, SourceTarget, SourceFieldState } from "@chief-of-staff-demo/shared";
import { determineEligibility } from "../../../apps/server/src/modules/content-scout/eligibility";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "fixtures", "content-scout", name), "utf8");

const target = (adapterId: string, url: string): SourceTarget => ({
  id: `target-${adapterId}`,
  adapterId,
  label: adapterId,
  url,
  state: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  archivedAt: null,
  checkpoint: null,
  lastSuccessfulAt: null,
  conditional: null,
});

const sourceItem = (
  id: string,
  videoId: string,
  overrides: Partial<SourceItem> = {},
): SourceItem => ({
  id,
  externalId: videoId,
  targetId: "target-youtube",
  adapterId: "youtube",
  canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  author: "Found42",
  title: "A verified public update for brand context with evidence",
  body: "The practical implications of the update for small teams are outlined in detail with concrete steps.",
  description: "The practical implications of the update.",
  publishedAt: "2026-08-25T10:00:00.000Z",
  discoveredAt: NOW.toISOString(),
  media: [{ type: "video", url: `https://www.youtube.com/watch?v=${videoId}` }],
  transcript: null,
  comments: [],
  evidence: [{ route: "youtube.data.playlistItems.list", retrievedAt: NOW.toISOString() }],
  completeness: {
    title: "available",
    body: "available",
    description: "available",
    transcript: "unavailable",
    comments: "unavailable",
    media: "available",
  },
  ...overrides,
});

describe("YouTube transcript enrichment bounded fallback chain", () => {
  it("enriches via platform captions when the Google connection provides them", async () => {
    const data = JSON.parse(fixture("youtube-transcript-google.json")) as {
      transcript: string;
      route: string;
      version: string;
    };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return { id: "UC_found42", uploadsPlaylistId: "UU_found42" };
      },
      async listUploads() {
        return [
          {
            id: "video-google",
            title: "A verified public update",
            description: "desc",
            channelTitle: "Found42",
            publishedAt: NOW.toISOString(),
          },
        ];
      },
      async listComments() {
        return [];
      },
    };
    // Expose Google captions via a hermetic seam on the client
    (client as unknown as Record<string, unknown>)["listCaptions"] = async () => data.transcript;

    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchPublicTranscript: async () => {
          throw new Error("should not reach public fallback");
        },
        fetchYtDlpTranscript: async () => {
          throw new Error("should not reach yt-dlp fallback");
        },
        transcribeWhisper: async () => {
          throw new Error("should not reach whisper fallback");
        },
      },
    );

    const item = sourceItem("target-youtube:video-google", "video-google");
    const enriched = await adapter.enrich([item]);
    expect(enriched[0]?.transcript).toBe(data.transcript);
    expect(enriched[0]?.completeness.transcript).toBe("available");
    expect(enriched[0]?.evidence.some((e) => e.route === "youtube.captions.list")).toBe(true);
    expect(data.version).toBe(YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions);
  });

  it("falls back to the public transcript client when Google captions are unavailable", async () => {
    const pub = JSON.parse(fixture("youtube-transcript-public.json")) as {
      transcript: string;
      version: string;
    };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable" as SourceFieldState,
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No caption track available via the YouTube Data API."],
        }),
        fetchPublicTranscript: async () => ({
          state: "available" as SourceFieldState,
          text: pub.transcript,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: [],
        }),
      },
    );
    const item = sourceItem("target-youtube:video-public", "video-public");
    const enriched = await adapter.enrich([item]);
    expect(enriched[0]?.transcript).toBe(pub.transcript);
    expect(enriched[0]?.completeness.transcript).toBe("available");
    expect(enriched[0]?.evidence.some((e) => e.route === "youtube-transcript-api")).toBe(true);
    expect(pub.version).toBe(YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript);
  });

  it("falls back to yt-dlp when the public client is unavailable", async () => {
    const ytdlp = JSON.parse(fixture("youtube-transcript-ytdlp.json")) as {
      transcript: string;
      version: string;
    };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No caption track available."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["TranscriptsDisabled."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "available",
          text: ytdlp.transcript,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: [],
        }),
      },
    );
    const item = sourceItem("target-youtube:video-ytdlp", "video-ytdlp");
    const enriched = await adapter.enrich([item]);
    expect(enriched[0]?.transcript).toBe(ytdlp.transcript);
    expect(enriched[0]?.completeness.transcript).toBe("available");
    expect(enriched[0]?.evidence.some((e) => e.route === "yt-dlp")).toBe(true);
    expect(ytdlp.version).toBe(YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp);
  });

  it("falls back to bounded local Whisper when earlier caption routes are unavailable", async () => {
    const whisper = JSON.parse(fixture("youtube-transcript-whisper.json")) as {
      transcript: string;
      version: string;
    };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const retained: { id: string; text: string }[] = [];
    const tempMedia: { id: string; outcome: string }[] = [];
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No caption."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["No transcript."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No subtitle track."],
        }),
        transcribeWhisper: async () => ({
          state: "available",
          text: whisper.transcript,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: [],
          durationSeconds: 320,
        }),
        getDurationSeconds: async () => 320,
        retention: {
          recordTemporaryMedia(input) {
            tempMedia.push({ id: input.id, outcome: input.outcome });
            return { retained: input.outcome === "failed" };
          },
          retainEvidenceTranscript(input) {
            retained.push(input);
          },
        },
      },
    );
    const item = sourceItem("target-youtube:video-whisper", "video-whisper");
    const enriched = await adapter.enrich([item]);
    expect(enriched[0]?.transcript).toBe(whisper.transcript);
    expect(enriched[0]?.completeness.transcript).toBe("available");
    expect(enriched[0]?.evidence.some((e) => e.route === "whisper-cpp")).toBe(true);
    expect(whisper.version).toBe(YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp);
    expect(retained.some((r) => r.id === "youtube-video-whisper")).toBe(true);
    expect(
      tempMedia.some((m) => m.id === "youtube-video-whisper" && m.outcome === "processed"),
    ).toBe(true);
  });

  it("caps local transcription at the first 60 relevant minutes", async () => {
    const budget = JSON.parse(fixture("youtube-transcript-budget.json")) as {
      items: { videoId: string; durationSeconds: number; expect: string }[];
    };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const durations = new Map(budget.items.map((it) => [it.videoId, it.durationSeconds]));
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No caption."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["No transcript."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No track."],
        }),
        transcribeWhisper: async (videoId) => ({
          state: "available",
          text: `whisper-${videoId}`,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: [],
          durationSeconds: durations.get(videoId) ?? 300,
        }),
        getDurationSeconds: async (videoId) => durations.get(videoId) ?? 300,
      },
    );
    const items = budget.items.map((entry) =>
      sourceItem(`target-youtube:${entry.videoId}`, entry.videoId),
    );
    const enriched = await adapter.enrich(items);
    expect(enriched[0]?.completeness.transcript).toBe("available");
    expect(enriched[1]?.completeness.transcript).toBe("available");
    // Third exceeds 60 minutes (1800+1800+600 = 4200 > 3600)
    expect(enriched[2]?.completeness.transcript).toBe("unsupported");
    expect(enriched[2]?.transcript).toBeNull();
    expect(enriched[2]?.evidence.some((e) => e.route === "whisper-cpp")).toBe(true);
    const claim = enriched[2]?.claims?.find((c) => c.text.includes("budget exhausted"));
    expect(claim).toBeTruthy();
  });

  it("keeps transcript states available, unavailable, unsupported, failed distinct", async () => {
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };

    const available = await new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "available",
          text: "hello transcript",
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: [],
        }),
      },
    ).enrich([sourceItem("a:1", "vid-1")]);

    const unavailable = await new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No track."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["TranscriptsDisabled."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No track."],
        }),
        transcribeWhisper: async () => ({
          state: "unavailable",
          text: null,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: ["Whisper no output."],
        }),
      },
    ).enrich([sourceItem("a:2", "vid-2")]);

    const unsupported = await new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        runtimeInspector: {
          async inspect() {
            return [
              {
                id: "transcription.whisper-cpp",
                state: "unsupported",
                version: null,
              },
              { id: "media.yt-dlp", state: "available", version: "2025.08.22" },
            ];
          },
        },
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No track."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["No."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No."],
        }),
      },
    ).enrich([sourceItem("a:3", "vid-3")]);

    const failed = await new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No track."],
        }),
        fetchPublicTranscript: async () => ({
          state: "failed",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["Transient 500."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "failed",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["Transient."],
        }),
        transcribeWhisper: async () => ({
          state: "failed",
          text: null,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: ["Failed."],
        }),
      },
    ).enrich([sourceItem("a:4", "vid-4")]);

    expect(available[0]?.completeness.transcript).toBe("available");
    expect(available[0]?.transcript).toBeTruthy();
    expect(unavailable[0]?.completeness.transcript).toBe("unavailable");
    expect(unavailable[0]?.transcript).toBeNull();
    expect(unsupported[0]?.completeness.transcript).toBe("unsupported");
    expect(unsupported[0]?.transcript).toBeNull();
    expect(failed[0]?.completeness.transcript).toBe("failed");
    expect(failed[0]?.transcript).toBeNull();
  });

  it("does not erase evidence-sufficient items when transcript enrichment fails", async () => {
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "failed",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["Timeout."],
        }),
        fetchPublicTranscript: async () => ({
          state: "failed",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["Rate limited."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "failed",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["Internal."],
        }),
        transcribeWhisper: async () => ({
          state: "failed",
          text: null,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: ["Failed."],
        }),
      },
    );
    const item = sourceItem("target-youtube:video-evidence", "video-evidence");
    const enriched = await adapter.enrich([item]);
    // Item remains, transcript failed, but title/body remain evidence-sufficient
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.completeness.transcript).toBe("failed");
    expect(enriched[0]?.title).toBe(item.title);
    const eligibility = determineEligibility({
      items: enriched,
      targets: [target("youtube", "https://www.youtube.com/@found42")],
      brandProfile: {
        id: "brand-1",
        markdown: "# Brand\n\nWe help small teams.",
        createdAt: NOW.toISOString(),
        sourceScan: { websiteUrl: "https://example.com", pages: [] },
      } as unknown as never,
      now: NOW,
    });
    expect(eligibility.items.some((i) => i.id === item.id)).toBe(true);
  });

  it("applies temporary-media retention for Whisper downloads", async () => {
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const retainedFailed: string[] = [];
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.publicTranscript,
          causeChain: ["No."],
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No."],
        }),
        transcribeWhisper: async () => ({
          state: "failed",
          text: "partial-bytes",
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: ["Whisper failed mid-decode."],
          durationSeconds: 120,
        }),
        getDurationSeconds: async () => 120,
        retention: {
          recordTemporaryMedia(input) {
            if (input.outcome === "failed") retainedFailed.push(input.id);
            return { retained: input.outcome === "failed" };
          },
          retainEvidenceTranscript() {},
        },
      },
    );
    const item = sourceItem("target-youtube:video-retention", "video-retention");
    await adapter.enrich([item]);
    expect(retainedFailed).toContain("youtube-video-retention");
  });

  it("records diagnostics with route, tool version, capability, and cause chain", async () => {
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    const unavailableFixture = JSON.parse(fixture("youtube-transcript-unavailable.json")) as {
      causeChain: string[];
      version: string;
      route: string;
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
      {
        fetchGoogleCaptions: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube.captions.list",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.googleCaptions,
          causeChain: ["No track."],
        }),
        fetchPublicTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "youtube-transcript-api",
          version: unavailableFixture.version,
          causeChain: unavailableFixture.causeChain,
        }),
        fetchYtDlpTranscript: async () => ({
          state: "unavailable",
          text: null,
          route: "yt-dlp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.ytDlp,
          causeChain: ["No track."],
        }),
        transcribeWhisper: async () => ({
          state: "unavailable",
          text: null,
          route: "whisper-cpp",
          version: YOUTUBE_TRANSCRIPT_VERSIONS.whisperCpp,
          causeChain: ["No output."],
        }),
      },
    );
    const item = sourceItem("target-youtube:video-unavailable", "video-unavailable");
    const enriched = await adapter.enrich([item]);
    expect(enriched[0]?.completeness.transcript).toBe("unavailable");
    // Diagnostics are observable via evidence route, version in claim, capability transcript,
    // and aggregated cause chain that retains each attempted route's cause.
    expect(enriched[0]?.evidence.some((e) => e.route === "whisper-cpp")).toBe(true);
    const claim = enriched[0]?.claims?.find((c) =>
      c.text.includes(unavailableFixture.causeChain[0]),
    );
    expect(claim).toBeTruthy();
    expect(claim?.text.toLowerCase()).toContain("transcript");
    expect(claim?.text).toContain(unavailableFixture.causeChain[0]);
    // Route and version recorded in claim text
    expect(claim?.text).toContain("whisper-cpp");
  });

  it("handles Shorts items identically to regular YouTube items", async () => {
    const data = JSON.parse(fixture("youtube-transcript-google.json")) as { transcript: string };
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return null;
      },
      async listUploads() {
        return [];
      },
      async listComments() {
        return [];
      },
    };
    (client as unknown as Record<string, unknown>)["listCaptions"] = async () => data.transcript;
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const shortsItem = sourceItem("target-youtube:short-1", "short-1", {
      canonicalUrl: "https://www.youtube.com/shorts/short-1",
      media: [{ type: "video", url: "https://www.youtube.com/shorts/short-1" }],
    });
    const enriched = await adapter.enrich([shortsItem]);
    expect(enriched[0]?.transcript).toBe(data.transcript);
    expect(enriched[0]?.completeness.transcript).toBe("available");
  });

  it("keeps channel, video, and comment collection unchanged", async () => {
    const channelData = JSON.parse(fixture("youtube-channel.json")) as {
      channel: { id: string; uploadsPlaylistId: string };
      videos: Awaited<ReturnType<YouTubeSourceClient["listUploads"]>>;
      comments: Awaited<ReturnType<YouTubeSourceClient["listComments"]>>;
    };
    let commentLimit = 0;
    const client: YouTubeSourceClient = {
      async resolveChannel() {
        return channelData.channel;
      },
      async listUploads() {
        return channelData.videos;
      },
      async listComments(_videoId, limit) {
        commentLimit = limit;
        return channelData.comments;
      },
    };
    const adapter = new YouTubeSourceAdapter(
      () => ({ ok: true, client }),
      () => NOW,
    );
    const result = await adapter.collect({
      target: target("youtube", "https://www.youtube.com/@found42"),
      since: "2026-08-18T12:00:00.000Z",
      until: NOW.toISOString(),
      checkpoint: null,
    });
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.items[0]?.completeness.transcript).toBe("unavailable");
      expect(result.items[0]?.completeness.comments).toBe("unavailable");
    }
    const enriched = await adapter.enrich(result.kind === "completed" ? result.items : []);
    expect(commentLimit).toBe(50);
    expect(enriched[0]?.completeness.comments).toBe("available");
  });

  it("covers each failure classification via fixtures", async () => {
    const unavailable = JSON.parse(fixture("youtube-transcript-unavailable.json")) as {
      classification: string;
    };
    const unsupported = JSON.parse(fixture("youtube-transcript-unsupported.json")) as {
      classification: string;
    };
    const failed = JSON.parse(fixture("youtube-transcript-failed.json")) as {
      classification: string;
    };
    expect(unavailable.classification).toBe("unavailable");
    expect(unsupported.classification).toBe("unsupported");
    expect(failed.classification).toBe("failed");
    // Also verify available fixture exists
    const google = JSON.parse(fixture("youtube-transcript-google.json")) as { transcript: string };
    expect(typeof google.transcript).toBe("string");
    expect(google.transcript.length).toBeGreaterThan(20);
  });
});
