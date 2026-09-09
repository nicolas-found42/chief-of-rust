import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstagramInstaloaderAdapter } from "../../../apps/server/src/modules/content-scout/adapters/instagram";
import type { SourceItem, SourceTarget } from "@chief-of-staff-demo/shared";

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

const profileRequest = {
  target: target("instagram", "https://www.instagram.com/publicmaker"),
  since: "2026-08-18T12:00:00.000Z",
  until: NOW.toISOString(),
  checkpoint: null,
};

const reelRequest = {
  target: target("instagram", "https://www.instagram.com/reel/ABCdef123XyZ"),
  since: "2026-08-18T12:00:00.000Z",
  until: NOW.toISOString(),
  checkpoint: null,
};

describe("Instagram Instaloader Source Adapter fixture contract", () => {
  it("normalizes a public profile through the isolated Instaloader route", async () => {
    let invoked: string[] | null = null;
    const adapter = new InstagramInstaloaderAdapter(
      async (args) => {
        invoked = args;
        return { stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 };
      },
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect(profileRequest);
    expect(adapter.state).toBe("experimental");
    expect(adapter.version).toBe("instagram-instaloader-v1");
    // The production command boundary is exact: one `python3 -c` worker, argv
    // only, with the handle as the only positional argument.
    expect(invoked).toEqual(["-c", expect.any(String), "publicmaker"]);
    const script = invoked![1];
    // The worker never logs in, never imports cookies, never downloads media,
    // never writes metadata or session files, and disables iPhone endpoints.
    expect(script).toContain("download_pictures=False");
    expect(script).toContain("download_videos=False");
    expect(script).toContain("download_video_thumbnails=False");
    expect(script).toContain("save_metadata=False");
    expect(script).toContain("iphone_support=False");
    expect(script).toContain("resume_prefix=None");
    expect(script).not.toMatch(/\.login\(|load_session|save_session|cookie/i);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      diagnostic: {
        classification: "items_found",
        parserStage: "instaloader",
        adapterVersion: "instagram-instaloader-v1",
      },
    });
    expect(result.items).toHaveLength(2);
    // A Reel normalizes to its Reel route; a picture post to its canonical /p/ route.
    expect(result.items[0]).toMatchObject({
      externalId: "ABCdef123XyZ",
      canonicalUrl: "https://www.instagram.com/publicmaker/reel/ABCdef123XyZ",
      adapterId: "instagram",
      author: "Public Maker Studio",
      body: "One practical interoperability rule every public maker should know.",
      description: "One practical interoperability rule every public maker should know.",
      media: [{ type: "video", url: "https://www.instagram.com/publicmaker/reel/ABCdef123XyZ" }],
      completeness: {
        title: "unavailable",
        body: "available",
        description: "available",
        transcript: "unsupported",
        comments: "unavailable",
        media: "available",
      },
    });
    expect(result.items[0]?.publishedAt).toBe("2026-08-22T09:30:00.000Z");
    expect(result.items[1]).toMatchObject({
      externalId: "XyZ987abcDEF",
      canonicalUrl: "https://www.instagram.com/p/XyZ987abcDEF",
      media: [{ type: "image", url: "https://www.instagram.com/p/XyZ987abcDEF" }],
    });
    // The stale fixture post is outside the collection window and must not
    // appear as an empty success or a stale item.
    expect(result.items.map((item) => item.externalId)).toEqual(["ABCdef123XyZ", "XyZ987abcDEF"]);
    expect(result.checkpoint).toEqual(expect.any(String));
  });

  it("keeps a legitimate empty public account distinct from a failed fetch", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-empty.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      ...profileRequest,
      target: target("instagram", "https://www.instagram.com/quietaccount"),
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "legitimate_empty",
      items: [],
    });
    const unchanged = await adapter.collect({
      ...profileRequest,
      target: target("instagram", "https://www.instagram.com/quietaccount"),
      checkpoint: "existing-checkpoint",
    });
    expect(unchanged).toMatchObject({ kind: "completed", outcome: "no_new_material", items: [] });
  });

  it.each([
    ["login wall", "instagram-login-required.json", "blocked_access", ["items", "comments"]],
    ["private profile", "instagram-private-profile.json", "blocked_access", ["items"]],
    ["rate limit", "instagram-rate-limit.json", "rate_limit", ["items"]],
    ["profile not found", "instagram-profile-not-found.json", "blocked_access", ["items"]],
    ["parser change", "instagram-parser-change.json", "response_shape_change", ["items"]],
  ] as const)(
    "classifies the structured Instaloader worker error %s loudly",
    async (_name, fixtureName, outcome, affectedCapabilities) => {
      const adapter = new InstagramInstaloaderAdapter(
        async () => ({ stdout: fixture(fixtureName), stderr: "", code: 0 }),
        async () => ({ stdout: "", stderr: "", code: 0 }),
        () => NOW,
      );
      const result = await adapter.collect(profileRequest);
      expect(result).toMatchObject({
        kind: "failed",
        outcome,
        items: [],
        diagnostic: { affectedCapabilities },
      });
    },
  );

  it.each([
    [
      "login wall on stderr",
      "ERROR: [Instagram] publicmaker: login required",
      "blocked_access",
      ["items", "comments"],
    ],
    ["rate limit on stderr", "ERROR: Too many requests (429)", "rate_limit", ["items"]],
    [
      "parser change on stderr",
      "ERROR: no supported extractor for instagram.com",
      "unsupported_capability",
      ["source_target"],
    ],
    ["timeout on stderr", "ERROR: Connection timed out", "timeout", ["items"]],
    [
      "internal failure on stderr",
      "ERROR: Unexpected network error",
      "internal_failure",
      ["items"],
    ],
  ] as const)(
    "classifies the %s on the command boundary",
    async (_name, stderr, outcome, affectedCapabilities) => {
      const adapter = new InstagramInstaloaderAdapter(
        async () => ({ stdout: "", stderr, code: 1 }),
        async () => ({ stdout: "", stderr: "", code: 0 }),
        () => NOW,
      );
      const result = await adapter.collect(profileRequest);
      expect(result).toMatchObject({
        kind: "failed",
        outcome,
        diagnostic: { affectedCapabilities },
      });
    },
  );

  it("keeps unsupported target kinds explicit instead of guessing", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      async () => ({ stdout: "{}", stderr: "", code: 0 }),
      () => NOW,
    );
    for (const url of [
      "https://www.instagram.com/explore/tags/practical",
      "https://www.instagram.com/stories/publicmaker/",
    ]) {
      const result = await adapter.collect({
        ...profileRequest,
        target: target("instagram", url),
      });
      expect(result).toMatchObject({
        kind: "failed",
        outcome: "unsupported_capability",
        diagnostic: { affectedCapabilities: ["source_target"] },
      });
    }
  });

  it("normalizes a known public Reel through the bounded yt-dlp route", async () => {
    let invoked: string[] | null = null;
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "", stderr: "", code: 0 }),
      async (args) => {
        invoked = args;
        return { stdout: fixture("instagram-reel.json"), stderr: "", code: 0 };
      },
      () => NOW,
    );
    const result = await adapter.collect(reelRequest);
    // The production command boundary is exact: metadata-only flags, no media
    // download (`-o`, `--write-*`, `--download-sections`), no config/cookie
    // import, so nothing temporary is ever retained by collection.
    expect(invoked).toEqual([
      "--ignore-config",
      "--no-warnings",
      "--socket-timeout",
      "30",
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      "https://www.instagram.com/reel/ABCdef123XyZ",
    ]);
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      diagnostic: {
        classification: "items_found",
        parserStage: "instaloader",
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      externalId: "ABCdef123XyZ",
      canonicalUrl: "https://www.instagram.com/reel/ABCdef123XyZ",
      adapterId: "instagram",
      author: "publicmaker",
      description: "One practical interoperability rule every public maker should know.",
      media: [{ type: "video", url: "https://www.instagram.com/reel/ABCdef123XyZ" }],
      completeness: {
        title: "unavailable",
        body: "available",
        comments: "available",
        media: "available",
      },
    });
    expect(result.items[0]?.publishedAt).toBe("2026-08-22T09:30:00.000Z");
    // yt-dlp comments normalize into the shared contract with stable permalinks.
    expect(result.items[0]?.comments).toEqual([
      {
        author: "builder_alice",
        publishedAt: "2026-08-20T10:05:00.000Z",
        url: "https://www.instagram.com/p/ABCdef123XyZ/c/17842000000000001/",
        text: "How would a small team apply this?",
        engagement: null,
      },
      {
        author: "skeptic_bob",
        publishedAt: "2026-08-20T10:06:00.000Z",
        url: "https://www.instagram.com/p/ABCdef123XyZ/c/17842000000000002/",
        text: "This contradicts the guidance we saw last week.",
        engagement: null,
      },
      {
        author: "maker_carol",
        publishedAt: "2026-08-20T10:07:00.000Z",
        url: "https://www.instagram.com/p/ABCdef123XyZ/c/17842000000000003/",
        text: "Useful breakdown, thanks.",
        engagement: null,
      },
    ]);
  });

  it("keeps a Reel without public comments distinct from a failed enrichment", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "", stderr: "", code: 0 }),
      async () => ({ stdout: fixture("instagram-reel-no-comments.json"), stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect({
      ...reelRequest,
      target: target("instagram", "https://www.instagram.com/reel/QuietReel00001"),
    });
    expect(result).toMatchObject({
      kind: "completed",
      outcome: "items_found",
      items: [
        {
          externalId: "QuietReel00001",
          completeness: { comments: "unavailable" },
        },
      ],
    });
  });

  it("classifies a Reel response-shape change as a loud failure, not an empty success", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: "", stderr: "", code: 0 }),
      async () => ({ stdout: fixture("instagram-shape-change.json"), stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect(reelRequest);
    expect(result).toMatchObject({
      kind: "failed",
      outcome: "response_shape_change",
      diagnostic: {
        affectedCapabilities: ["items"],
        parserStage: "instaloader",
      },
    });
  });

  it("keeps yt-dlp Reel enrichment optional and never a hidden collection requirement", async () => {
    const collected = await new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "", code: 0 }),
      () => NOW,
    ).collect(profileRequest);
    expect(collected.kind).toBe("completed");

    // yt-dlp absent: the version probe fails, comments stay explicitly
    // unsupported, and collected evidence is untouched.
    const withoutYtDlp = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "", stderr: "command not found", code: 1 }),
      () => NOW,
    );
    const collectedAgain = await withoutYtDlp.collect(profileRequest);
    const enriched = await withoutYtDlp.enrich(collectedAgain.items);
    expect(enriched[0]).toMatchObject({ completeness: { comments: "unsupported" } });
    expect(enriched[0]?.body).toBe(collectedAgain.items[0]?.body);
    // A non-Reel item is untouched by Reel enrichment.
    const imagePost = enriched.find((item) => item.externalId === "XyZ987abcDEF");
    expect(imagePost).toMatchObject({ completeness: { comments: "unavailable" } });
  });

  it("normalizes bounded yt-dlp comments and marks worker failures as failed fields", async () => {
    let ytDlpCalls = 0;
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async (args) => {
        ytDlpCalls += 1;
        if (args.some((arg) => arg === "--version")) {
          return { stdout: "2025.08.22", stderr: "", code: 0 };
        }
        return { stdout: fixture("instagram-reel.json"), stderr: "", code: 0 };
      },
      () => NOW,
    );
    const result = await adapter.collect(profileRequest);
    const enriched = await adapter.enrich(result.items);
    expect(ytDlpCalls).toBe(2); // one version probe, one Reel worker
    const reel = enriched.find((item) => item.externalId === "ABCdef123XyZ");
    expect(reel?.comments).toHaveLength(3);
    expect(reel).toMatchObject({ completeness: { comments: "available" } });
    expect(reel?.evidence).toHaveLength(2);

    const failing = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async (args) => {
        if (args.some((arg) => arg === "--version")) {
          return { stdout: "2025.08.22", stderr: "", code: 0 };
        }
        if (args.some((arg) => arg.includes("QuietReel00001"))) {
          return { stdout: fixture("instagram-reel-no-comments.json"), stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "ERROR: Instagram blocked this worker", code: 1 };
      },
      () => NOW,
    );
    const failedResult = await failing.collect(profileRequest);
    // One Reel that fails and one Reel that answers without comments: the
    // failed Reel keeps its collected fields, marks comments failed, and
    // records a claim, while the answered Reel is explicitly unavailable.
    const withSecondReel = [
      ...failedResult.items,
      {
        ...failedResult.items[0],
        externalId: "QuietReel00001",
        id: `${failedResult.items[0].id}:quiet`,
        canonicalUrl: "https://www.instagram.com/publicmaker/reel/QuietReel00001",
        media: [
          {
            type: "video" as const,
            url: "https://www.instagram.com/publicmaker/reel/QuietReel00001",
          },
        ],
      },
    ];
    const failedEnriched = await failing.enrich(withSecondReel);
    const failedReel = failedEnriched.find((item) => item.externalId === "ABCdef123XyZ");
    expect(failedReel).toMatchObject({
      completeness: { comments: "failed" },
      claims: [
        {
          text: expect.stringContaining("Instagram Reel enrichment failed"),
          state: "unsupported",
          sourceUrls: ["https://www.instagram.com/publicmaker/reel/ABCdef123XyZ"],
        },
      ],
    });
    expect(failedEnriched.find((item) => item.externalId === "QuietReel00001")).toMatchObject({
      completeness: { comments: "unavailable" },
    });
    // When every Reel worker fails the enrichment call stays loud so the shared
    // path counts a warning, rather than silently returning failed fields.
    await expect(failing.enrich(failedResult.items)).rejects.toThrow(
      /Instagram Reel enrichment failed for every Reel/,
    );
  });

  it("marks every collected item's comments unsupported when there are no Reels to enrich", async () => {
    const adapter = new InstagramInstaloaderAdapter(
      async () => ({ stdout: fixture("instagram-profile-page.json"), stderr: "", code: 0 }),
      async () => ({ stdout: "2025.08.22", stderr: "", code: 0 }),
      () => NOW,
    );
    const result = await adapter.collect(profileRequest);
    const onlyImages = result.items.map((item): SourceItem => ({
      ...item,
      canonicalUrl: "https://www.instagram.com/p/XyZ987abcDEF",
      media: [{ type: "image", url: "https://www.instagram.com/p/XyZ987abcDEF" }],
    }));
    const enriched = await adapter.enrich(onlyImages);
    expect(enriched.every((item) => item.completeness.comments === "unsupported")).toBe(true);
  });
});
