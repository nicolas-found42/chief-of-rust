import { google } from "googleapis";
import type { YoutubeVideoCount } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "../../google/oauth.js";
import type { ChannelRef } from "../../source-adapters/youtube-channels.js";

/**
 * The three calls this Module makes, and nothing else. Narrow on purpose: it is
 * the seam a test drives, and the same shape the Drive Intake's client already
 * has.
 */
export interface YouTubeClient {
  /** The channel as Google knows it, or null when it knows no such channel. */
  resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null>;
  /** Every video id in an uploads playlist, paged to the end. */
  listUploads(playlistId: string): Promise<string[]>;
  /** Statistics for one chunk of ids: what came back, and what did not. */
  videoStatistics(ids: string[]): Promise<{ videos: YoutubeVideoCount[]; failedIds: string[] }>;
}

interface ResolvedChannel {
  id: string;
  handle: string;
  title: string;
  uploadsPlaylistId: string;
}

/**
 * Ids per statistics call. Google documents no maximum for this method — the
 * fifty quoted elsewhere belongs to a different one, whose page says so — and
 * an undocumented limit is not a limit to assume. Fifty is the conservative
 * choice; a larger one is a measured change.
 */
export const STATISTICS_CHUNK = 50;

/** Playlist page size, which Google does document as fifty. */
const PLAYLIST_PAGE = 50;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function youtubeClient(auth: GoogleAuth): YouTubeClient {
  const api = google.youtube({ version: "v3", auth });
  return {
    async resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null> {
      const params: Record<string, unknown> = {
        part: ["snippet", "contentDetails"],
        maxResults: 1,
      };
      if (ref.kind === "handle") {
        params.forHandle = ref.value;
      } else if (ref.kind === "id") {
        params.id = [ref.value];
      } else {
        params.forUsername = ref.value;
      }
      const response = await api.channels.list(params);
      const found = response.data.items?.[0];
      const uploads = found?.contentDetails?.relatedPlaylists?.uploads;
      if (!found?.id || !uploads) {
        return null;
      }
      return {
        id: found.id,
        /* Google returns the handle with its @; a channel that has none reads
           as an empty string rather than a guess at one. */
        handle: found.snippet?.customUrl ?? "",
        title: found.snippet?.title ?? found.id,
        uploadsPlaylistId: uploads,
      };
    },

    async listUploads(playlistId: string): Promise<string[]> {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const response = await api.playlistItems.list({
          part: ["contentDetails"],
          playlistId,
          maxResults: PLAYLIST_PAGE,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of response.data.items ?? []) {
          const id = item.contentDetails?.videoId;
          if (id) {
            ids.push(id);
          }
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
      return ids;
    },

    async videoStatistics(ids) {
      /* No maxResults: Google documents it as unsupported alongside `id`, and
         the chunk is already the page. */
      const response = await api.videos.list({
        part: ["snippet", "statistics"],
        id: ids,
      });
      const videos: YoutubeVideoCount[] = [];
      for (const item of response.data.items ?? []) {
        if (!item.id) {
          continue;
        }
        videos.push({
          id: item.id,
          title: item.snippet?.title ?? item.id,
          viewCount: Number(item.statistics?.viewCount ?? 0),
        });
      }
      /* Derived rather than read: this method omits an id it cannot answer for
         instead of reporting it, so what is missing from the answer *is* the
         list of failures. A deleted or private video is a fact about that
         video, so it is named and the Run finishes. */
      const answered = new Set(videos.map((video) => video.id));
      return { videos, failedIds: ids.filter((id) => !answered.has(id)) };
    },
  };
}
