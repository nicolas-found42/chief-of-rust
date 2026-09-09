import type {
  AdapterDiagnostic,
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

const INSTALOADER_TIMEOUT_MS = 180_000;
const YT_DLP_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PROFILE_POSTS = 50;
const MAX_REEL_COMMENTS = 30;

const runInstaloaderWorker = publicCommandRunner({
  executable: "python3",
  timeoutMs: INSTALOADER_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});

const runYtDlpCommand = publicCommandRunner({
  executable: "yt-dlp",
  timeoutMs: YT_DLP_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});

/**
 * A deliberately Experimental anonymous Instagram route. Public profiles are
 * collected through an isolated `python3` Instaloader worker that never logs
 * in and never writes media or session files (`download_*` and `save_metadata`
 * are all off, `iphone_support` is off so no private-iPhone endpoints are ever
 * reached). Known public Reels are enriched through an isolated `yt-dlp`
 * invocation that only dumps JSON (`--dump-single-json --skip-download`): no
 * media is ever downloaded by this adapter.
 *
 * Profile collection and Reel enrichment keep separate field completeness and
 * diagnostics: collection yields caption/title/media fields and never claims
 * comment access, while enrichment adds bounded comments per Reel and marks
 * that field available/unavailable/failed/unsupported independently.
 *
 * Access challenges, login walls, rate limits, parser changes, unsupported
 * targets, and command failures are classified loudly on the command
 * boundary. No authenticated session, imported cookie, private content,
 * CAPTCHA bypass, or proxy evasion is used anywhere in this adapter.
 */
export class InstagramInstaloaderAdapter implements SourceAdapter {
  readonly id = "instagram";
  readonly state = "experimental" as const;
  readonly version = "instagram-instaloader-v1";
  readonly canaryTargets: readonly SourceAdapterCanaryTarget[] = [
    { adapterId: "instagram", label: "NASA", url: "https://www.instagram.com/nasa/" },
    { adapterId: "instagram", label: "NatGeo", url: "https://www.instagram.com/natgeo/" },
    { adapterId: "instagram", label: "BBC News", url: "https://www.instagram.com/bbcnews/" },
  ];
  private readonly results: ReturnType<typeof commandAdapterResults>;

  constructor(
    private readonly runProfile: PublicCommandRunner = runInstaloaderWorker,
    private readonly runYtDlp: PublicCommandRunner = runYtDlpCommand,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.results = commandAdapterResults({
      adapterVersion: this.version,
      parserStage: "instaloader",
      now: this.now,
    });
  }

  supports(target: { adapterId: string }): boolean {
    return target.adapterId === this.id;
  }

  async collect(request: Parameters<SourceAdapter["collect"]>[0]): Promise<SourceCollectionResult> {
    const startedAt = this.now().toISOString();
    const route = instagramRoute(request.target.url);
    if (route.kind === "unsupported") {
      return this.results.failure(
        "unsupported_capability",
        request.target.url,
        startedAt,
        ["source_target"],
        [route.reason],
      );
    }
    if (route.kind === "reel") {
      return this.collectReel(route, request, startedAt);
    }
    const result = await this.runProfile(["-c", INSTALOADER_PROFILE_SCRIPT, route.handle]);
    if (result.code !== 0) {
      const classified = classifyPublicCommandFailure(result.stderr, "Instagram", result.timedOut);
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
    const workerError = instaloaderWorkerError(data);
    if (workerError) {
      return this.results.failure(
        workerError.outcome,
        request.target.url,
        startedAt,
        workerError.affectedCapabilities,
        [workerError.message],
      );
    }
    const items = normalizeInstagramProfileItems(
      data,
      route.handle,
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
        ["The Instaloader worker returned a profile payload with no recognizable public posts."],
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

  private async collectReel(
    route: Extract<InstagramRoute, { kind: "reel" }>,
    request: Parameters<SourceAdapter["collect"]>[0],
    startedAt: string,
  ): Promise<SourceCollectionResult> {
    const result = await this.runYtDlp(
      reelYtDlpArgs(`https://www.instagram.com/reel/${route.shortcode}`),
    );
    if (result.code !== 0) {
      const classified = classifyPublicCommandFailure(result.stderr, "Instagram", result.timedOut);
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
    const items = normalizeInstagramReelItems(
      data,
      route.shortcode,
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
        ["yt-dlp returned an Instagram payload with no recognizable public Reel."],
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
   * Bounded optional enrichment: yt-dlp comments for the collected Reels that
   * are promising enough to reach the second pass. A missing yt-dlp runtime is
   * a declared `unsupported` comments field; a per-Reel worker failure marks
   * that field `failed` with a claim, while a successful dump whose payload
   * exposes no comments marks it `unavailable`. When every Reel worker fails
   * the whole call throws, so the shared enrichment path counts a loud warning
   * while collected fields stay untouched.
   */
  async enrich(items: SourceItem[]): Promise<SourceItem[]> {
    const reels = items.filter(
      (item) => /\/reel\/[A-Za-z0-9_-]+/.test(item.canonicalUrl) && item.comments.length === 0,
    );
    if (reels.length === 0) {
      return items.map((item) => ({
        ...item,
        completeness: { ...item.completeness, comments: "unsupported" as const },
      }));
    }
    const ytDlpAvailable = await this.ytDlpInstalled();
    if (!ytDlpAvailable) {
      return items.map((item) =>
        reels.some((reel) => reel.id === item.id)
          ? {
              ...item,
              completeness: { ...item.completeness, comments: "unsupported" as const },
            }
          : item,
      );
    }
    const enriched = await Promise.all(
      reels.map(async (item): Promise<SourceItem> => {
        const retrievedAt = this.now().toISOString();
        try {
          const result = await this.runYtDlp(reelYtDlpArgs(item.canonicalUrl));
          if (result.code !== 0) {
            const message =
              result.stderr
                .split("\n")
                .map((line) => line.trim())
                .find(Boolean) ?? "yt-dlp exited without a diagnostic for this public Reel.";
            throw new Error(message);
          }
          let reelRecord: Record<string, unknown>;
          try {
            reelRecord = JSON.parse(result.stdout) as Record<string, unknown>;
          } catch (error) {
            throw new Error(
              `yt-dlp returned an unparseable Instagram payload: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
          }
          const comments = parseInstagramReelComments(reelRecord, item.externalId);
          return {
            ...item,
            comments: comments ?? [],
            evidence: [...item.evidence, { route: item.canonicalUrl, retrievedAt }],
            completeness: {
              ...item.completeness,
              comments: comments ? ("available" as const) : ("unavailable" as const),
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ...item,
            evidence: [...item.evidence, { route: item.canonicalUrl, retrievedAt }],
            completeness: { ...item.completeness, comments: "failed" as const },
            claims: [
              ...(item.claims ?? []),
              {
                text: `Instagram Reel enrichment failed for ${item.canonicalUrl}: ${message}`,
                state: "unsupported" as const,
                sourceUrls: [item.canonicalUrl],
              },
            ],
          };
        }
      }),
    );
    if (enriched.every((item) => item.completeness.comments === "failed")) {
      throw new Error(
        `Instagram Reel enrichment failed for every Reel (${enriched.length} Reel(s)).`,
      );
    }
    const byId = new Map(enriched.map((item) => [item.id, item]));
    return items.map((item) => byId.get(item.id) ?? item);
  }

  private async ytDlpInstalled(): Promise<boolean> {
    const result = await this.runYtDlp(["--version"]);
    return result.code === 0;
  }
}

/**
 * The bounded Instaloader profile worker. It never logs in, never imports
 * cookies, never downloads media, never writes metadata or session files, and
 * disables iPhone endpoints. It reads at most `MAX_PROFILE_POSTS` posts from
 * the public timeline and emits a small JSON record per post from the node
 * itself (no per-post metadata fetches), so collection stays bounded. Every
 * classified failure is emitted as a structured `error` record on stdout.
 */
const INSTALOADER_PROFILE_SCRIPT = [
  "import json",
  "import sys",
  "from instaloader import Instaloader, Profile",
  "from instaloader.exceptions import ConnectionException, LoginRequiredException, ProfileNotExistsException, TooManyRequestsException",
  `MAX_POSTS = ${MAX_PROFILE_POSTS}`,
  "handle = sys.argv[1]",
  "loader = Instaloader(quiet=True, download_pictures=False, download_videos=False, download_video_thumbnails=False, download_geotags=False, download_comments=False, save_metadata=False, compress_json=False, post_metadata_txt_pattern=None, max_connection_attempts=2, request_timeout=30.0, iphone_support=False, resume_prefix=None)",
  "try:",
  "    profile = Profile.from_username(loader.context, handle)",
  "except ProfileNotExistsException as exc:",
  '    print(json.dumps({"error": {"kind": "profile_not_found", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except TooManyRequestsException as exc:",
  '    print(json.dumps({"error": {"kind": "rate_limit", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except LoginRequiredException as exc:",
  '    print(json.dumps({"error": {"kind": "login_required", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except ConnectionException as exc:",
  '    print(json.dumps({"error": {"kind": "connection", "message": str(exc)}}))',
  "    sys.exit(0)",
  "if profile.is_private:",
  '    print(json.dumps({"error": {"kind": "private_profile", "message": "Profile " + handle + " is private; anonymous collection is not possible."}}))',
  "    sys.exit(0)",
  "posts = []",
  "try:",
  "    for index, post in enumerate(profile.get_posts()):",
  "        if index >= MAX_POSTS:",
  "            break",
  '        posts.append({"shortcode": post.shortcode, "mediaid": post.mediaid, "typename": post.typename, "is_video": post.is_video, "date_utc": post.date_utc.strftime("%Y-%m-%dT%H:%M:%SZ"), "caption": post.caption})',
  "except TooManyRequestsException as exc:",
  '    print(json.dumps({"error": {"kind": "rate_limit", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except LoginRequiredException as exc:",
  '    print(json.dumps({"error": {"kind": "login_required", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except ConnectionException as exc:",
  '    print(json.dumps({"error": {"kind": "connection", "message": str(exc)}}))',
  "    sys.exit(0)",
  "except Exception as exc:",
  '    print(json.dumps({"error": {"kind": "parser_change", "message": type(exc).__name__ + ": " + str(exc)}}))',
  "    sys.exit(0)",
  'print(json.dumps({"username": profile.username, "full_name": profile.full_name, "posts": posts}))',
].join("\n");

type InstagramRoute =
  | { kind: "profile"; handle: string }
  | { kind: "reel"; shortcode: string }
  | { kind: "unsupported"; reason: string };

function instagramRoute(value: string): InstagramRoute {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "unsupported", reason: "The Source Target is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      kind: "unsupported",
      reason: "Instagram Source Targets must use public HTTP(S) URLs.",
    };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "instagram.com") {
    return {
      kind: "unsupported",
      reason: `Instagram adapter does not support host ${url.hostname}.`,
    };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const shortcode = /^[A-Za-z0-9_-]+$/.test(segments[0] ?? "") ? segments[0] : null;
  if (segments.length === 1 && shortcode && shortcode.length >= 2 && shortcode !== "reel") {
    return { kind: "profile", handle: shortcode };
  }
  if (
    (segments.length === 2 && segments[0] === "reel" && segments[1] !== undefined) ||
    (segments.length === 3 && segments[1] === "reel" && segments[2] !== undefined)
  ) {
    const code = segments.length === 2 ? segments[1] : segments[2]!;
    if (/^[A-Za-z0-9_-]{2,}$/.test(code)) {
      return { kind: "reel", shortcode: code };
    }
  }
  return {
    kind: "unsupported",
    reason:
      "Only public Instagram profiles (instagram.com/<handle>) and individual Reels (instagram.com/reel/<code>) are supported.",
  };
}

/** Metadata-only yt-dlp flags shared by Reel collection and enrichment. */
function reelYtDlpArgs(url: string): string[] {
  return [
    "--ignore-config",
    "--no-warnings",
    "--socket-timeout",
    "30",
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    url,
  ];
}

interface WorkerError {
  outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"];
  affectedCapabilities: AdapterDiagnostic["affectedCapabilities"];
  message: string;
}

/** Structured errors the Instaloader worker emits on stdout. */
function instaloaderWorkerError(data: unknown): WorkerError | null {
  if (!data || typeof data !== "object") return null;
  const error = (data as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message.trim()
      : "The Instaloader worker reported a failure without a diagnostic.";
  if (kind === "login_required") {
    return { outcome: "blocked_access", affectedCapabilities: ["items", "comments"], message };
  }
  if (kind === "private_profile" || kind === "profile_not_found") {
    return { outcome: "blocked_access", affectedCapabilities: ["items"], message };
  }
  if (kind === "rate_limit") {
    return { outcome: "rate_limit", affectedCapabilities: ["items"], message };
  }
  if (kind === "connection") {
    return /timeout|timed out|econnreset|eai_again/i.test(message)
      ? { outcome: "timeout", affectedCapabilities: ["items"], message }
      : { outcome: "internal_failure", affectedCapabilities: ["items"], message };
  }
  if (kind === "parser_change") {
    return { outcome: "response_shape_change", affectedCapabilities: ["items"], message };
  }
  return { outcome: "internal_failure", affectedCapabilities: ["items"], message };
}

/**
 * Normalize one Instaloader profile payload; `null` means the payload has no
 * recognizable post list. Each post becomes a normalized SourceItem with the
 * caption as body/description; comments are never claimed by collection.
 */
function normalizeInstagramProfileItems(
  data: unknown,
  handle: string,
  targetId: string,
  adapterId: string,
  since: string,
  now: () => Date,
): SourceItem[] | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.posts)) return null;
  const sinceMs = Date.parse(since);
  const author = stringValue(record.full_name) ?? handle;
  const items: SourceItem[] = [];
  for (const entry of record.posts) {
    if (!entry || typeof entry !== "object") continue;
    const post = entry as Record<string, unknown>;
    const shortcode = stringValue(post.shortcode);
    if (!shortcode) continue;
    const dateUtc = stringValue(post.date_utc);
    const publishedAt =
      dateUtc && !Number.isNaN(Date.parse(dateUtc)) ? new Date(dateUtc).toISOString() : null;
    if (publishedAt && Date.parse(publishedAt) < sinceMs) continue;
    const caption = stringValue(post.caption);
    const isVideo = post.is_video === true;
    const canonicalUrl = isVideo
      ? `https://www.instagram.com/${handle}/reel/${shortcode}`
      : `https://www.instagram.com/p/${shortcode}`;
    items.push({
      id: `${targetId}:${shortcode}`,
      externalId: shortcode,
      targetId,
      adapterId,
      canonicalUrl,
      author,
      title: null,
      body: caption,
      description: caption,
      publishedAt,
      discoveredAt: now().toISOString(),
      media: [{ type: isVideo ? "video" : "image", url: canonicalUrl }],
      transcript: null,
      comments: [],
      evidence: [
        { route: `https://www.instagram.com/${handle}`, retrievedAt: now().toISOString() },
      ],
      completeness: {
        title: "unavailable",
        body: caption ? "available" : "unavailable",
        description: caption ? "available" : "unavailable",
        transcript: "unsupported",
        comments: "unavailable",
        media: "available",
      },
    });
  }
  return items;
}

/**
 * Normalize one yt-dlp Reel payload; `null` means the payload has no
 * recognizable Reel. Comments ride along when the anonymous payload exposes
 * them; otherwise the field stays `unavailable`, never a silent success.
 */
function normalizeInstagramReelItems(
  data: unknown,
  shortcode: string,
  targetId: string,
  adapterId: string,
  since: string,
  now: () => Date,
): SourceItem[] | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const payloadId = stringValue(record.id);
  if (payloadId !== shortcode) return null;
  const timestamp = numberValue(record.timestamp);
  const publishedAt = timestamp ? new Date(timestamp * 1000).toISOString() : null;
  if (publishedAt && Date.parse(publishedAt) < Date.parse(since)) return [];
  const description = stringValue(record.description);
  const author = stringValue(record.channel) ?? stringValue(record.uploader);
  const canonicalUrl = `https://www.instagram.com/reel/${shortcode}`;
  const comments = parseInstagramReelComments(record, shortcode);
  return [
    {
      id: `${targetId}:${shortcode}`,
      externalId: shortcode,
      targetId,
      adapterId,
      canonicalUrl,
      author,
      title: null,
      body: description,
      description,
      publishedAt,
      discoveredAt: now().toISOString(),
      media: [{ type: "video", url: canonicalUrl }],
      transcript: null,
      comments: comments ?? [],
      evidence: [{ route: canonicalUrl, retrievedAt: now().toISOString() }],
      completeness: {
        title: "unavailable",
        body: description ? "available" : "unavailable",
        description: description ? "available" : "unavailable",
        transcript: "unsupported",
        comments: comments ? "available" : "unavailable",
        media: "available",
      },
    },
  ];
}

/**
 * Normalize a yt-dlp Instagram payload's comment rows into the shared
 * SourceComment contract. Returns `null` when the payload exposes no comments
 * at all, and a (possibly empty) list when it does. Instagram comment
 * permalinks are stable (`/p/<code>/c/<comment-id>/`), so they are kept.
 */
function parseInstagramReelComments(
  record: Record<string, unknown>,
  shortcode: string,
): SourceComment[] | null {
  const comments = record.comments;
  if (!Array.isArray(comments) || comments.length === 0) return null;
  return comments.slice(0, MAX_REEL_COMMENTS).flatMap((entry): SourceComment[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const text = stringValue(record.text);
    if (!text) return [];
    const commentId = stringValue(record.id);
    const createTime = numberValue(record.timestamp);
    return [
      {
        author: stringValue(record.author),
        publishedAt: createTime ? new Date(createTime * 1000).toISOString() : null,
        url: commentId ? `https://www.instagram.com/p/${shortcode}/c/${commentId}/` : null,
        text,
        engagement: null,
      },
    ];
  });
}
