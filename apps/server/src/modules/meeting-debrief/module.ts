import type {
  MeetingDebriefExtraction,
  MeetingDebriefRunResult,
  MeetingDebriefReviewState,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
  MeetingDebriefExtractionSchema,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { modelDiagnosticEventDetail, parseResultShape } from "../../llm/failure.js";
import { errorMessage } from "../../engine/failure.js";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReview,
  DebriefIdentityReviewReader,
  DebriefOutputsDeps,
} from "./deps.js";
import {
  approvalBlockers,
  initialReviewState,
  mergeRegeneratedField,
  parseReviewState,
  serializeReviewState,
  type DebriefApprovalGateDeps,
} from "./review.js";
import {
  actionItemEvidence,
  buildDebriefMessages,
  clampDueDates,
  dropActionItemEvidence,
  resolveActionItemOwners,
  stripFulfilledActionItems,
  stripRestatedDecisions,
  stripUnverifiedRecipientEmails,
} from "./extraction.js";
import { composeExternalDebriefBody } from "./externalBody.js";

export type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "./deps.js";

const MAX_EXTRACT_ATTEMPTS = 3;

/**
 * The Module's input. `fresh` comes from the Catalog's mining hand-off,
 * `resume` from a Stage retry, and `review` from an owner re-entering a Run
 * that has already finished — to regenerate a field, or to publish the gated
 * outward writes. There is no clock arm: nothing expires, because nothing
 * waits.
 */
export type DebriefInput =
  | { kind: "fresh"; transcriptId: string }
  | { kind: "resume"; fromStage: "associate" | "extract" }
  | { kind: "review"; action: "owner" };

export interface MeetingDebriefModuleDeps {
  now?: () => Date;
  catalog: DebriefCatalogReader;
  identity: DebriefIdentityReviewReader;
  /** Deterministic extraction seam (tests, hermetic runtimes). */
  extract?: (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;
  /** Model-backed extraction when no override is injected. */
  getCompleteJson?: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo?: () => { provider: string; model: string };
  /**
   * The approval gate's collaborators (spec #450). Absent — as in a minimal
   * extraction-only harness — the gate stays closed: without a confirmed
   * owner identity and a Profile directory, no Debrief can be approved.
   */
  gate?: DebriefApprovalGateDeps;
  /**
   * The outward-write surface (issue #141). Absent, approval writes nothing
   * outward — the Module has no other way to reach Gmail or Tasks.
   */
  outputs?: DebriefOutputsDeps;
  /**
   * Where a successful extraction's proposed commitments become durable
   * Action Items (issue #177). The Debrief produces them and owns none of
   * them: this is a hand-over to the Workspace, and it is part of the extract
   * Stage, so a Run that reports done has materialized what it extracted.
   * Absent — as in an extraction-only harness — nothing is materialized and
   * the Run still finishes.
   */
  materializeActionItems?: (input: DebriefActionItemHandover) => void;
}

/** What the Debrief hands the Workspace after one successful extraction. */
interface DebriefActionItemHandover {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
  actionItems: MeetingDebriefExtraction["actionItems"];
}

/**
 * The one outward write the Debrief performs (issues #141, #182). Recipients
 * are every confirmed attendee other than the owner, plus the recipients the
 * owner confirmed explicitly. With no outward surface wired the action still
 * completes and nothing leaves the app, which is how #139's "no outward write"
 * property survives as structure rather than as a promise.
 */
/** The Gmail draft receipt, read on every retry so a repeat drafts nothing twice. */
interface DebriefDraftReceipt {
  version: 1;
  draftId: string;
  to: string[];
}

function readReceipt<T>(ctx: RunContext, file: string): T | null {
  const raw = ctx.readFile(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Create the Gmail draft, and nothing else (issue #182). This used to create
 * Google Tasks too, which made one button mean two unrelated things: a
 * recipient problem could block accepted work, and an owner who wanted the
 * work without the email had no way to say so. Tasks now come from the Action
 * Item queue, which needs no Gmail at all.
 *
 * The draft is driven from its Run receipt rather than from whether this
 * function has run before, so a retry after a failure drafts nothing twice.
 */
async function writeApprovalOutputs(
  ctx: RunContext,
  deps: MeetingDebriefModuleDeps,
  record: TranscriptRecord,
  state: MeetingDebriefReviewState,
  ownerEmail: string | null,
): Promise<void> {
  const outputs = deps.outputs;
  if (outputs === undefined) return;

  const debrief = currentDebrief(ctx);
  let draft = readReceipt<DebriefDraftReceipt>(ctx, "draft.json");
  if (draft === null) {
    const to = [
      ...state.roster.entries
        .filter((entry) => entry.email !== ownerEmail)
        .map((entry) => entry.email),
      ...state.recipients.additional.map((recipient) => recipient.email),
    ];
    const draftId = await outputs.createDraft({
      to,
      subject: `Meeting debrief — ${record.source.fileName}`,
      body: composeExternalDebriefBody(debrief, state.review.droppedActionItems),
    });
    draft = { version: 1, draftId, to };
    ctx.writeFile("draft.json", `${JSON.stringify(draft, null, 2)}\n`);
    ctx.event("debrief_draft_created", { draftId, recipientCount: to.length });
  }
}

/** How the Run's association stands, read from the immutable record itself. */
function rosterStatusOf(record: TranscriptRecord): "prefilled" | "requires_confirmation" {
  return record.occurrence !== null && record.roster.length > 0
    ? "prefilled"
    : "requires_confirmation";
}

async function extractWithModel(
  ctx: RunContext,
  record: TranscriptRecord,
  identity: DebriefIdentityReview,
  deps: MeetingDebriefModuleDeps,
): Promise<MeetingDebriefExtraction> {
  if (!deps.getCompleteJson) {
    throw new Error("Meeting Debrief extraction provider is unavailable");
  }
  const messages = buildDebriefMessages(record, identity);
  let lastFailure: unknown = null;
  let parsed: MeetingDebriefExtraction | null = null;
  for (let round = 1; round <= MAX_EXTRACT_ATTEMPTS; round++) {
    const attempt = ctx.attempt();
    const llm = deps.getLlmInfo?.() ?? { provider: "unknown", model: "unknown" };
    ctx.event("extract_attempt", { attempt, provider: llm.provider, model: llm.model });
    try {
      const raw = await deps.getCompleteJson()({
        system: messages.system,
        user: messages.user,
        schema: messages.schema,
        temperature: 0,
      });
      parsed = stripRestatedDecisions(
        stripFulfilledActionItems(
          clampDueDates(
            parseResultShape(
              "MeetingDebriefExtraction",
              MeetingDebriefExtractionSchema,
              dropActionItemEvidence(raw),
            ),
            record,
          ),
          actionItemEvidence(raw),
          record,
        ),
      );
      ctx.event("extract_ok", { attempt });
      break;
    } catch (error) {
      ctx.event("extract_error", {
        attempt,
        error: errorMessage(error),
        ...modelDiagnosticEventDetail(error),
      });
      lastFailure = error;
    }
  }
  if (!parsed) {
    if (Object.keys(modelDiagnosticEventDetail(lastFailure)).length > 0) {
      throw lastFailure;
    }
    throw new Error(`extraction failed after ${MAX_EXTRACT_ATTEMPTS} attempts`);
  }
  return parsed;
}

/** The current stored debrief, for merging a regenerated field into. */
function currentDebrief(ctx: RunContext): MeetingDebriefExtraction {
  const raw = ctx.readFile("result.json");
  if (!raw) throw new Error("Debrief Run has no stored result to regenerate from");
  return (JSON.parse(raw) as MeetingDebriefRunResult).debrief;
}

/**
 * Meeting Debrief v2 — extract, then wait for the owner (issues #139/#140).
 * The review wait is a Shell-owned durable wait (ADR-0038): it resumes when
 * the owner approves or regenerates, and expires to `skipped` after thirty
 * days. Regeneration is a Stage of its own whose model call sees only the
 * immutable input — the rejected value is structurally unreachable
 * (ADR-0037). The Module receives no outward-write capability at all, so a
 * Debrief Run structurally cannot write one.
 */
export function meetingDebriefModule(deps: MeetingDebriefModuleDeps): ShellModule<DebriefInput> {
  const now = deps.now ?? (() => new Date());
  /* A harness without a gate stays closed: no confirmed owner identity and no
     Profile directory can only ever mean "blocked", never "approved". */
  const gate: DebriefApprovalGateDeps = deps.gate ?? {
    ownerEmail: () => null,
    verifiedForEmail: () => null,
  };

  const extract = async (
    ctx: RunContext,
    record: TranscriptRecord,
  ): Promise<MeetingDebriefExtraction> => {
    const identity = deps.identity.reviewFor(record.id);
    const debrief = deps.extract
      ? await deps.extract({ record, identity })
      : await extractWithModel(ctx, record, identity, deps);
    const resolved = resolveActionItemOwners(debrief, deps.identity.reviewFor(record.id));
    return stripUnverifiedRecipientEmails(resolved, record);
  };

  /** Store the result of a finished extraction or regeneration on the Run. */
  const storeResult = (
    ctx: RunContext,
    debrief: MeetingDebriefExtraction,
    transcriptId: string,
  ): void => {
    const result: MeetingDebriefRunResult = {
      version: 1,
      transcriptId,
      extractedAt: now().toISOString(),
      debrief,
    };
    ctx.writeFile("result.json", JSON.stringify(result, null, 2) + "\n");
  };

  const ensureReviewState = (
    ctx: RunContext,
    record: TranscriptRecord,
  ): MeetingDebriefReviewState => {
    const existing = parseReviewState(ctx.readFile("review.json"));
    if (existing) return existing;
    const state = initialReviewState(ctx.runId, record);
    ctx.writeFile("review.json", serializeReviewState(state));
    return state;
  };

  /**
   * One owner Turn on a Run that has already finished. The Debrief no longer
   * waits for anybody, so this is only ever entered deliberately: the owner
   * asked to regenerate a field, or to publish the gated outward writes. Both
   * end the Run again rather than returning it to a wait.
   */
  const reviewTurn = async (ctx: RunContext, action: "owner"): Promise<RunOutcome> => {
    void action;
    const transcriptId = ctx.meta().externalId ?? null;
    if (!transcriptId) {
      throw new Error("Debrief Run has no transcript identity");
    }
    const record = deps.catalog.getTranscript(transcriptId);
    /* The Catalog lost the record: the Debrief's source is gone, so the Run
       ends skipped the same way an associate-stage loss does. */
    if (!record) {
      return { status: "skipped", reason: "transcript_not_in_catalog" };
    }
    const state = await ctx.stage("review", async () => ensureReviewState(ctx, record));

    const request = state.request;

    if (request?.kind === "regenerate") {
      // ADR-0037: the regeneration is one audited Stage, and its model call
      // sees exactly what every other generation saw — the immutable record
      // and the Catalog's review state. The replaced value is not an input.
      const merged = await ctx.stage("regenerate", async () => {
        const debrief = await extract(ctx, record);
        const merged = mergeRegeneratedField(currentDebrief(ctx), request.field, debrief);
        storeResult(ctx, merged, transcriptId);
        /* A regeneration is an extraction, so its proposals reach the queue
           the same way (issue #177). Materialization is idempotent and adds
           only what is new, so a decision already made on an unchanged
           proposal survives — a regenerated Debrief showing a commitment the
           queue never received would be the worse outcome. */
        deps.materializeActionItems?.({
          debriefRunId: ctx.runId,
          transcriptId,
          meetingId: record.meetingId,
          actionItems: merged.actionItems,
        });
        const next: MeetingDebriefReviewState = {
          ...state,
          review:
            request.field === "actionItems"
              ? { droppedActionItems: [], completedActionItems: [] }
              : state.review,
          request: null,
        };
        ctx.writeFile("review.json", serializeReviewState(next));
        ctx.event("debrief_regenerated", { field: request.field });
        return merged;
      });
      return {
        status: "done",
        summary: `Regenerated ${request.field} — ${merged.decisions.length} decision${
          merged.decisions.length === 1 ? "" : "s"
        }, ${merged.actionItems.length} action item${merged.actionItems.length === 1 ? "" : "s"}`,
        detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
      };
    }

    if (request?.kind === "approve") {
      /* The one gate that survives (goal: automation, except outward writes).
         Approval is what authorises the Gmail draft and the Google Tasks —
         nothing else about the Debrief waits on it. Both adapters are driven
         from Run receipts, so re-entering after a partial failure re-sends
         nothing and creates only what is missing. */
      return ctx.stage("review", async () => {
        /* The durable authority re-asserting the gate. The host route already
           refused synchronously with the same blockers; this catches the race
           where the gate closes between the route saying yes and the Stage
           running. The pending request is cleared so every seam answers
           again, and the Run ends unpublished rather than half-published. */
        const blockers = approvalBlockers(state, gate);
        if (blockers.length > 0) {
          const unlocked: MeetingDebriefReviewState = { ...state, request: null };
          ctx.writeFile("review.json", serializeReviewState(unlocked));
          ctx.event("debrief_approval_refused", { blockers });
          const held = currentDebrief(ctx);
          return {
            status: "done",
            summary: `No email draft — ${blockers.length} thing${
              blockers.length === 1 ? "" : "s"
            } to settle first (${held.actionItems.length} action item${
              held.actionItems.length === 1 ? "" : "s"
            })`,
            detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
          };
        }
        const owner = gate.ownerEmail();
        const approvedAt = state.approval?.approvedAt ?? now().toISOString();
        const locked: MeetingDebriefReviewState = {
          ...state,
          request: null,
          approval: { approvedAt },
        };
        ctx.writeFile("review.json", serializeReviewState(locked));
        const recipientCount =
          locked.roster.entries.filter((entry) => entry.email !== owner).length +
          locked.recipients.additional.length;
        if (!state.approval) {
          ctx.event("debrief_approved", { approvedAt, recipientCount });
        }
        await writeApprovalOutputs(ctx, deps, record, locked, owner);
        return {
          status: "done",
          summary: `Email draft created for ${recipientCount} recipient${
            recipientCount === 1 ? "" : "s"
          }`,
          detail: { transcriptId, rosterStatus: rosterStatusOf(record), approved: true },
        };
      });
    }

    /* Already published, and re-entered: the outward writes did not all
       finish — a Tasks outage after the draft went out (issue #141, AC 7).
       Both adapters are driven from Run receipts, so this re-sends nothing
       and creates only what is missing. */
    if (state.approval) {
      return ctx.stage("review", async () => {
        const owner = gate.ownerEmail();
        await writeApprovalOutputs(ctx, deps, record, state, owner);
        const recipientCount =
          state.roster.entries.filter((entry) => entry.email !== owner).length +
          state.recipients.additional.length;
        return {
          status: "done",
          summary: `Email draft created for ${recipientCount} recipient${
            recipientCount === 1 ? "" : "s"
          }`,
          detail: { transcriptId, rosterStatus: rosterStatusOf(record), approved: true },
        };
      });
    }

    /* No pending action — a stray re-entry. Nothing to do, and nothing to
       wait for: end the Run as it already was. */
    const debrief = currentDebrief(ctx);
    return {
      status: "done",
      summary: `${debrief.decisions.length} decision${
        debrief.decisions.length === 1 ? "" : "s"
      }, ${debrief.actionItems.length} action item${debrief.actionItems.length === 1 ? "" : "s"}`,
      detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
    };
  };

  return {
    id: MEETING_DEBRIEF_MODULE_ID,
    version: MEETING_DEBRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "associate") return "The Transcript Catalog has no record for this Debrief.";
      if (stage === "extract" || stage === "regenerate") {
        return reason === "extraction failed after 3 attempts"
          ? "Extraction failed after 3 attempts."
          : "Extraction failed. Retry to re-run it.";
      }
      if (stage === "review") return "Review could not complete. Retry to resume it.";
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      if (meta.failedStage === "associate") {
        return {
          fromStage: meta.failedStage,
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: meta.failedStage },
        };
      }
      if (meta.failedStage === "extract") {
        return {
          fromStage: "extract",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: "extract" },
          resetAttempts: true,
          discard: ["result.json"],
        };
      }
      if (meta.failedStage === "regenerate" || meta.failedStage === "review") {
        return {
          fromStage: "review",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "review", action: "owner" },
        };
      }
      return null;
    },

    planRecovery(state) {
      if (state.status !== "pending" && state.status !== "running") return null;
      if (state.files.includes("review.json") || state.files.includes("result.json")) {
        /* Extraction already happened and its result survived. Re-enter the
           review Stage, which now settles any pending owner request and ends
           the Run rather than re-arming a wait. */
        return {
          fromStage: "review",
          reason: state.files.includes("review.json")
            ? "debrief_review_survived_restart"
            : "debrief_result_survived_restart",
          input: { kind: "review", action: "owner" },
        };
      }
      return {
        fromStage: "associate",
        reason: "debrief_survived_restart",
        input: { kind: "resume", fromStage: "associate" },
      };
    },

    /**
     * Continuing a Run left blocked by an older build. Nothing blocks on
     * review any more, so this exists only to let those Runs finish: it
     * carries them into the review Stage, which settles and ends them.
     */
    planResume(meta) {
      if (meta.status !== "blocked" || !meta.wait) return null;
      return {
        fromStage: meta.wait.stage,
        reason: "owner_review_action",
        input: { kind: "review", action: "owner" },
      };
    },

    async run(ctx: RunContext, input: DebriefInput): Promise<RunOutcome> {
      if (input.kind === "review") {
        return reviewTurn(ctx, input.action);
      }

      const transcriptId =
        input.kind === "fresh" ? input.transcriptId : (ctx.meta().externalId ?? null);
      if (!transcriptId) {
        throw new Error("Debrief Run has no transcript identity");
      }

      // associate — consume the immutable record and the Catalog's review
      // state. Association stays live in the Catalog: later Calendar links
      // prefill the surfaces that read the record, not a frozen copy.
      const record = await ctx.stage("associate", async (): Promise<TranscriptRecord | null> => {
        const record = deps.catalog.getTranscript(transcriptId);
        if (!record) return null;
        const identity = deps.identity.reviewFor(transcriptId);
        ctx.event("association_consumed", {
          linked: record.occurrence !== null,
          occurrenceKey: record.occurrence?.occurrenceKey ?? null,
          rosterSize: record.roster.length,
          mentions: identity.mentions.length,
        });
        return record;
      });
      if (!record) {
        return { status: "skipped", reason: "transcript_not_in_catalog" };
      }

      // extract — the structured retrospective, from the stored artifact,
      // then the durable Action Items it proposed. Both inside the Stage: a
      // Run reports done once its proposals exist as Workspace records, not
      // once its text does (issue #177).
      await ctx.stage("extract", async () => {
        const debrief = await extract(ctx, record);
        storeResult(ctx, debrief, transcriptId);
        ctx.event("debrief_extracted", {
          decisions: debrief.decisions.length,
          actionItems: debrief.actionItems.length,
          openQuestions: debrief.openQuestions.length,
        });
        deps.materializeActionItems?.({
          debriefRunId: ctx.runId,
          transcriptId,
          meetingId: record.meetingId,
          actionItems: debrief.actionItems,
        });
        return debrief;
      });

      /* The Debrief is finished the moment it is extracted. It used to stop
         here against a thirty-day owner wait, which meant a workspace of
         transcripts sat `blocked` behind a person — the opposite of what this
         app is for. The review record is still written, because the roster,
         the recipients and the done/dismiss decisions are all still real; it
         is simply no longer a gate. The one thing that still waits for the
         owner is the outward writes — the Gmail draft and the Google Tasks —
         which `approve` performs by re-entering this Run. */
      await ctx.stage("review", async () => {
        ensureReviewState(ctx, record);
        ctx.event("debrief_review_started", {
          rosterStatus: rosterStatusOf(record),
        });
      });
      const debrief = currentDebrief(ctx);
      return {
        status: "done",
        summary: `${debrief.decisions.length} decision${
          debrief.decisions.length === 1 ? "" : "s"
        }, ${debrief.actionItems.length} action item${debrief.actionItems.length === 1 ? "" : "s"}`,
        detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
      };
    },
  };
}
