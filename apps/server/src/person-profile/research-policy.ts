import type {
  PersonProfile,
  PersonResearchCoverageArea,
  PersonResearchLead,
} from "@chief-of-staff-demo/shared";
import { scoreLead, type SelectionContext } from "./research-plan.js";
import type { ResearchAllowance } from "./research.js";

/** Synchronous completion-order observations with an irreversible outage latch. */
export class ExtractionHealth {
  private consecutiveFailures = 0;
  private answered = false;
  private stopped = false;

  constructor(private readonly tolerance: number) {}

  failure(): boolean {
    this.consecutiveFailures += 1;
    this.stopped ||= this.consecutiveFailures >= this.tolerance;
    return this.stopped;
  }

  success(): void {
    this.answered = true;
    // An in-flight success can demonstrate recovery before the threshold,
    // but cannot revoke an interruption already established by other calls.
    if (!this.stopped) this.consecutiveFailures = 0;
  }

  get neverAnswered(): boolean {
    return this.consecutiveFailures > 0 && !this.answered;
  }

  get interrupted(): boolean {
    return this.stopped;
  }
}

/**
 * The four policies one continuous research operation runs under.
 *
 * They used to be closures inside `PersonResearch.run`, which made them
 * unreachable except by driving a whole research operation: to ask what the
 * budget would do at its ceiling, or which leads selection would defer, you had
 * to run research and infer the answer from its report. Naming them here does
 * not change any of those answers — the existing suites are the specification —
 * it makes each one askable on its own.
 *
 * The completion conditions joined them for a stronger reason (#238): whether
 * an operation has earned the word `completed` was never asked at all. It was
 * inferred — nothing interrupted it, no bound was reached, therefore it must be
 * finished — which is how an operation that never worked its plan could report
 * completion.
 */

/**
 * Allowance policy: what one operation may spend before it is bounded.
 *
 * Every ceiling here is a safety bound, never a definition of "done". Reaching
 * one concludes the operation `bounded` with its pending leads intact; only the
 * completion conditions can conclude `completed`. The first bound reached is
 * the one reported, because that is the one that actually stopped the work.
 */
export class ResearchBudget {
  private requests = 0;
  private modelCalls = 0;
  private readonly startedAtMs: number;
  private boundReason: string | null = null;

  constructor(
    private readonly allowance: ResearchAllowance,
    private readonly options: {
      /** Whether the operation is still live; an interruption is not a bound. */
      active: () => boolean;
      now?: () => number;
    },
  ) {
    this.startedAtMs = (options.now ?? Date.now)();
  }

  /** Why the operation stopped short, or null while it still has room. */
  get reason(): string | null {
    return this.boundReason;
  }

  get spentRequests(): number {
    return this.requests;
  }

  get spentModelCalls(): number {
    return this.modelCalls;
  }

  /** Room left, without reserving any of it. */
  within(): boolean {
    const now = (this.options.now ?? Date.now)();
    if (now - this.startedAtMs >= this.allowance.maxMilliseconds) {
      this.boundReason ??=
        "The operation's wall-clock backstop was reached with work still pending.";
      return false;
    }
    if (this.requests >= this.allowance.maxRequests) {
      this.boundReason ??= "The operation's request ceiling was reached with work still pending.";
      return false;
    }
    if (this.modelCalls >= this.allowance.maxModelCalls) {
      this.boundReason ??=
        "The operation's model-call ceiling was reached with work still pending.";
      return false;
    }
    return true;
  }

  /** Reserve one network request, or record why it was refused. */
  takeRequest(): boolean {
    if (!this.within() || !this.options.active()) return false;
    if (!this.allowance.reserveRequest()) {
      this.boundReason ??= "The Workspace declined a further research request.";
      return false;
    }
    this.requests += 1;
    return true;
  }

  /** Reserve one model call, or record why it was refused. */
  takeModelCall(): boolean {
    if (!this.within() || !this.options.active()) return false;
    if (!this.allowance.reserveModelCall()) {
      this.boundReason ??= "The Workspace declined a further model call.";
      return false;
    }
    this.modelCalls += 1;
    return true;
  }
}

/** What one round decided to read, and what it left pending with its score. */
export interface ReadBatchSelection {
  batch: PersonResearchLead[];
  /** Discovered, scored, and not read this round. Never dropped. */
  deferred: PersonResearchLead[];
}

/**
 * How many leads one read round works through: two batches' worth, so a
 * stalled read leaves no reader idle while the next round still re-scores
 * against what the previous one learned. Both the read batch's cut and the
 * planner throttle measure against this number — if the two drifted, the
 * throttle would suppress aims against a batch size selection no longer
 * honors.
 */
export function readBatchSize(readConcurrency: number): number {
  return Math.max(1, readConcurrency * 2);
}

/**
 * Collection policy: which of the discovered leads this round reads.
 *
 * Registration order is not the rule any more. Everything discovered is scored
 * against relevance, independence and unfilled coverage; the batch is the best
 * of it, and the rest stays pending with its score recorded rather than being
 * silently dropped — a URL discarded before retrieval has to stay visible as
 * its own decision.
 */
export function selectReadBatch(input: {
  profile: PersonProfile;
  candidates: PersonResearchLead[];
  /** Coverage areas not yet satisfied, which raise a lead's score. */
  unsatisfied: Set<string>;
  /** Discovery context per lead id, as its rank, title and snippet. */
  context: (leadId: string, target: string) => { title: string; snippet: string; rank: number };
  readHosts: Map<string, number>;
  readIndexes: Map<string, number>;
  sourcePerformance?: SelectionContext["sourcePerformance"];
  readConcurrency: number;
  /** Records the score against the lead, so a deferral keeps its reason. */
  score: (leadId: string, selection: NonNullable<PersonResearchLead["selection"]>) => void;
}): ReadBatchSelection {
  for (const lead of input.candidates) {
    const context = input.context(lead.id, lead.target);
    const selection: SelectionContext = {
      profile: input.profile,
      readHosts: input.readHosts,
      readIndexes: input.readIndexes,
      unsatisfied: input.unsatisfied,
      ...(input.sourcePerformance ? { sourcePerformance: input.sourcePerformance } : {}),
      rank: context.rank,
      title: context.title,
      snippet: context.snippet,
    };
    input.score(lead.id, scoreLead(lead, selection));
  }
  const ranked = [...input.candidates].sort(
    (a, b) => (b.selection?.score ?? 0) - (a.selection?.score ?? 0),
  );
  const size = readBatchSize(input.readConcurrency);
  /* The deferred stay in score order too: their records are what a developer
     reads to see which URL was discovered and not retrieved, and the ranking
     is the reason it was not. */
  return { batch: ranked.slice(0, size), deferred: ranked.slice(size) };
}
/**
 * Backlog retirement policy: when a deferral becomes a decision.
 *
 * Selection re-scores the whole pending pool every round and reads only the
 * batch, so while discovery out-runs the read budget the deferred tail grows
 * faster than any allowance can drain it — #239's committed census records
 * 31,251 leads across one 30-person run, 89% of them ending `interrupted`,
 * with the read batch's scores (p10 8.4) starting where the deferred pool's
 * 90th percentile (6.35) ends. A lead this round deferred that trails the
 * batch's own floor by more than the selection margin has, by the operation's
 * measured ranking, lost its case: it is resolved `rejected` with the score
 * and the floor in its reason, so "rejected" reads as the ranking's verdict,
 * not a claim that the page is about someone else. A lead within the margin
 * of the batch — the census margin keeps the near-miss band pending — stays
 * pending work, and the round's reads reach it once the head above it
 * drains; depth of discovery is never itself the reason a lead is dropped.
 */
export function retireSurpassedLeads(input: {
  /** The leads selection deferred this round, in score order. */
  deferred: PersonResearchLead[];
  /** The read batch's lowest score this round; the margin measures from it. */
  batchFloor: number;
  /** How far below the batch a deferral becomes a decision. */
  margin: number;
}): PersonResearchLead[] {
  return input.deferred.filter(
    (lead) => (lead.selection?.score ?? 0) < input.batchFloor - input.margin,
  );
}

/**
 * Planner throttle: whether expansion has earned a planner model call.
 *
 * The planner exists to aim discovery at coverage the evidence has not
 * reached. When the pending pool already holds a read batch's worth of
 * readable leads, the next round is fully loaded and the deterministic
 * derivation still runs, so the call would buy a longer queue rather than
 * better aims — and model calls are the operation's scarcest allowance.
 * Asked only when the pool cannot fill the next batch. The count is every
 * readable lead — urls, records, media and documents, exactly the pool
 * `selectReadBatch` draws its candidates from — not urls alone: a pool of
 * pending documents fills a read batch just as a pool of pending urls does.
 */
export function plannerIsWorthACall(input: {
  pendingReadable: number;
  batchSize: number;
}): boolean {
  return input.pendingReadable < input.batchSize;
}

/**
 * Publication policy: one writer at a time into the dossier.
 *
 * Reading is parallel and publication is not. The dossier store publishes
 * against an expected revision, so two batch members finishing together would
 * otherwise race each other into a conflict that looks like a lifecycle event.
 * A failed publication does not poison the queue behind it.
 */
export class PublicationGate {
  private tail: Promise<void> = Promise.resolve();

  publish<T>(work: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Which completion condition an operation has not met. */
export interface CompletionShortfall {
  /**
   * The condition, as its own vocabulary rather than prose: a caller deciding
   * what to do next reads this, and a reader reads `reason`.
   */
  condition: "coverage-uninvestigated" | "leads-pending" | "expansion-unfinished";
  /** One sentence naming what is missing, for the operation's own detail. */
  reason: string;
}

/**
 * Completion policy: whether this operation has earned the word `completed`.
 *
 * The conditions are the spec's own, in its order: the planned coverage has
 * been worked, every lead the operation ever considered carries a disposition,
 * and expansion has been tried against the thin areas and gone quiet. All three
 * are read off the durable record — the coverage plan and the lead registry —
 * so neither the shape of the loop's exit nor a model's statement that it is
 * finished is an input.
 *
 * Returns the first unmet condition, or null when all of them hold. Completion
 * still asserts nothing about the internet: an area that was investigated and
 * yielded nothing completes, with its gap published rather than hidden.
 */
export function evaluateCompletion(input: {
  coverage: PersonResearchCoverageArea[];
  leads: PersonResearchLead[];
  /** Consecutive expansion rounds that produced neither evidence nor leads. */
  quietRounds: number;
  /** How many of those the allowance requires before expansion is finished. */
  requiredQuietRounds: number;
}): CompletionShortfall | null {
  const unworked = input.coverage.filter((area) => area.state === "planned");
  if (unworked[0])
    return {
      condition: "coverage-uninvestigated",
      reason: `${String(unworked.length)} planned coverage areas were never investigated, starting with: ${unworked[0].label}.`,
    };
  const pending = input.leads.filter((lead) => lead.disposition === "pending");
  if (pending[0])
    return {
      condition: "leads-pending",
      reason: `${String(pending.length)} actionable leads were still unresolved, starting with: ${pending[0].target.slice(0, 200)}.`,
    };
  if (input.quietRounds < input.requiredQuietRounds)
    return {
      condition: "expansion-unfinished",
      reason: `Expansion was still producing new evidence or leads after ${String(input.quietRounds)} of ${String(input.requiredQuietRounds)} quiet rounds.`,
    };
  return null;
}
