import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type {
  BrandProfileCrawler,
  BrandProfileProposer,
  OpportunityRanker,
  RuntimeInspector,
} from "../modules/content-scout/ports.js";
import type { SourceAdapter } from "../source-adapters/source-adapter.js";
import type { PersonProfileStore } from "../person-profile/store.js";
import type { Runs } from "../runs.js";
import type {
  MeetingBriefEvent,
  MeetingBriefRunResult,
  PersonEvidence,
} from "@chief-of-staff-demo/shared";
import { modelBrandProfileProposer } from "../modules/content-scout/brand-profile.js";
import type { OwnerOnboarding } from "../onboarding/owner.js";
import { TranscriptIdentityService } from "../transcript-catalog/identity.js";
import { TranscriptCatalog } from "../transcript-catalog/catalog.js";
import { TranscriptIdentityStore } from "../transcript-catalog/identity-store.js";
import { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import type { MigrationGate } from "./migration.js";
import { readMigrationState } from "../migration/workspace.js";
export interface TestSeedContext {
  /** The Workspace directory, so seeded product areas write the same store. */
  workspaceDir: string;
  /**
   * Seeds one fixture Run directly on the Shell's Run store (issue #142).
   * Transcript → Tasks used to be the vehicle for these; it is retired, and
   * the Shell surfaces these journeys cover — the Runs list, Run detail,
   * failure guidance — are the Shell's own, so the fixture is built here
   * rather than through a Module that no longer exists.
   */
  seedFixtureRun: (spec: {
    fileName: string;
    /** Present for the conversion-failure scenario, absent for a clean Run. */
    bytes?: Buffer;
  }) => Promise<string>;
  createFailedRun: () => string;
  /** The Workspace Person Profile store, so the journey can arrange sourced
      evidence before exercising repair through the real product surface. */
  personStore: PersonProfileStore;
  ownerOnboarding: OwnerOnboarding;
  runs: Runs;
  upsertMeetingBriefEvent?: (event: MeetingBriefEvent) => void;
  /**
   * The migration gate seam (issue #144): arm clears the completed marker and
   * activates the hold, disarm restores the hermetic post-cutover state.
   * Present only when ENABLE_TEST_SEED builds the browser suite's server.
   */
  migration?: {
    gate: MigrationGate;
    /** Re-writes the parked hermetic defaults the reset deletes. */
    restoreHermeticDefaults: () => void;
    /**
     * Resolves when every in-flight intake pass, relay wake-up, and enqueued
     * Module Run has settled — arm waits on it before returning, so the reset
     * never deletes runs/ under a live execute (issue #144).
     */
    drainModules: () => Promise<void>;
  };
}

const SEED_CORPUS = [
  {
    externalFileId: "seed-sync",
    fileName: "Weekly Product Sync — 2026-08-17T13-00-00.000Z.md",
    body: `[00:00] Dana: Morning everyone. Three things today — the Acme renewal, the onboarding redesign, and the support queue.
[00:12] Sam: Ticket volume was down about fifteen percent, but we got six separate reports of the export button timing out on large accounts.
[00:30] Priya: That's the synchronous export path. It needs to move to a background job.
[00:52] Marcus: Second round of the onboarding flow is done. I cut the plan-selection step entirely.
[01:14] Dana: For the Acme renewal we are holding at the current tier, no additional discount.
`,
  },
  {
    externalFileId: "seed-board",
    fileName: "Board Prep — 2026-08-19T10-00-00.000Z.md",
    body: `[00:00] Jordan: Board prep — the investor update draft is due Thursday.
[00:20] Riley: I'll pull the churn numbers and the hiring plan before the meeting.
`,
  },
  {
    externalFileId: "seed-offsite",
    fileName: "Design Offsite — 2026-08-21T09-00-00.000Z.md",
    body: `[00:00] Casey: Offsite retro — the venue worked well and the workshop format stays.
`,
  },
];

/**
 * Hermetic e2e seam: create a Drive-type Run from the sample transcript
 * without needing a real Drive folder. Not part of the user-facing API and
 * never registered unless the explicit test flag is set, so an unset variable
 * cannot expose it (no NODE_ENV string compare).
 */
export async function registerTestSeed(app: FastifyInstance, ctx: TestSeedContext): Promise<void> {
  app.post("/api/test/person-dossier-source", async (request) => {
    const input = request.body as {
      url: string;
      text: string;
      extraction: unknown;
      extractionError?: string;
      holdExtraction?: boolean;
    };
    dossierSources.set(input.url, {
      text: input.text,
      extraction: input.extraction,
      ...(input.extractionError ? { extractionError: input.extractionError } : {}),
      ...(input.holdExtraction ? { hold: createExtractionHold() } : {}),
    });
    return { ok: true };
  });
  app.get("/api/test/person-dossier-extraction", async (request) => {
    const { url } = request.query as { url: string };
    return { started: dossierSources.get(url)?.hold?.started ?? false };
  });
  app.post("/api/test/person-dossier-extraction/release", async (request) => {
    const { url } = request.body as { url: string };
    dossierSources.get(url)?.hold?.release();
    return { ok: true };
  });
  app.post("/api/test/seed", async (request, reply) => {
    try {
      const query = request.query as { scenario?: string };
      if (query.scenario === "conversion-failure") {
        const runId = await ctx.seedFixtureRun({
          fileName: "corrupt-transcript.json",
          bytes: Buffer.from('{"PRIVATE TRANSCRIPT MARKER"'),
        });
        reply.code(201);
        return { runId };
      }
      if (query.scenario === "ordinary-failure") {
        const runId = ctx.createFailedRun();
        reply.code(201);
        return { runId };
      }
      let bytes: Buffer | null = null;
      const candidates = [
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../tests/fixtures/transcripts/sample-transcript.md",
        ),
        join(process.cwd(), "tests/fixtures/transcripts/sample-transcript.md"),
      ];
      for (const cand of candidates) {
        try {
          bytes = await readFile(cand);
          break;
        } catch {
          /* This candidate is not there; try the next. */
        }
      }
      if (!bytes) {
        bytes = Buffer.from("# Weekly Product Sync\n\nAlice: hello\nBob: hi\n");
      }
      const runId = await ctx.seedFixtureRun({ fileName: "sample-transcript.md", bytes });
      reply.code(201);
      return { runId };
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });

  app.post("/api/test/seed-person-evidence", async (request, reply) => {
    const { profileId, evidenceId } = request.body as {
      profileId?: string;
      evidenceId?: string;
    };
    const profile = profileId ? ctx.personStore.get(profileId) : null;
    if (!profile) {
      reply.code(404);
      return { error: "profile-not-found", message: "No Person Profile with that id." };
    }
    const evidence: PersonEvidence = {
      id: evidenceId ?? "ev_wrong_person",
      source: "public-web",
      kind: "identity",
      title: "Wrong-person evidence",
      summary: "A sourced claim that was attributed to the wrong person.",
      url: "https://example.com/wrong-person",
      identitySignals: {
        emails: [],
        fullNames: ["Katherine Johnson"],
        handles: {},
        profileUrls: [],
        employerHints: [],
      },
      claims: { fullName: "Katherine Johnson" },
      matchConfidence: "medium",
      matchedSignals: ["fullName:katherine johnson"],
      observedAt: "2026-08-31T12:00:00.000Z",
    };
    const next = {
      ...profile,
      revision: profile.revision + 1,
      evidence: [...profile.evidence, evidence],
    };
    ctx.personStore.save(next);
    reply.code(201);
    return { revision: next.revision, evidenceId: evidence.id };
  });

  app.post("/api/test/seed-person-profile-meeting-brief", async (request, reply) => {
    const { profileId } = request.body as { profileId?: string };
    const profile = profileId ? ctx.personStore.get(profileId) : null;
    if (!profile) {
      reply.code(404);
      return { error: "profile-not-found", message: "No Person Profile with that id." };
    }
    const run = ctx.runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "evt_profile_repair::2026-08-31T15:00:00Z",
    });
    const snapshot: MeetingBriefEvent & { occurrenceKey: string } = {
      calendarId: "primary",
      eventId: "evt_profile_repair",
      occurrenceId: "2026-08-31T15:00:00Z",
      occurrenceKey: "evt_profile_repair::2026-08-31T15:00:00Z",
      version: "v1",
      summary: "Profile repair fixture",
      startAt: "2026-08-31T15:00:00.000Z",
      endAt: "2026-08-31T15:30:00.000Z",
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          organizer: true,
        },
        {
          email: profile.primaryEmail ?? "profile@example.com",
          displayName: profile.fullName ?? "Profile guest",
          responseStatus: "accepted",
        },
      ],
      status: "confirmed",
    };
    ctx.upsertMeetingBriefEvent?.(snapshot);
    const result: MeetingBriefRunResult = {
      version: 1,
      eventId: "evt_profile_repair",
      occurrenceId: "2026-08-31T15:00:00Z",
      eventVersion: "v1",
      occurrenceKey: "evt_profile_repair::2026-08-31T15:00:00Z",
      snapshotAt: "2026-08-31T12:00:00.000Z",
      enrichAt: "2026-08-31T12:00:00.000Z",
      composeAt: "2026-08-31T12:00:00.000Z",
      meetingBrief: {
        version: 1,
        eventId: "evt_profile_repair",
        occurrenceId: "2026-08-31T15:00:00Z",
        eventVersion: "v1",
        generatedAt: "2026-08-31T12:00:00.000Z",
        logistics: {
          title: "Profile repair fixture",
          startAt: "2026-08-31T15:00:00.000Z",
          endAt: "2026-08-31T15:30:00.000Z",
          location: null,
          conferenceLink: null,
          organizer: null,
        },
        summary: "Brief derived from a pinned Person Profile revision.",
        guests: [],
        companies: [],
        conversationStarters: [],
        sourceReferences: [],
        missingEvidence: [],
        uncertainty: [],
      },
      delivery: {
        status: "sent",
        sentAt: "2026-08-31T12:05:00.000Z",
        messageId: "fixture-profile-repair",
        recipient: "owner@example.com",
        attempts: 1,
      },
      personProfileLinks: [
        {
          guestEmail: profile.primaryEmail ?? "profile@example.com",
          profileId: profile.id,
          profileRevision: profile.revision,
        },
      ],
      supersedes: null,
    };
    run.started("compose");
    run.writeArtifact("snapshot.json", `${JSON.stringify(snapshot, null, 2)}\n`);
    run.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
    run.finished({ status: "done", summary: "Profile repair fixture" });
    reply.code(201);
    return { runId: run.id };
  });

  app.post("/api/test/owner-identity", async (request, reply) => {
    const { email } = request.body as { email?: string | null };
    if (email !== null && typeof email !== "string") {
      reply.code(400);
      return { error: "email-must-be-string-or-null" };
    }
    ctx.ownerOnboarding.setConnectedIdentity(email ?? null);
    return { proposal: ctx.ownerOnboarding.proposal() };
  });
  /* Semantic transcript relevance (issue #127): register a small, real
     Transcript corpus through the real Catalog so the Review surface journey
     exercises discovery, citations, and decisions over produced records. The
     corpus is the point, not the mined mentions. Idempotent: a second call
     re-runs the Catalog's exactly-once ledger and changes nothing. */
  app.post("/api/test/seed-transcript-corpus", async (_request, reply) => {
    try {
      const people = new WorkspacePersonProfiles({ store: ctx.personStore, lifecycle: [] });
      const identity = new TranscriptIdentityService({
        store: new TranscriptIdentityStore(ctx.workspaceDir),
        people,
      });
      const catalog = new TranscriptCatalog({
        workspaceDir: ctx.workspaceDir,
        source: {
          async folder() {
            return { folderId: "seed-folder", folderName: "Seeded Transcripts" };
          },
          async listFiles() {
            return SEED_CORPUS.map((entry) => ({
              externalFileId: entry.externalFileId,
              fileName: entry.fileName,
              sizeBytes: Buffer.byteLength(entry.body),
              modifiedAt: null,
              sourceUrl: null,
            }));
          },
          async fetch(externalFileId: string) {
            const entry = SEED_CORPUS.find(
              (candidate) => candidate.externalFileId === externalFileId,
            );
            return entry ? Buffer.from(entry.body) : null;
          },
        },
        disclosure: () => ({ provider: "seed", model: "seed" }),
        identity,
      });
      await catalog.grantConsent();
      await catalog.whenIdle();
      reply.code(201);
      return { transcriptCount: catalog.listTranscripts().length };
    } catch (error) {
      reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });

  /* The migration gate seam (issue #144): arm clears the one-time completed
     marker and activates the hold, so a journey can drive the pre-cutover UI;
     disarm restores exactly the state start-server.mjs left — marker back,
     parked Scout clock back, hold released. Both go through the Shell's one
     gate object: the arm/disarm pair never runs a parallel machinery. */
  const migration = ctx.migration;
  if (migration) {
    app.post("/api/test/migration/arm", async () => {
      rmSync(join(ctx.workspaceDir, "migration"), { recursive: true, force: true });
      migration.gate.setActive(true);
      await migration.drainModules();
      return { state: readMigrationState(ctx.workspaceDir) };
    });
    app.post("/api/test/migration/disarm", async () => {
      mkdirSync(join(ctx.workspaceDir, "migration"), { recursive: true });
      writeFileSync(
        join(ctx.workspaceDir, "migration", "completed.json"),
        `${JSON.stringify({ migratedAt: new Date().toISOString() })}\n`,
      );
      migration.restoreHermeticDefaults();
      migration.gate.setActive(false);
      return { state: readMigrationState(ctx.workspaceDir) };
    });
  }
}

/** Fixed ports for the browser suite; production never selects these dependencies. */
export function contentScoutTestPorts(now: () => Date): {
  adapters: SourceAdapter[];
  ranker: OpportunityRanker;
  brandProfileCrawler: BrandProfileCrawler;
  brandProfileProposer: BrandProfileProposer;
  runtimeInspector: RuntimeInspector;
} {
  const adapter: SourceAdapter = {
    id: "rss",
    state: "available",
    version: "e2e-fixture-1",
    supports: (target) => target.adapterId === "rss",
    async collect({ target }) {
      const at = now().toISOString();
      return {
        kind: "completed",
        outcome: "items_found",
        checkpoint: "e2e-checkpoint-1",
        items: ["public-change", "independent-analysis", "operator-impact"].map(
          (externalId, index) => ({
            /* Item identity is keyed to this Source Target, the way real feeds
               are distinct sources: two journeys each approve their own Target
               and every shortlist Run must get its own Opportunity identity.
               A shared fixture key would collide across journeys on exact-
               duplicate eligibility, the seven-day same-angle cooldown, and
               the one-Opportunity-one-Project seam. */
            id: `${target.id}:e2e-${externalId}`,
            externalId: `e2e-${target.id}:${externalId}`,
            targetId: target.id,
            adapterId: "rss",
            canonicalUrl: `https://example.com/research/${target.id}/${externalId}`,
            author: "Example Research",
            title: `Verified public evidence ${index + 1}`,
            body: `Independent public-source evidence ${index + 1} describes the verified change and its practical consequences.`,
            storyKey: `e2e-${target.id}:${externalId}`,
            description: null,
            publishedAt: at,
            discoveredAt: at,
            media: [],
            transcript: null,
            comments: [],
            evidence: [{ route: "fixture:content-scout-rss", retrievedAt: at }],
            completeness: {
              title: "available",
              body: "available",
              description: "unavailable",
              transcript: "unsupported",
              comments: "unsupported",
              media: "unavailable",
            },
          }),
        ),
        diagnostic: {
          classification: "items_found",
          route: "fixture:content-scout-rss",
          status: 200,
          contentType: "application/rss+xml",
          parserStage: "rss",
          responseHash: "e2e-public-change-v1",
          adapterVersion: "e2e-fixture-1",
          startedAt: at,
          finishedAt: at,
          retries: 0,
          affectedCapabilities: [],
          causeChain: [],
        },
      };
    },
  };
  const experimentalAdapter: SourceAdapter = {
    id: "instagram",
    state: "experimental",
    version: "e2e-fixture-1",
    supports: (target) => target.adapterId === "instagram",
    async collect({ target }) {
      const at = now().toISOString();
      return {
        kind: "failed",
        outcome: "response_shape_change",
        items: [],
        checkpoint: null,
        diagnostic: {
          classification: "response_shape_change",
          route: target.url,
          status: 200,
          contentType: "text/html",
          parserStage: "embedded_public_data",
          responseHash: "e2e-experimental-shape-change-v1",
          adapterVersion: "e2e-fixture-1",
          startedAt: at,
          finishedAt: at,
          retries: 0,
          affectedCapabilities: ["items", "transcript", "comments"],
          causeChain: ["Expected public embedded data was not present."],
        },
      };
    },
  };
  const ranker: OpportunityRanker = {
    async rank({ items }) {
      return [
        {
          id: "e2e-opportunity-1",
          canonicalKey: "e2e-public-change-practical-impact",
          title: "Explain what the verified change means in practice",
          angle: "practical_implication",
          angleDescription: "Explain the practical impact of the verified change.",
          materialDevelopment: null,
          urgency: "Useful while the public change is new.",
          explanation: "The evidence is specific and matches the accepted educational positioning.",
          sourceItemIds: items.map((item) => item.id),
          sourceUrls: items.map((item) => item.canonicalUrl),
          experimentalEvidence: false,
          confidence: 0.94,
          scores: {
            brandRelevance: 0.95,
            audienceUsefulness: 0.94,
            timeliness: 0.9,
            novelty: 0.82,
            evidenceStrength: 0.92,
            evidenceDiversity: 0.4,
            specificity: 0.9,
            originalPerspective: 0.84,
            packApplicability: 0.96,
            speculationRisk: 0.05,
          },
        },
      ];
    },
  };
  const brandProfileCrawler: BrandProfileCrawler = {
    async crawl({ websiteUrl }) {
      return [
        {
          url: websiteUrl,
          title: "Example Company",
          depth: 0,
          included: true,
          exclusionReason: null,
          text: "Example Company helps small teams explain complex public changes with practical educational guidance.",
        },
        {
          url: `${websiteUrl.replace(/\/$/, "")}/about`,
          title: "About",
          depth: 1,
          included: true,
          exclusionReason: null,
          text: "Customers value specific, evidence-led explanations and a direct, useful voice.",
        },
        {
          url: `${websiteUrl.replace(/\/$/, "")}/blog`,
          title: "Blog",
          depth: 1,
          included: false,
          exclusionReason: "Default transient or operational-page exclusion",
          text: "",
        },
      ];
    },
  };
  const brandProfileProposer = modelBrandProfileProposer(() => async () => ({
    Summary: "Example Company turns complex changes into practical guidance.",
    Products: "Educational guidance.",
    Customers: "Small teams.",
    "Customer problems": "Understanding change.",
    Positioning: "Evidence-led and practical.",
    Differentiators: "Specific explanations.",
    Proof: "Public company website.",
    Competitors: "Not established.",
    Voice: "Direct and useful.",
    Vocabulary: "Practical, evidence-led.",
    "Prohibited claims": "Do not invent outcomes.",
    "Content themes": "Public changes and implications.",
    "Avoided subjects": "Unverified rumors.",
    "Geographic or regulatory constraints": "Not established.",
  }));
  return {
    adapters: [adapter, experimentalAdapter],
    ranker,
    brandProfileCrawler,
    brandProfileProposer,
    runtimeInspector: {
      async inspect() {
        const checkedAt = now().toISOString();
        return [
          {
            id: "browser.chromium",
            category: "browser",
            state: "available",
            version: "Chromium e2e fixture",
            requiredBy: ["Website JavaScript fallback"],
            diagnostic: {
              classification: "runtime_available",
              command: "chromium --version",
              checkedAt,
              causeChain: [],
            },
          },
          {
            id: "python.pyktok",
            category: "python",
            state: "unsupported",
            version: null,
            requiredBy: ["TikTok Experimental enrichment"],
            diagnostic: {
              classification: "runtime_unsupported",
              command: "not installed by the approved production image",
              checkedAt,
              causeChain: ["This optional enrichment runtime is intentionally unsupported."],
            },
          },
        ];
      },
    },
  };
}

/** The browser suite replaces only remote I/O; the production research pipeline stays intact. */
function createExtractionHold() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    // A failed browser assertion must not leave the hermetic model pending forever.
    const timer = setTimeout(resolve, 30_000);
    release = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { wait, release, started: false };
}
const dossierSources = new Map<
  string,
  {
    text: string;
    extraction: unknown;
    extractionError?: string;
    hold?: ReturnType<typeof createExtractionHold>;
  }
>();
export const personDossierTestPorts: {
  search: import("../source-adapters/search.js").PublicSearch;
  fetch: import("../source-adapters/http.js").PublicHttpFetch;
  complete: import("../llm/providers.js").CompleteJson;
  plan: import("../llm/providers.js").CompleteJson;
} = {
  /* Continuous research asks several differently phrased questions per round,
     so the fixture matches on the query's own words rather than on the whole
     query string being a substring of the document. */
  search: async (query) => {
    const words = query
      .replace(/["']/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);
    return [...dossierSources]
      .filter(([, source]) => {
        const text = source.text.toLowerCase();
        return words.length > 0 && words.some((word) => text.includes(word));
      })
      .map(([url, source]) => ({ url, title: "Fixture source", snippet: source.text }));
  },
  fetch: async (url) => ({
    url,
    status: dossierSources.has(url) ? 200 : 404,
    contentType: "text/plain",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body: dossierSources.get(url)?.text ?? "",
  }),
  complete: async (request) => {
    const input = JSON.parse(request.user) as { document?: { url: string } };
    const source = input.document ? dossierSources.get(input.document.url) : undefined;
    if (source?.hold) {
      source.hold.started = true;
      await source.hold.wait;
    }
    if (source?.extractionError) throw new Error(source.extractionError);
    return source?.extraction ?? {};
  },
  /* The fixture planner proposes nothing: the browser journey exercises the
     production loop, not a model's imagination. */
  plan: async () => ({ queries: [], urls: [], targetCoverage: [], remainingQuestions: [] }),
};
