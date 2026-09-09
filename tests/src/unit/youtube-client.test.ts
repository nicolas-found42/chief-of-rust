import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAuth } from "../../../apps/server/src/google/oauth";
import { youtubeClient } from "../../../apps/server/src/modules/youtube/client";

const sdk = vi.hoisted(() => {
  const api = {
    channels: { list: vi.fn() },
    playlistItems: { list: vi.fn() },
    videos: { list: vi.fn() },
  };
  return { api, youtube: vi.fn(() => api) };
});

vi.mock("googleapis", () => ({ google: { youtube: sdk.youtube } }));

const auth = {} as GoogleAuth;

beforeEach(() => {
  vi.clearAllMocks();
  sdk.api.channels.list.mockResolvedValue({ data: { items: [] } });
  sdk.api.playlistItems.list.mockResolvedValue({ data: { items: [] } });
  sdk.api.videos.list.mockResolvedValue({ data: { items: [] } });
});

describe("YouTube client", () => {
  it.each([
    [{ kind: "handle" as const, value: "@found42" }, { forHandle: "@found42" }],
    [{ kind: "id" as const, value: "UC_found42" }, { id: ["UC_found42"] }],
    [{ kind: "username" as const, value: "Found42" }, { forUsername: "Found42" }],
  ])("resolves a channel from its supported reference", async (ref, lookup) => {
    sdk.api.channels.list.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "UC_found42",
            snippet: { customUrl: "@found42", title: "Found42" },
            contentDetails: { relatedPlaylists: { uploads: "UU_found42" } },
          },
        ],
      },
    });

    await expect(youtubeClient(auth).resolveChannel(ref)).resolves.toEqual({
      id: "UC_found42",
      handle: "@found42",
      title: "Found42",
      uploadsPlaylistId: "UU_found42",
    });
    expect(sdk.api.channels.list).toHaveBeenCalledWith({
      part: ["snippet", "contentDetails"],
      maxResults: 1,
      ...lookup,
    });
  });

  it("returns null when the channel is absent", async () => {
    await expect(
      youtubeClient(auth).resolveChannel({ kind: "handle", value: "@nobody" }),
    ).resolves.toBeNull();
  });

  it("returns null when a channel has no uploads playlist", async () => {
    sdk.api.channels.list.mockResolvedValueOnce({ data: { items: [{ id: "UC_orphan" }] } });
    await expect(
      youtubeClient(auth).resolveChannel({ kind: "id", value: "UC_orphan" }),
    ).resolves.toBeNull();
  });

  it("falls back to stable channel identifiers when optional display fields are absent", async () => {
    sdk.api.channels.list.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "UC_plain",
            contentDetails: { relatedPlaylists: { uploads: "UU_plain" } },
          },
        ],
      },
    });

    await expect(
      youtubeClient(auth).resolveChannel({ kind: "id", value: "UC_plain" }),
    ).resolves.toMatchObject({ handle: "", title: "UC_plain" });
  });

  it("enumerates every uploads page and ignores entries without a video id", async () => {
    sdk.api.playlistItems.list
      .mockResolvedValueOnce({
        data: {
          items: [{ contentDetails: { videoId: "video-1" } }, { contentDetails: {} }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ contentDetails: { videoId: "video-2" } }] },
      });

    await expect(youtubeClient(auth).listUploads("UU_found42")).resolves.toEqual([
      "video-1",
      "video-2",
    ]);
    expect(sdk.api.playlistItems.list).toHaveBeenNthCalledWith(1, {
      part: ["contentDetails"],
      playlistId: "UU_found42",
      maxResults: 50,
    });
    expect(sdk.api.playlistItems.list).toHaveBeenNthCalledWith(2, {
      part: ["contentDetails"],
      playlistId: "UU_found42",
      maxResults: 50,
      pageToken: "page-2",
    });
  });

  it("returns video counts and names every id Google omitted", async () => {
    sdk.api.videos.list.mockResolvedValueOnce({
      data: {
        items: [
          { id: "video-1", snippet: { title: "Launch" }, statistics: { viewCount: "120" } },
          { id: "video-2", statistics: {} },
          { snippet: { title: "No id" }, statistics: { viewCount: "999" } },
        ],
      },
    });

    await expect(
      youtubeClient(auth).videoStatistics(["video-1", "video-2", "video-gone"]),
    ).resolves.toEqual({
      videos: [
        { id: "video-1", title: "Launch", viewCount: 120 },
        { id: "video-2", title: "video-2", viewCount: 0 },
      ],
      failedIds: ["video-gone"],
    });
    expect(sdk.api.videos.list).toHaveBeenCalledWith({
      part: ["snippet", "statistics"],
      id: ["video-1", "video-2", "video-gone"],
    });
  });
});
