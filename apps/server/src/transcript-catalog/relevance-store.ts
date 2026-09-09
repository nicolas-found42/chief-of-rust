import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TranscriptRelevanceCandidate,
  TranscriptRelevanceDecision,
} from "@chief-of-staff-demo/shared";

/**
 * Durable state of semantic transcript relevance, one JSON collection per kind
 * under the Catalog's Workspace directory. Candidates are derived state — a
 * deterministic re-derivation replaces them by id — while decisions are an
 * append-only audit record that survives every rebuild and restart. They are
 * stored apart from identity decisions: relevance confirmation is its own
 * decision kind (issue #127).
 */
export class TranscriptRelevanceStore {
  private readonly root: string;

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, "transcript-catalog", "relevance");
  }

  readCandidates(): TranscriptRelevanceCandidate[] {
    return this.readCollection<TranscriptRelevanceCandidate>("candidates.json");
  }

  /** Replace-by-id: a rebuild re-derives the same candidate, never a second. */
  upsertCandidate(candidate: TranscriptRelevanceCandidate): void {
    const all = this.readCandidates().filter((existing) => existing.id !== candidate.id);
    all.push(candidate);
    all.sort((left, right) => left.id.localeCompare(right.id));
    this.write("candidates.json", all);
  }

  /** Append-only: decisions are audit records and are never rewritten. */
  appendDecision(decision: TranscriptRelevanceDecision): void {
    const all = this.readDecisions();
    all.push(decision);
    this.write("decisions.json", all);
  }

  readDecisions(): TranscriptRelevanceDecision[] {
    return this.readCollection<TranscriptRelevanceDecision>("decisions.json");
  }

  /** The current decision for a candidate: its latest appended record. */
  latestDecision(candidateId: string): TranscriptRelevanceDecision | null {
    return (
      this.readDecisions()
        .filter((d) => d.candidateId === candidateId)
        .at(-1) ?? null
    );
  }

  /**
   * The transcript-deletion cascade (issue #128): relevance candidates and
   * their decisions are transcript-derived records, so a deleted transcript
   * carries them. The decision log is otherwise append-only; this is the one
   * deletion path, and it is idempotent over an emptied store.
   */
  forgetTranscript(transcriptId: string): { candidates: number; decisions: number } {
    /* Both filters run unconditionally, so a decision orphaned by a
       mid-cascade crash cannot survive a completed re-deletion. */
    const candidates = this.readCandidates();
    const removedIds = new Set(
      candidates
        .filter((candidate) => candidate.transcriptId === transcriptId)
        .map((candidate) => candidate.id),
    );
    this.write(
      "candidates.json",
      candidates.filter((candidate) => candidate.transcriptId !== transcriptId),
    );
    const decisions = this.readDecisions();
    const keptDecisions = decisions.filter(
      (decision) => decision.transcriptId !== transcriptId && !removedIds.has(decision.candidateId),
    );
    this.write("decisions.json", keptDecisions);
    return { candidates: removedIds.size, decisions: decisions.length - keptDecisions.length };
  }

  private readCollection<T>(file: string): T[] {
    return (this.read(join(this.root, file)) as T[] | null) ?? [];
  }

  private write(file: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, file);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const staging = `${path}.tmp`;
    writeFileSync(staging, content);
    renameSync(staging, path);
  }

  private read(path: string): unknown {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
}
