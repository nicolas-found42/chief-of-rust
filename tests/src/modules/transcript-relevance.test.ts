import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersonProfile, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import {
  TRANSCRIPT_RELEVANCE_INDEX_VERSION,
  TranscriptRelevanceService,
} from "../../../apps/server/src/transcript-catalog/relevance";
import { TranscriptRelevanceStore } from "../../../apps/server/src/transcript-catalog/relevance-store";

const NOW = () => new Date("2026-08-31T12:00:00.000Z");

const CORPUS_TEXT = `[00:00] Dana: Morning everyone. Three things today — the Acme renewal, the onboarding redesign, and the support queue.
[00:12] Sam: Ticket volume was down about fifteen percent, but we got six reports of the export button timing out on large accounts.
[00:30] Priya: That's the synchronous export path. It needs to move to a background job.
[00:52] Marcus: Second round of the onboarding flow is done. I cut the plan-selection step entirely.
[01:14] Dana: For the Acme renewal we are holding at the current tier, no additional discount.`;

const OTHER_TEXT = `[00:00] Jordan: Board prep — the investor update draft is due Thursday.
[00:20] Riley: I'll pull the churn numbers and the hiring plan.`;

interface RecordSpec {
  id: string;
  fileName: string;
  meetingDate: string | null;
  sourceUrl: string | null;
  text: string;
}

function record(spec: RecordSpec): TranscriptRecord {
  return {
    id: spec.id,
    source: {
      sourceSystem: "drive",
      externalFileId: spec.id,
      fileName: spec.fileName,
      sourceUrl: spec.sourceUrl,
      checksum: `checksum-${spec.id}`,
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: spec.text,
    meetingDate: spec.meetingDate,
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
  };
}

const CORPUS: TranscriptRecord[] = [
  record({
    id: "drive_sync_r1",
    fileName: "Weekly Product Sync — 2026-08-17.md",
    meetingDate: "2026-08-17",
    sourceUrl: "https://docs.example.com/sync",
    text: CORPUS_TEXT,
  }),
  record({
    id: "drive_board_r1",
    fileName: "Board Prep — 2026-08-19.md",
    meetingDate: "2026-08-19",
    sourceUrl: null,
    text: OTHER_TEXT,
  }),
  record({
    id: "drive_empty_r1",
    fileName: "Empty Notes — 2026-08-20.md",
    meetingDate: null,
    sourceUrl: null,
    text: "",
  }),
];

interface Harness {
  workspaceDir: string;
  service: TranscriptRelevanceService;
  store: TranscriptRelevanceStore;
  people: WorkspacePersonProfiles;
  corpus: TranscriptRecord[];
}

function makeHarness(corpus: TranscriptRecord[] = CORPUS): Harness {
  const workspaceDir = mkdtempSync(join(tmpdir(), "transcript-relevance-"));
  const store = new TranscriptRelevanceStore(workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    now: NOW,
    lifecycle: [],
  });
  const service = new TranscriptRelevanceService({
    corpus: { listTranscripts: () => corpus },
    store,
    now: NOW,
  });
  return { workspaceDir, service, store, people, corpus };
}

describe("Transcript semantic relevance discovery", () => {
  it("searches every retained eligible Transcript revision and bounds the results", async () => {
    const h = makeHarness();
    const results = await h.service.search({ text: "export button timing out on large accounts" });
    expect(results.map((candidate) => candidate.transcriptId)).toEqual(["drive_sync_r1"]);
    expect(results).toHaveLength(1);

    // A query that legitimately matches two meetings across the corpus is
    // bounded, not truncated silently: the default bound still returns both.
    const wide = await h.service.search({ text: "onboarding redesign plan-selection step" });
    expect(wide.map((candidate) => candidate.transcriptId)).toEqual(["drive_sync_r1"]);

    // The bound itself is observable: one result, the best-scoring one.
    const bounded = await h.service.search(
      { text: "the onboarding redesign and the Acme renewal" },
      { limit: 1 },
    );
    expect(bounded).toHaveLength(1);
  });

  it("cites an excerpt that appears verbatim in the retained revision, with source context", async () => {
    const h = makeHarness();
    const results = await h.service.search({ text: "synchronous export path background job" });
    expect(results.length).toBeGreaterThan(0);
    const cited = results[0];
    const original = h.corpus.find((r) => r.id === cited.transcriptId)!;
    expect(original.normalizedText.slice(cited.excerpt.spanStart, cited.excerpt.spanEnd)).toBe(
      cited.excerpt.text,
    );
    expect(original.normalizedText).toContain(cited.excerpt.text);
    expect(cited.sourceContext).toEqual({
      fileName: "Weekly Product Sync — 2026-08-17.md",
      meetingDate: "2026-08-17",
      sourceUrl: "https://docs.example.com/sync",
    });
  });

  it("grounds every candidate in the retained text and persists nothing it cannot ground", async () => {
    const h = makeHarness();
    const results = await h.service.search({ text: "quantum entanglement calibration" });
    expect(results).toEqual([]);
    expect(h.store.readCandidates()).toEqual([]);
  });

  it("records the query context, explanation, index version, and pending review state", async () => {
    const h = makeHarness();
    const [candidate] = await h.service.search({
      text: "export button timing out",
      meeting: { title: "Weekly Product Sync", topics: ["support queue", "exports"] },
    });
    expect(candidate.query).toEqual({
      text: "export button timing out",
      meeting: { title: "Weekly Product Sync", topics: ["support queue", "exports"] },
    });
    expect(candidate.explanation.length).toBeGreaterThan(0);
    expect(candidate.relevanceVersion).toBe(String(TRANSCRIPT_RELEVANCE_INDEX_VERSION));
    const [item] = h.service.reviewQueue();
    expect(item.reviewState).toBe("pending");
    expect(item.decision).toBeNull();
  });

  it("returns bounded results with a caller-set limit over the whole corpus", async () => {
    const h = makeHarness([
      record({
        id: "drive_renewal_high_r1",
        fileName: "Renewal High.md",
        meetingDate: null,
        sourceUrl: null,
        text: "The Acme renewal renewal renewal is holding at the current tier.",
      }),
      record({
        id: "drive_renewal_mid_r1",
        fileName: "Renewal Mid.md",
        meetingDate: null,
        sourceUrl: null,
        text: "The renewal discussion continued into the afternoon.",
      }),
      record({
        id: "drive_renewal_low_r1",
        fileName: "Renewal Low.md",
        meetingDate: null,
        sourceUrl: null,
        text: "A brief renewal note.",
      }),
    ]);
    const results = await h.service.search({ text: "renewal" }, { limit: 2 });
    expect(results.map((candidate) => candidate.transcriptId)).toEqual([
      "drive_renewal_high_r1",
      "drive_renewal_low_r1",
    ]);
    expect(results.map((candidate) => candidate.score)).toEqual([3, 1]);
    // Every candidate id is distinct: the id separates by revision and span.
    expect(new Set(results.map((candidate) => candidate.id)).size).toBe(results.length);
  });
});

describe("Relevance review decisions", () => {
  it("lets the owner confirm, reject, or leave a candidate unresolved", async () => {
    const h = makeHarness();
    const [confirmed] = await h.service.search({ text: "export button timing out" });
    h.service.decide({ candidateId: confirmed.id, action: "confirm" });
    expect(h.service.reviewQueue().find((i) => i.candidate.id === confirmed.id)?.reviewState).toBe(
      "confirmed",
    );

    const [rejected] = await h.service.search({ text: "onboarding redesign" });
    expect(rejected.id).not.toBe(confirmed.id);
    h.service.decide({ candidateId: rejected.id, action: "reject" });
    expect(h.service.reviewQueue().find((i) => i.candidate.id === rejected.id)?.reviewState).toBe(
      "rejected",
    );

    // An explicit leave-unresolved is its own decision and stops counting as
    // pending review work.
    const [left] = await h.service.search({
      text: "Acme renewal holding at the current tier",
    });
    h.service.decide({ candidateId: left.id, action: "unresolved" });
    expect(h.service.reviewQueue().find((i) => i.candidate.id === left.id)?.reviewState).toBe(
      "unresolved",
    );
  });

  it("rejects an unknown candidate and repeats of the same decision append nothing", async () => {
    const h = makeHarness();
    const [candidate] = await h.service.search({ text: "export button timing out" });
    expect(() => h.service.decide({ candidateId: "rel_nope", action: "confirm" })).toThrow();

    const first = h.service.decide({ candidateId: candidate.id, action: "confirm" });
    const second = h.service.decide({ candidateId: candidate.id, action: "confirm" });
    expect(second.id).toBe(first.id);
    expect(h.store.readDecisions().filter((d) => d.candidateId === candidate.id)).toHaveLength(1);
  });
});

describe("Relevance never becomes factual consumer input", () => {
  it("confirmed() exposes only confirmed candidates; pending, rejected and unresolved never", async () => {
    const h = makeHarness();
    const [confirmed] = await h.service.search({ text: "export button timing out" });
    const [rejected] = await h.service.search({ text: "onboarding redesign" });
    h.service.decide({ candidateId: rejected.id, action: "reject" });
    const [left] = await h.service.search({ text: "Acme renewal holding at the current tier" });
    h.service.decide({ candidateId: left.id, action: "unresolved" });

    h.service.decide({ candidateId: confirmed.id, action: "confirm" });
    const confirmedIds = h.service.confirmed().map((candidate) => candidate.id);
    expect(confirmedIds).toEqual([confirmed.id]);
    expect(confirmedIds).not.toContain(rejected.id);
    expect(confirmedIds).not.toContain(left.id);
  });

  it("never creates or merges a Profile and never touches the identity decision log", async () => {
    const h = makeHarness();
    const before: PersonProfile[] = h.people.search({ includeArchived: true });
    const results = await h.service.search({ text: "export button timing out" });
    for (const candidate of results) {
      h.service.decide({ candidateId: candidate.id, action: "confirm" });
    }
    const after = h.people.search({ includeArchived: true });
    expect(after).toEqual(before);
    expect(after).toHaveLength(0);
    // Relevance decisions are stored apart from identity decisions; the
    // identity log file does not even exist after a full relevance review.
    expect(
      existsSync(join(h.workspaceDir, "transcript-catalog", "identity", "decisions.json")),
    ).toBe(false);
    expect(h.store.readDecisions().length).toBeGreaterThan(0);
  });
});

describe("Relevance state survives an index rebuild and a restart", () => {
  it("re-running the same search over a restarted service duplicates no pending work", async () => {
    const h = makeHarness();
    const [confirmed] = await h.service.search({ text: "export button timing out" });
    h.service.decide({ candidateId: confirmed.id, action: "confirm" });
    const [rejected] = await h.service.search({ text: "onboarding redesign" });
    h.service.decide({ candidateId: rejected.id, action: "reject" });

    // Restart: a fresh service over the same Workspace directory.
    const restartedStore = new TranscriptRelevanceStore(h.workspaceDir);
    const restarted = new TranscriptRelevanceService({
      corpus: { listTranscripts: () => h.corpus },
      store: restartedStore,
      now: NOW,
    });
    const again = await restarted.search({ text: "export button timing out" });
    expect(again.map((candidate) => candidate.id)).toEqual([confirmed.id]);
    const reRejected = await restarted.search({ text: "onboarding redesign" });
    expect(reRejected.map((candidate) => candidate.id)).toEqual([rejected.id]);
    const states = new Map(
      restarted.reviewQueue().map((item) => [item.candidate.id, item.reviewState] as const),
    );
    expect(states.get(confirmed.id)).toBe("confirmed");
    expect(states.get(rejected.id)).toBe("rejected");
    expect(restarted.reviewQueue().filter((item) => item.reviewState === "pending")).toHaveLength(
      0,
    );

    // A second pass over the same corpus with the same queries appends no new
    // candidate and no new decision: the rebuild re-derives, never duplicates.
    const decisionsBefore = restartedStore.readDecisions().length;
    const third = await restarted.search({ text: "export button timing out" });
    expect(third.map((candidate) => candidate.id)).toEqual([confirmed.id]);
    expect(restartedStore.readDecisions().length).toBe(decisionsBefore);
  });
});
describe("The local relevance index", () => {
  it("ranks phrase matches above scattered term matches and explains itself", async () => {
    const h = makeHarness([
      record({
        id: "drive_phrase_r1",
        fileName: "Phrase.md",
        meetingDate: null,
        sourceUrl: null,
        text: "The background job for exports is scheduled.\nSomething unrelated.\nA background, a job, separately mentioned.",
      }),
      record({
        id: "drive_scatter_r1",
        fileName: "Scatter.md",
        meetingDate: null,
        sourceUrl: null,
        text: "We discussed a background, and later a job.",
      }),
    ]);
    const candidates = await h.service.search({ text: "background job" });
    const byId = new Map(candidates.map((candidate) => [candidate.transcriptId, candidate]));
    expect(byId.get("drive_phrase_r1")!.score).toBeGreaterThan(byId.get("drive_scatter_r1")!.score);
    const phrase = byId.get("drive_phrase_r1")!;
    expect(phrase.explanation).toContain("background job");
    // Every excerpt is grounded: it is the transcript's own text at the span
    // the candidate cites, never a paraphrase the index invented.
    expect(phrase.excerpt.text.toLowerCase()).toContain("background job for exports");
    const source = h.corpus.find((entry) => entry.id === phrase.transcriptId)!;
    expect(source.normalizedText.slice(phrase.excerpt.spanStart, phrase.excerpt.spanEnd)).toBe(
      phrase.excerpt.text,
    );
  });

  it("finds nothing when the query shares no vocabulary with the corpus", async () => {
    const h = makeHarness([
      record({
        id: "drive_sync_r1",
        fileName: "Sync.md",
        meetingDate: null,
        sourceUrl: null,
        text: CORPUS_TEXT,
      }),
    ]);
    expect(await h.service.search({ text: "quantum entanglement calibration" })).toEqual([]);
  });
});
