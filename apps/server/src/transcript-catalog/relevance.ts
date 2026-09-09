import { createHash } from "node:crypto";
import type {
  TranscriptRecord,
  TranscriptRelevanceCandidate,
  TranscriptRelevanceDecision,
  TranscriptRelevanceDecisionAction,
  TranscriptRelevanceQuery,
  TranscriptRelevanceReviewItem,
  TranscriptRelevanceSourceContext,
} from "@chief-of-staff-demo/shared";
import type { TranscriptRelevanceStore } from "./relevance-store.js";
import { TRANSCRIPT_RELEVANCE_INDEX_VERSION, searchLexicalIndex } from "./relevance-index.js";

/* The lexical index version is stamped on every candidate this service
   persists, so callers read it from the service rather than from the index
   internals behind it (#166). */
export { TRANSCRIPT_RELEVANCE_INDEX_VERSION } from "./relevance-index.js";

/**
 * What the relevance service needs from the Catalog: the retained corpus. The
 * Catalog is the sole writer for Transcript records; relevance only reads.
 */
export interface TranscriptRelevanceCorpus {
  listTranscripts(): TranscriptRecord[];
}

/** One lexical similarity judgment from the internal index, before grounding. */
export interface TranscriptSemanticHit {
  transcriptId: string;
  excerpt: string;
  score: number;
  explanation: string;
}

export interface TranscriptRelevanceDeps {
  corpus: TranscriptRelevanceCorpus;
  store: TranscriptRelevanceStore;
  now?: () => Date;
  /** The bound one search returns and persists; bounded by design (AC #127). */
  maxResults?: number;
}

const DEFAULT_RELEVANCE_MAX_RESULTS = 8;
const MAX_EXCERPT_CHARS = 280;

class EmptyRelevanceQueryError extends Error {
  constructor() {
    super("A relevance query needs text to search for.");
    this.name = "EmptyRelevanceQueryError";
  }
}

class UnknownRelevanceCandidateError extends Error {
  constructor(candidateId: string) {
    super(`Unknown relevance candidate: ${candidateId}`);
    this.name = "UnknownRelevanceCandidateError";
  }
}

/** Decision vocabulary: the action names the act, the outcome the state. */
const OUTCOME_BY_ACTION: Record<
  TranscriptRelevanceDecisionAction,
  TranscriptRelevanceDecision["outcome"]
> = {
  confirm: "confirmed",
  reject: "rejected",
  unresolved: "unresolved",
};

interface GroundedHit {
  record: TranscriptRecord;
  text: string;
  spanStart: number;
  spanEnd: number;
  score: number;
  explanation: string;
}

/**
 * Semantic transcript relevance over the Transcript Catalog (issue #127).
 * Discovery returns bounded, cited, explained candidates whose review state
 * is carried entirely by the owner's decision log: unconfirmed similarity is
 * a suggestion, never a fact. The service writes no Profile, touches no
 * identity decision, and exposes confirmed relevance as the only
 * consumer-facing read.
 */
export class TranscriptRelevanceService {
  private readonly corpus: TranscriptRelevanceCorpus;
  private readonly store: TranscriptRelevanceStore;
  private readonly now: () => Date;
  private readonly maxResults: number;

  constructor(deps: TranscriptRelevanceDeps) {
    this.corpus = deps.corpus;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.maxResults = deps.maxResults ?? DEFAULT_RELEVANCE_MAX_RESULTS;
  }

  /**
   * One discovery run over every retained eligible Transcript revision. A
   * revision is eligible while its normalized text is retained; the corpus is
   * the Catalog's own list, so deleted revisions drop out by themselves.
   * Idempotent: the same query over the same corpus re-derives the same
   * candidate ids, so a rebuild never duplicates pending review work.
   */
  async search(
    query: TranscriptRelevanceQuery,
    options?: { limit?: number },
  ): Promise<TranscriptRelevanceCandidate[]> {
    const text = query.text.trim();
    if (!text) throw new EmptyRelevanceQueryError();
    const limit = options?.limit ?? this.maxResults;
    const records = this.corpus
      .listTranscripts()
      .filter((record) => record.normalizedText.trim().length > 0);
    const byId = new Map(records.map((record) => [record.id, record] as const));

    const hits = searchLexicalIndex({ query: { ...query, text }, records });
    const grounded: GroundedHit[] = [];
    for (const hit of hits) {
      const record = byId.get(hit.transcriptId);
      if (!record) continue;
      const excerpt = hit.excerpt.trim();
      if (!excerpt) continue;
      const at = record.normalizedText.indexOf(excerpt);
      if (at < 0) continue;
      const length = Math.min(excerpt.length, MAX_EXCERPT_CHARS);
      grounded.push({
        record,
        text: record.normalizedText.slice(at, at + length),
        spanStart: at,
        spanEnd: at + length,
        score: Number.isFinite(hit.score) ? hit.score : 0,
        explanation: String(hit.explanation),
      });
    }
    grounded.sort(
      (left, right) =>
        right.score - left.score ||
        left.record.id.localeCompare(right.record.id) ||
        left.spanStart - right.spanStart,
    );

    const createdAt = this.now().toISOString();
    const candidates = grounded.slice(0, limit).map((hit) => {
      const id = this.candidateId(text, query.meeting ?? null, hit);
      const existing = this.store.readCandidates().find((candidate) => candidate.id === id);
      return {
        id,
        query: { ...query },
        transcriptId: hit.record.id,
        excerpt: { text: hit.text, spanStart: hit.spanStart, spanEnd: hit.spanEnd },
        score: hit.score,
        explanation: hit.explanation,
        relevanceVersion: String(TRANSCRIPT_RELEVANCE_INDEX_VERSION),
        createdAt: existing?.createdAt ?? createdAt,
        sourceContext: this.sourceContextOf(hit.record),
      } satisfies TranscriptRelevanceCandidate;
    });
    for (const candidate of candidates) this.store.upsertCandidate(candidate);
    return candidates;
  }

  /**
   * The Review surface: every candidate with its current review state, pending
   * work first. The state is read from the decision log, never stored on the
   * candidate, so a rebuild cannot lose or double-count a review.
   */
  reviewQueue(): TranscriptRelevanceReviewItem[] {
    return this.store
      .readCandidates()
      .map((candidate) => {
        const decision = this.store.latestDecision(candidate.id);
        return {
          candidate,
          decision,
          reviewState: decision?.outcome ?? "pending",
        } satisfies TranscriptRelevanceReviewItem;
      })
      .sort(
        (left, right) =>
          Number(left.reviewState !== "pending") - Number(right.reviewState !== "pending") ||
          right.candidate.createdAt.localeCompare(left.candidate.createdAt) ||
          left.candidate.id.localeCompare(right.candidate.id),
      );
  }

  /**
   * One owner decision from the Review surface. Explicit only: this is the
   * single path through which similarity becomes anything, and confirming
   * never writes a Profile or an identity decision. Repeating the same
   * decision returns the recorded one instead of appending a second row.
   */
  decide(input: {
    candidateId: string;
    action: TranscriptRelevanceDecisionAction;
    note?: string;
  }): TranscriptRelevanceDecision {
    const candidate = this.store.readCandidates().find((c) => c.id === input.candidateId);
    if (!candidate) throw new UnknownRelevanceCandidateError(input.candidateId);
    const current = this.store.latestDecision(candidate.id);
    if (current && current.action === input.action) return current;
    const outcome = OUTCOME_BY_ACTION[input.action];
    const decision: TranscriptRelevanceDecision = {
      id: this.decisionId(candidate.id, input.action),
      candidateId: candidate.id,
      transcriptId: candidate.transcriptId,
      action: input.action,
      outcome,
      decidedBy: "owner",
      decidedAt: this.now().toISOString(),
      note: input.note?.trim() || null,
    };
    this.store.appendDecision(decision);
    return decision;
  }

  /**
   * The consumer-facing read: confirmed relevance only. Pending, rejected and
   * unresolved candidates are unreachable from here by construction, so no
   * factual consumer can pick up unconfirmed similarity.
   */
  confirmed(transcriptId?: string): TranscriptRelevanceCandidate[] {
    return this.store.readCandidates().filter((candidate) => {
      if (transcriptId !== undefined && candidate.transcriptId !== transcriptId) return false;
      return this.store.latestDecision(candidate.id)?.action === "confirm";
    });
  }

  /** Deterministic over the query context, the revision, and the excerpt span. */
  private candidateId(
    queryText: string,
    meeting: TranscriptRelevanceQuery["meeting"],
    hit: GroundedHit,
  ): string {
    return `rel_${createHash("sha1")
      .update(
        `${this.queryKey(queryText, meeting)}|${hit.record.id}|${hit.spanStart}|${hit.spanEnd}`,
      )
      .digest("hex")
      .slice(0, 12)}`;
  }

  private queryKey(queryText: string, meeting: TranscriptRelevanceQuery["meeting"]): string {
    return JSON.stringify({
      text: queryText,
      meeting: meeting
        ? {
            title: meeting.title?.trim() || null,
            purpose: meeting.purpose?.trim() || null,
            attendees: (meeting.attendees ?? []).map((v) => v.trim()).sort(),
            organizations: (meeting.organizations ?? []).map((v) => v.trim()).sort(),
            topics: (meeting.topics ?? []).map((v) => v.trim()).sort(),
          }
        : null,
    });
  }

  private sourceContextOf(record: TranscriptRecord): TranscriptRelevanceSourceContext {
    return {
      fileName: record.source.fileName,
      meetingDate: record.meetingDate,
      sourceUrl: record.source.sourceUrl,
    };
  }

  /** Unique per appended record: the audit log keeps every superseded step. */
  private decisionId(candidateId: string, action: TranscriptRelevanceDecisionAction): string {
    const sequence =
      this.store.readDecisions().filter((d) => d.candidateId === candidateId).length + 1;
    return `reld_${createHash("sha1")
      .update(`${candidateId}|${action}|${sequence}`)
      .digest("hex")
      .slice(0, 12)}`;
  }
}
