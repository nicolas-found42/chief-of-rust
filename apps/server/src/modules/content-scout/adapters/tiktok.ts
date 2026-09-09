import type {
  SourceAdapterCanaryTarget,
  SourceComment,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import type {
  SourceAdapter,
  SourceCollectionResult,
} from "../../../source-adapters/source-adapter.js";
import { responseHash } from "../../../source-adapters/http.js";
import {
  checkpointOf,
  classifyPublicCommandFailure,
  commandAdapterResults,
  numberValue,
  publicCommandRunner,
  stringValue,
  type PublicCommandRunner,
} from "../../../source-adapters/public-command.js";

const YT_DLP_TIMEOUT_MS = 90_000;
const PYTHON_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export type TikTokCommandRunner = PublicCommandRunner;

const runYtDlp = publicCommandRunner({
  executable: "yt-dlp",
  timeoutMs: YT_DLP_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});

const runPython3 = publicCommandRunner({
  executable: "python3",
  timeoutMs: PYTHON_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});

/**
 * A deliberately Experimental anonymous TikTok route that collects public user
 * pages and individual videos through an isolated `yt-dlp` invocation. Every
 * command is argv-based (no shell) and runs with `--ignore-config` so a
 * machine's yt-dlp config cannot inject cookies or proxies. Collection uses
 * `--dump-single-json` only: no media is ever downloaded by this adapter.
 *
 * Pyktok is never part of collection. It is optional bounded enrichment
 * (comments) behind a separate Python worker boundary that never imports
 * browser cookies (`specify_browser` is deliberately not called). A missing
 * Pyktok runtime marks the comments field `unsupported`; a failing worker marks
 * it `failed`; neither can affect the collected items.
 *
 * No authenticated session, imported cookie, CAPTCHA bypass, or proxy evasion
 * is used anywhere in this adapter.
 */
export class TikTokYtDlpAdapter implements SourceAdapter {
  readonly id = "tiktok";
  readonly state = "experimental" as const;
  readonly version = "tiktok-yt-dlp-v1";
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    { adapterId: "tiktok", label: "Charli D'Amelio", url: "https://www.tiktok.com/@charlidamelio" },
    { adapterId: "tiktok", label: "Khaby Lame", url: "https://www.tiktok.com/@khaby.lame" },
    { adapterId: "tiktok", label: "Addison Rae", url: "https://www.tiktok.com/@addisonre" },
  ];
  private readonly results: ReturnType<typeof commandAdapterResults>;

  constructor(
    private readonly run: TikTokCommandRunner = runYtDlp,
    private readonly runPython: TikTokCommandRunner = runPython3,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.results = commandAdapterResults({
      adapterVersion: this.version,
      parserStage: "yt_dlp",
      now: this.now,
    });
  }

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const route = tiktokRoute(request.target.url);
    if (route.kind === "unsupported") {
      return this.results.failure(
        "unsupported_capability",
        request.target.url,
        startedAt,
        ["source_target"],
        [route.reason],
      );
    }
    const result = await this.run(ytDlpArgs(route));
    if (result.code !== 0) {
      const classified = classifyPublicCommandFailure(result.stderr, "TikTok", result.timedOut);
      return this.results.failure(
        classified.outcome,
        request.target.url,
        startedAt,
        classified.affectedCapabilities,
        [classified.message, ...(result.stderr.trim() ? [result.stderr.trim()] : [])].filter(
          Boolean,
        ),
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      return this.results.failure(
        "response_shape_change",
        request.target.url,
        startedAt,
        ["items"],
        [error instanceof Error ? error.message : String(error)],
      );
    }
    const items = normalizeTikTokItems(
      data,
      route,
      request.target.id,
      this.id,
      request.since,
      this.now,
    );
    if (items === null) {
      return this.results.failure(
        "response_shape_change",
        request.target.url,
        startedAt,
        ["items"],
        ["yt-dlp returned a TikTok payload with no recognizable public video entries."],
      );
    }
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
      checkpoint: checkpointOf(items),
      diagnostic: {
        ...this.results.diagnostic(outcome, request.target.url, startedAt, [], []),
        responseHash: responseHash(result.stdout),
      },
    };
  }

  /**
   * Bounded optional enrichment: Pyktok comments for the video items that are
   * promising enough to reach the second pass. A missing Pyktok runtime is a
   * declared `unsupported` comments field (the Shell's runtime inspection
   * already reports `python.pyktok` loudly); a per-video worker failure marks
   * that field `failed` and preserves the other items' enrichment. When every
   * video worker fails the whole call throws, so the shared enrichment path
   * counts a loud warning while collected fields stay untouched.
   */
  async enrich(items: SourceItem[]): Promise<SourceItem[]> {
    const videos = items.filter((item) => /\/video\/\d+/.test(item.canonicalUrl));
    if (videos.length === 0) {
      return items.map((item) => ({
        ...item,
        completeness: { ...item.completeness, comments: "unsupported" as const },
      }));
    }
    const pyktokAvailable = await this.pyktokInstalled();
    if (!pyktokAvailable) {
      return items.map((item) => ({
        ...item,
        completeness: { ...item.completeness, comments: "unsupported" as const },
      }));
    }
    const enriched = await Promise.all(
      videos.map(async (item): Promise<SourceItem> => {
        try {
          const comments = await this.runPyktokWorker(item.canonicalUrl);
          return {
            ...item,
            comments,
            completeness: { ...item.completeness, comments: "available" as const },
          };
        } catch {
          return {
            ...item,
            completeness: {
              ...item.completeness,
              comments: "failed" as const,
            },
          };
        }
      }),
    );
    if (enriched.every((item) => item.completeness.comments === "failed")) {
      throw new Error(
        `Pyktok comment enrichment failed for every TikTok video (${enriched.length} video(s)).`,
      );
    }
    const byId = new Map(enriched.map((item) => [item.id, item]));
    return items.map((item) => byId.get(item.id) ?? item);
  }

  private async pyktokInstalled(): Promise<boolean> {
    const result = await this.runPython([
      "-c",
      "import importlib.metadata; importlib.metadata.version('pyktok')",
    ]);
    return result.code === 0;
  }

  private async runPyktokWorker(videoUrl: string): Promise<SourceComment[]> {
    const result = await this.runPython(["-c", PYKTOK_COMMENT_SCRIPT, videoUrl]);
    if (result.code !== 0) {
      const message =
        result.stderr
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean) ?? "Pyktok comment worker exited without a diagnostic.";
      throw new Error(`pyktok comment worker failed: ${message}`);
    }
    const comments = parseTikTokComments(result.stdout);
    if (comments.length === 0) {
      throw new Error("Pyktok comment worker returned no recognizable comment rows.");
    }
    return comments;
  }
}

/**
 * The bounded Pyktok comment worker. It calls `save_tiktok_comments` with no
 * CSV writes and normalizes the returned rows to JSON on stdout. `specify_browser`
 * (browser-cookie import) is deliberately never called: cookie-less operation is
 * exactly the bounded, authenticated-nothing contract this enrichment promises.
 */
const PYKTOK_COMMENT_SCRIPT = [
  "import json",
  "import sys",
  "import pyktok as pyk",
  "url = sys.argv[1]",
  "data = pyk.save_tiktok_comments(url, comment_count=30, save_comments=False, return_comments=True)",
  "rows = data.to_dict(orient='records') if hasattr(data, 'to_dict') else data",
  "print(json.dumps(rows))",
].join("; ");

/** Normalize Pyktok's comment rows into the shared SourceComment contract. */
function parseTikTokComments(stdout: string): SourceComment[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): SourceComment[] => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const text = stringValue(record.text);
    if (!text) return [];
    const createTime = numberValue(record.create_time);
    return [
      {
        author: stringValue(record.author),
        publishedAt: createTime ? new Date(createTime * 1000).toISOString() : null,
        // TikTok exposes no stable public per-comment permalink, so the field
        // stays null rather than inventing a URL that would not resolve.
        url: null,
        text,
        engagement: numberValue(record.digg_count),
      },
    ];
  });
}

type TikTokRoute =
  | { kind: "user"; handle: string }
  | { kind: "video"; handle: string; videoId: string }
  | { kind: "unsupported"; reason: string };

function tiktokRoute(value: string): TikTokRoute {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "unsupported", reason: "The Source Target is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "unsupported", reason: "TikTok Source Targets must use public HTTP(S) URLs." };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "tiktok.com") {
    return { kind: "unsupported", reason: `TikTok adapter does not support host ${url.hostname}.` };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0]!.startsWith("@")) {
    return { kind: "user", handle: segments[0]!.slice(1) };
  }
  if (
    segments.length === 3 &&
    segments[0]!.startsWith("@") &&
    segments[1] === "video" &&
    /^\d+$/.test(segments[2]!)
  ) {
    return { kind: "video", handle: segments[0]!.slice(1), videoId: segments[2]! };
  }
  return {
    kind: "unsupported",
    reason:
      "Only public TikTok user pages (@handle) and individual videos (@handle/video/<id>) are supported.",
  };
}

function ytDlpArgs(route: Exclude<TikTokRoute, { kind: "unsupported" }>): string[] {
  const base = ["--ignore-config", "--no-warnings", "--socket-timeout", "30", "--dump-single-json"];
  if (route.kind === "user") {
    return [
      ...base,
      "--flat-playlist",
      "--playlist-end",
      "50",
      `https://www.tiktok.com/@${route.handle}`,
    ];
  }
  return [
    ...base,
    "--no-playlist",
    `https://www.tiktok.com/@${route.handle}/video/${route.videoId}`,
  ];
}

/** Normalize one yt-dlp payload; `null` means the payload has no recognizable shape. */
function normalizeTikTokItems(
  data: unknown,
  route: Exclude<TikTokRoute, { kind: "unsupported" }>,
  targetId: string,
  adapterId: string,
  since: string,
  now: () => Date,
): SourceItem[] | null {
  const records: Record<string, unknown>[] = [];
  if (route.kind === "user") {
    if (!data || typeof data !== "object") return null;
    const entries = (data as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (entry && typeof entry === "object") records.push(entry as Record<string, unknown>);
    }
  } else if (data && typeof data === "object") {
    records.push(data as Record<string, unknown>);
  } else {
    return null;
  }
  const sinceMs = Date.parse(since);
  const items: SourceItem[] = [];
  for (const record of records) {
    const videoId = stringValue(record.id);
    if (!videoId) continue;
    const timestamp = numberValue(record.timestamp);
    const publishedAt = timestamp ? new Date(timestamp * 1000).toISOString() : null;
    if (publishedAt && Date.parse(publishedAt) < sinceMs) continue;
    const title = stringValue(record.title);
    const description = stringValue(record.description);
    const uploader = stringValue(record.uploader) ?? stringValue(record.uploader_id);
    const canonicalUrl =
      route.kind === "video"
        ? `https://www.tiktok.com/@${route.handle}/video/${videoId}`
        : (stringValue(record.url) ?? `https://www.tiktok.com/@${route.handle}/video/${videoId}`);
    items.push({
      id: `${targetId}:${videoId}`,
      externalId: videoId,
      targetId,
      adapterId,
      canonicalUrl,
      author: uploader ?? route.handle,
      title,
      body: description,
      description,
      publishedAt,
      discoveredAt: now().toISOString(),
      media: [{ type: "video", url: canonicalUrl }],
      transcript: null,
      comments: [],
      evidence: [
        {
          route: route.kind === "user" ? `https://www.tiktok.com/@${route.handle}` : canonicalUrl,
          retrievedAt: now().toISOString(),
        },
      ],
      completeness: {
        title: title ? "available" : "unavailable",
        body: description ? "available" : "unavailable",
        description: description ? "available" : "unavailable",
        transcript: "unsupported",
        comments: "unavailable",
        media: "available",
      },
    });
  }
  return items;
}
