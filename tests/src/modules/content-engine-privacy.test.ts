import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersonEvidence } from "@chief-of-staff-demo/shared";
import { WorkspaceBrandProfileStore } from "../../../apps/server/src/brand-profile/store";
import { WorkspaceContentProjects } from "../../../apps/server/src/content-projects/projects";
import {
  createModelDraftGenerator,
  createModelOutlineGenerator,
  type ContentEngineDraftResult,
  type PlatformOutlineResult,
} from "../../../apps/server/src/content-projects/generation";
import type {
  ResearchProvider,
  ResearchProviderRequest,
  ResearchProviderResult,
} from "../../../apps/server/src/content-projects/research";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import { modelBrandProfileProposer } from "../../../apps/server/src/modules/content-scout/brand-profile";
import { modelOpportunityRanker } from "../../../apps/server/src/modules/content-scout/model";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { TranscriptCatalog } from "../../../apps/server/src/transcript-catalog/catalog";
import type { TranscriptCatalogSource } from "../../../apps/server/src/transcript-catalog/catalog";
import { TranscriptIdentityService } from "../../../apps/server/src/transcript-catalog/identity";
import { TranscriptIdentityStore } from "../../../apps/server/src/transcript-catalog/identity-store";
import { TranscriptRelevanceService } from "../../../apps/server/src/transcript-catalog/relevance";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";
import { DIAGNOSTIC, SOURCE_ITEM, SOURCE_ITEM_2 } from "./content-project-fixtures";

const AT = new Date("2026-08-31T18:00:00.000Z");
const NOW = () => AT;
/* Issue #143, AC 3: private Profile and transcript evidence cannot enter
 * Content Engine prompts or results.
 * The seams under proof are the only paths Content Engine generation can take
 * (main.ts wires exactly these): every Outline/Draft generation goes through
 * WorkspaceContentProjects.promptEvidence → the one Outline generation and the
 * one Draft generation, parameterized by the target contract, whose
 * model-backed implementations compose the prompt at the Shell's one LLM seam
 * from the Brief and the frozen prompt evidence alone
 * (content-projects/generation.ts). Research Requests ask their
 * providers only through runFiniteResearch's query plan, derived from the
 * pinned Profile revision's identity fields (content-projects/research.ts).
 * Content Opportunity ranking and Brand Profile proposal compose their prompts
 * at the same Shell seam from Brand Profile markdown, story groups, and public
 * Source Items (content-scout/model.ts, content-scout/brand-profile.ts).
 *
 * The workspace here genuinely holds private transcript evidence — a real
 * Transcript Catalog record plus the transcript-derived records the mining
 * pipeline produced (identity mentions, a remembered mapping, a confirmed
 * relevance decision) and transcript-origin Person Evidence on the researched
 * Profile — and these tests prove none of it reaches any prompt or any
 * persisted result. Positive controls on the captured prompts keep the
 * exclusions from passing vacuously: the same captures demonstrably carry the
 * public material that is allowed through. */

const TRANSCRIPT_SENTINEL = "Nimbus stealth beta decision ships October 14";
const BOARD_TEXT = `[00:00] Grace Hopper: The board agreed — ${TRANSCRIPT_SENTINEL}.
[00:12] Sam: Email follow-ups to grace@example.com.`;

/** Transcript text quoted into the transcript-origin Person Evidence. */
const MENTION_SUMMARY = `Overheard in the board prep: ${TRANSCRIPT_SENTINEL}.`;

/** Every marker that must stay out of Content Engine prompts and results. */
const TRANSCRIPT_EVIDENCE_NEEDLES = [TRANSCRIPT_SENTINEL, "Nimbus stealth", MENTION_SUMMARY];

function assertNoTranscriptEvidence(serialized: string): void {
  for (const needle of TRANSCRIPT_EVIDENCE_NEEDLES) {
    expect(serialized).not.toContain(needle);
  }
}

function fakeSource(
  files: Record<string, { name: string; body: string }>,
): TranscriptCatalogSource {
  return {
    async folder() {
      return { folderId: "folder-1", folderName: "Transcripts" };
    },
    async listFiles() {
      return Object.entries(files).map(([externalFileId, file]) => ({
        externalFileId,
        fileName: file.name,
        sizeBytes: Buffer.byteLength(file.body),
        modifiedAt: null,
        sourceUrl: null,
      }));
    },
    async fetch(externalFileId) {
      if (!(externalFileId in files)) return null;
      return Buffer.from(files[externalFileId].body, "utf8");
    },
  };
}

interface RecordedModelCall {
  system: string;
  user: string;
}

/** A recorder over the Shell's one LLM seam, named as the shared contract. */
interface ModelCallRecorder {
  calls: RecordedModelCall[];
  completeJson: CompleteJson;
}

/** Captures the exact prompt strings composed at the Shell's one LLM seam. */
function recordingCompleteJson(answer: unknown): ModelCallRecorder {
  const calls: RecordedModelCall[] = [];
  const completeJson: CompleteJson = async (request) => {
    calls.push({ system: request.system, user: request.user });
    return structuredClone(answer);
  };
  return { calls, completeJson };
}

/** A finite research provider that records every bounded request it was given. */
function recordingProvider(
  id: string,
  respond: (
    request: ResearchProviderRequest,
  ) => ResearchProviderResult | Promise<ResearchProviderResult>,
): ResearchProvider & { requests: ResearchProviderRequest[] } {
  const requests: ResearchProviderRequest[] = [];
  return {
    id,
    version: "1",
    requests,
    async lookup(request) {
      requests.push(request);
      return respond(request);
    },
  };
}

function publicResearchItem(id: string): ResearchProviderResult {
  return {
    items: [
      {
        id,
        externalId: id,
        targetId: "target_1",
        adapterId: "public-web",
        canonicalUrl: `https://evidence.example/${id}`,
        author: "Public Research",
        title: "Public research on the topic",
        body: "Public material returned by an anonymous query.",
        description: null,
        publishedAt: NOW().toISOString(),
        discoveredAt: NOW().toISOString(),
        media: [],
        transcript: null,
        comments: [],
        evidence: [{ route: `https://evidence.example/${id}`, retrievedAt: NOW().toISOString() }],
        completeness: {
          title: "available",
          body: "available",
          description: "unavailable",
          transcript: "unsupported",
          comments: "unsupported",
          media: "unsupported",
        },
      },
    ],
    diagnostic: {
      classification: "items_found",
      route: "https://search.example/search?q=topic",
      status: 200,
      contentType: "text/html",
      parserStage: "fetch",
      responseHash: "hash",
      adapterVersion: "1",
      startedAt: NOW().toISOString(),
      finishedAt: NOW().toISOString(),
      retries: 0,
      affectedCapabilities: [],
      causeChain: [],
    },
  };
}

/**
 * House privacy idiom (mirrors people-routes/transcript-delete privacy
 * proofs): while active, any remote fetch throws, so a test that completes
 * proves the exercised path performed zero remote provider operations.
 */
function blockRemoteOperations(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("remote provider operations are forbidden in this privacy proof");
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Transcript-origin Person Evidence, in the issue #128 producer convention. */
function transcriptOriginEvidence(id: string): PersonEvidence {
  return {
    id,
    source: "transcript-catalog",
    kind: "mention",
    title: "Said in the board prep",
    summary: MENTION_SUMMARY,
    url: "drive_fileA_r1",
    identitySignals: {
      emails: [],
      fullNames: ["Grace Hopper"],
      handles: {},
      profileUrls: [],
      employerHints: [],
    },
    claims: {},
    matchConfidence: "high",
    matchedSignals: [],
    observedAt: NOW().toISOString(),
  };
}

const OUTLINE_ANSWER: PlatformOutlineResult = {
  title: "A grounded case for evidence-led content",
  hookDirection: "Open with the review gate the owner knows.",
  targetLength: "900 to 1,200 characters",
  beats: [
    {
      direction: "Name the evidence review gate.",
      evidence: {
        claim: "Frozen public evidence preserves lineage.",
        sourceItemIds: [SOURCE_ITEM.id],
      },
      examples: ["The evidence review queue"],
    },
  ],
  warnings: [],
  productionNotes: ["Draft the hook last."],
};

const DRAFT_ANSWER: ContentEngineDraftResult = {
  copy: "Finished post copy grounded in the frozen public evidence.",
  productionNotes: ["Paste-ready copy."],
  claims: [{ text: "Frozen public evidence preserves lineage.", sourceItemIds: [SOURCE_ITEM.id] }],
};

interface Workspace {
  workspaceDir: string;
  catalog: TranscriptCatalog;
  identityStore: TranscriptIdentityStore;
  relevanceStore: TranscriptRelevanceStore;
  people: WorkspacePersonProfiles;
  peopleStore: PersonProfileStore;
  brandProfiles: WorkspaceBrandProfileStore;
  subjectId: string;
  projects: WorkspaceContentProjects;
  generationRecorders: ModelCallRecorder[];
  research: ResearchProvider & { requests: ResearchProviderRequest[] };
}

/**
 * The real transcript-derived record set the mining pipeline produces for the
 * board transcript: identity mentions, a remembered mapping to the Profile,
 * and a confirmed relevance decision. Asserted so the private evidence's
 * existence is grounded before the exclusions are claimed.
 */
function expectWorkspaceHoldsTranscriptEvidence(ws: Workspace): void {
  const record = ws.catalog.listTranscripts().find((entry) => entry.id === "drive_fileA_r1");
  if (record === undefined) throw new Error("expected the board transcript to be catalogued");
  expect(record.normalizedText).toContain(TRANSCRIPT_SENTINEL);

  const subject = ws.peopleStore.get(ws.subjectId);
  if (subject === null) throw new Error("expected the researched Profile to exist");
  expect(subject.evidence.map((entry) => entry.summary)).toContain(MENTION_SUMMARY);
  expect(subject.mentions.map((entry) => entry.summary)).toContain(MENTION_SUMMARY);

  expect(
    ws.identityStore.readMentions().filter((m) => m.provenance.transcriptId === "drive_fileA_r1")
      .length,
  ).toBeGreaterThan(0);
  expect(ws.identityStore.readMappings()).toHaveLength(1);
  expect(ws.relevanceStore.readCandidates().some((c) => c.transcriptId === "drive_fileA_r1")).toBe(
    true,
  );
  expect(ws.relevanceStore.readDecisions().length).toBeGreaterThan(0);
}

/**
 * One workspace with every private transcript artifact in place: the catalogued
 * board transcript, mined identity mentions with a remembered mapping, a
 * confirmed relevance decision, and transcript-origin Person Evidence on the
 * researched Profile. Brand Profile and Content Voice hold only public
 * material. Project generation runs through the real model-backed provider
 * implementations, so the captured strings are the actual prompts the Shell
 * would send.
 */
async function makeWorkspace(): Promise<Workspace> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "content-engine-privacy-"));
  const identityStore = new TranscriptIdentityStore(workspaceDir);
  const relevanceStore = new TranscriptRelevanceStore(workspaceDir);
  const peopleStore = new PersonProfileStore(workspaceDir);
  const people = new WorkspacePersonProfiles({ store: peopleStore, now: NOW, lifecycle: [] });
  const owner = people.create({ fullName: "Workspace Owner", primaryEmail: "owner@example.com" });
  /* An exact stable identifier match: mining produces a candidate and the
     policy makes a confirmed identity decision for this Profile. */
  const subject = people.create({ fullName: "Grace Hopper", primaryEmail: "grace@example.com" });

  const identity = new TranscriptIdentityService({ store: identityStore, people, now: NOW });
  const catalog = new TranscriptCatalog({
    workspaceDir,
    source: fakeSource({
      fileA: { name: "Board prep - 2026-08-19T10-00-00.000Z.md", body: BOARD_TEXT },
    }),
    disclosure: () => ({ provider: "test-provider", model: "test-model" }),
    identity,
    now: NOW,
    log: () => {},
  });
  const relevance = new TranscriptRelevanceService({
    corpus: catalog,
    store: relevanceStore,
    now: NOW,
  });

  /* Consent, then a settled pass, so the private evidence exists for real. */
  await catalog.grantConsent();
  await catalog.whenIdle();

  /* Transcript-derived records the pipeline wrote for the board transcript. */
  const mention = identityStore
    .readMentions()
    .find((m) => m.provenance.transcriptId === "drive_fileA_r1" && m.kind === "person");
  if (mention === undefined) throw new Error("expected a person mention in the board transcript");
  identity.decide({
    mentionId: mention.id,
    action: "remember-mapping",
    profileId: subject.id,
    scope: "workspace",
  });
  await relevance.search({ text: "Nimbus stealth beta" });
  const candidate = relevanceStore
    .readCandidates()
    .find((c) => c.transcriptId === "drive_fileA_r1");
  if (candidate === undefined) throw new Error("expected a relevance candidate for the transcript");
  relevance.decide({ candidateId: candidate.id, action: "confirm" });

  /* Transcript-origin Person Evidence on the researched Profile, mirroring the
     resolver's locations: `evidence` and the mirrored `mentions` array hold
     the same record, each carrying a quote of the transcript text. */
  const current = peopleStore.get(subject.id)!;
  const evidence = transcriptOriginEvidence("ev_transcript_origin");
  peopleStore.save({
    ...current,
    evidence: [...current.evidence, evidence],
    mentions: [...current.mentions, { ...evidence, id: "ev_transcript_origin_mention" }],
  });

  const ownerOnboarding = new OwnerOnboarding({ people, workspaceDir, now: NOW });
  ownerOnboarding.setConnectedIdentity("owner@example.com");
  ownerOnboarding.confirm(owner.id);

  const brandProfiles = new WorkspaceBrandProfileStore(workspaceDir, NOW);
  brandProfiles.accept({
    markdown: "# Brand Profile\n\n## Voice\nUseful and specific.",
    sourceScan: {
      websiteUrl: "https://brand.example/",
      includedUrls: ["https://brand.example/"],
      excludedUrls: [],
    },
  });

  const generation = recordingCompleteJson(OUTLINE_ANSWER);
  const draft = recordingCompleteJson(DRAFT_ANSWER);
  const research = recordingProvider("public-web", () => publicResearchItem("web_1"));

  const projects = new WorkspaceContentProjects({
    workspaceDir,
    people,
    ownerOnboarding,
    brandProfiles,
    researchProviders: [research],
    outlineGenerator: createModelOutlineGenerator(() => generation.completeJson),
    draftGenerator: createModelDraftGenerator(() => draft.completeJson),
    now: NOW,
  });
  projects.approveContentVoice(owner.id, "Clear, practical, and evidence-led.");

  return {
    workspaceDir,
    catalog,
    identityStore,
    relevanceStore,
    people,
    peopleStore,
    brandProfiles,
    subjectId: subject.id,
    projects,
    generationRecorders: [generation, draft],
    research,
  };
}

describe("Content Engine transcript-evidence boundary (issue #143, AC 3)", () => {
  it("transcript evidence never enters Content Engine generation prompts or persisted results", async () => {
    const ws = await makeWorkspace();
    expectWorkspaceHoldsTranscriptEvidence(ws);

    /* The subject is the Profile that holds transcript-origin Person Evidence:
       even a researched person with private transcript-derived mention data on
       their record freezes only a public-safe projection. */
    const project = ws.projects.create({
      subject: { kind: "person-profile", profileId: ws.subjectId },
      objective: "establish-authority",
      audience: "Engineering leaders",
      constraints: ["Separate facts from author claims"],
      targets: ["linkedin-standard-post"],
      researchMode: "existing-workspace-evidence",
      seedMaterial: ["The audience already reads the company blog."],
    });
    ws.projects.attachEvidence(project.id, {
      sourceItems: [SOURCE_ITEM, SOURCE_ITEM_2],
      diagnostics: [DIAGNOSTIC],
    });
    ws.projects.freezeEvidence(project.id, {
      includedSourceItemIds: [SOURCE_ITEM.id, SOURCE_ITEM_2.id],
      noExternalResearchAcknowledged: false,
    });
    const brief = ws.projects.proposeOutlineCharter(project.id, {
      thesis: "Frozen public evidence makes generated content reproducible.",
      angle: "Treat evidence review as product state, not workflow discipline.",
      claims: ["Frozen public evidence preserves lineage."],
      evidenceMap: [
        { claim: "Frozen public evidence preserves lineage.", sourceItemIds: [SOURCE_ITEM.id] },
      ],
      ctaIntent: "Approve the Brief before generating.",
    });
    ws.projects.approveOutlineCharter(project.id, brief.id);

    /* The exact prompt-evidence projection a generator is handed: it holds the
       public material it is supposed to hold — and nothing transcript-shaped. */
    const promptEvidence = ws.projects.promptEvidence(project.id);
    if (promptEvidence === null) throw new Error("expected frozen prompt evidence");
    const serializedEvidence = JSON.stringify(promptEvidence);
    assertNoTranscriptEvidence(serializedEvidence);
    expect(serializedEvidence).toContain("Reviewed public evidence.");
    expect(serializedEvidence).toContain("Clear, practical, and evidence-led.");
    expect(serializedEvidence).toContain("Useful and specific.");
    expect(promptEvidence.profileProjections.map((entry) => entry.role)).toEqual([
      "author",
      "subject",
    ]);

    /* Under the house privacy idiom the whole generation journey runs with a
       throwing fetch stub: completing at all proves zero remote operations. */
    const restoreFetch = blockRemoteOperations();
    let outline;
    let draft;
    try {
      outline = await ws.projects.generateOutline(project.id, "linkedin-standard-post");
      ws.projects.approveOutline(project.id, "linkedin-standard-post");
      draft = await ws.projects.generateDraft(project.id, "linkedin-standard-post", {
        instruction: "Tighten the hook.",
      });
    } finally {
      restoreFetch();
    }

    /* Two model calls happened — Outline, then Draft — and the capture is the
       real composed prompt: the public markers that are allowed through are
       demonstrably present. */
    const generationCalls = ws.generationRecorders.flatMap((recorder) => recorder.calls);
    expect(generationCalls).toHaveLength(2);
    const [outlineCall, draftCall] = generationCalls;

    assertNoTranscriptEvidence(outlineCall.system);
    assertNoTranscriptEvidence(outlineCall.user);
    assertNoTranscriptEvidence(draftCall.system);
    assertNoTranscriptEvidence(draftCall.user);
    expect(outlineCall.user).toContain("Reviewed public evidence.");
    expect(outlineCall.user).toContain(
      "Frozen public evidence makes generated content reproducible.",
    );
    expect(outlineCall.user).toContain("Useful and specific.");
    expect(draftCall.user).toContain("Tighten the hook.");

    /* The returned artifacts, and everything the Content Engine persisted
       after the journey, carry no transcript evidence either. */
    assertNoTranscriptEvidence(JSON.stringify(outline));
    assertNoTranscriptEvidence(JSON.stringify(draft));
    const persisted = readFileSync(
      join(ws.workspaceDir, "content-engine", "projects.json"),
      "utf8",
    );
    assertNoTranscriptEvidence(persisted);
    const state = JSON.parse(persisted) as {
      projects: Array<{ revisions: Array<{ platformOutlines: unknown[]; drafts: unknown[] }> }>;
    };
    expect(state.projects[0]?.revisions[0]?.platformOutlines).toHaveLength(1);
    expect(state.projects[0]?.revisions[0]?.drafts).toHaveLength(1);
  });

  it("transcript-derived Profile evidence never enters Research Request queries", async () => {
    const ws = await makeWorkspace();
    expectWorkspaceHoldsTranscriptEvidence(ws);

    const project = ws.projects.create({
      subject: { kind: "person-profile", profileId: ws.subjectId },
      objective: "educate",
      audience: "Operators",
      constraints: [],
      targets: ["linkedin-standard-post"],
      researchMode: "fresh-bounded-research",
      seedMaterial: [],
    });

    /* House privacy idiom: no remote operation may happen while the Research
       Request runs against its configured providers. */
    const restoreFetch = blockRemoteOperations();
    let request;
    try {
      request = await ws.projects.runResearchRequest(project.id, {
        question: "What has Grace published recently?",
        terms: [],
        bundle: { providerIds: ["public-web"], completeness: "best-effort" },
        limits: { maxQueriesPerProvider: 12, maxSourceItems: 10 },
      });
    } finally {
      restoreFetch();
    }

    expect(ws.research.requests).toHaveLength(1);
    const queries = ws.research.requests[0]?.queries ?? [];
    /* Positive control: the query plan demonstrably derives from the pinned
       Profile revision's identity fields — the exact mechanism that would
       carry transcript-derived mention data if it leaked. */
    expect(queries).toContain('"grace@example.com"');
    expect(queries).toContain('"Grace Hopper"');
    assertNoTranscriptEvidence(JSON.stringify(queries));

    /* The record the Workspace keeps — identifier bookkeeping included — and
       everything persisted on the Project carry no transcript text either. */
    assertNoTranscriptEvidence(JSON.stringify(request));
    expect(request.identifierUses.some((use) => use.identifierClass === "email")).toBe(true);
    expect(request.identifierUses.some((use) => use.identifierClass === "full-name")).toBe(true);
    assertNoTranscriptEvidence(
      readFileSync(join(ws.workspaceDir, "content-engine", "projects.json"), "utf8"),
    );
  });

  it("transcript evidence never enters Content Opportunity ranking or Brand Profile proposal prompts", async () => {
    const ws = await makeWorkspace();
    expectWorkspaceHoldsTranscriptEvidence(ws);

    const brandProfile = ws.brandProfiles.current();
    if (brandProfile === null) throw new Error("expected an accepted Brand Profile");

    /* Opportunity ranking: the scout Stage that seeds Content Projects. Its
       prompt is Brand Profile markdown, story groups, and public Source Items.
       The positive control proves the capture carries those inputs. */
    const ranking = recordingCompleteJson({
      opportunities: [
        {
          canonicalKey: "evidence-review-gate",
          title: "Evidence review as product state",
          angle: "practical_implication",
          angleDescription: "Explain the practical impact of the review gate.",
          materialDevelopment: null,
          urgency: "Useful while the public change is new.",
          explanation: "The evidence is specific and matches the brand.",
          sourceItemIds: [SOURCE_ITEM.id],
          sourceUrls: [SOURCE_ITEM.canonicalUrl],
          experimentalEvidence: false,
          confidence: 0.9,
          scores: {
            brandRelevance: 0.9,
            audienceUsefulness: 0.8,
            timeliness: 0.7,
            novelty: 0.6,
            evidenceStrength: 0.9,
            evidenceDiversity: 0.5,
            specificity: 0.8,
            originalPerspective: 0.6,
            packApplicability: 0.9,
            speculationRisk: 0.2,
          },
        },
      ],
    });
    const ranked = await modelOpportunityRanker(() => ranking.completeJson).rank({
      brandProfile,
      items: [SOURCE_ITEM, SOURCE_ITEM_2],
      storyGroups: [
        { canonicalKey: "evidence-review-gate", sourceItemIds: [SOURCE_ITEM.id, SOURCE_ITEM_2.id] },
      ],
      limit: 10,
    });
    expect(ranking.calls).toHaveLength(1);
    const rankCall = ranking.calls[0];
    expect(rankCall.user).toContain("Useful and specific.");
    expect(rankCall.user).toContain("Reviewed public evidence.");
    assertNoTranscriptEvidence(rankCall.system);
    assertNoTranscriptEvidence(rankCall.user);
    /* The ranked result cites only the public items it was given. */
    assertNoTranscriptEvidence(JSON.stringify(ranked));
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.sourceItemIds).toEqual([SOURCE_ITEM.id]);

    /* Brand Profile proposal: bounded public website evidence, and nothing
       from the Workspace's private stores. */
    const proposal = recordingCompleteJson(
      Object.fromEntries(
        [
          "Summary",
          "Products",
          "Customers",
          "Customer problems",
          "Positioning",
          "Differentiators",
          "Proof",
          "Competitors",
          "Voice",
          "Vocabulary",
          "Prohibited claims",
          "Content themes",
          "Avoided subjects",
          "Geographic or regulatory constraints",
        ].map((section) => [section, "Example Company publishes practical guidance."]),
      ),
    );
    const proposed = await modelBrandProfileProposer(() => proposal.completeJson).propose({
      pages: [
        {
          url: "https://brand.example/",
          title: "Example Company",
          depth: 0,
          included: true,
          exclusionReason: null,
          text: "We publish practical, evidence-led guidance.",
        },
      ],
    });
    expect(proposal.calls).toHaveLength(1);
    const proposeCall = proposal.calls[0];
    expect(proposeCall.user).toContain("We publish practical, evidence-led guidance.");
    assertNoTranscriptEvidence(proposeCall.system);
    assertNoTranscriptEvidence(proposeCall.user);
    assertNoTranscriptEvidence(proposed);
  });
});
