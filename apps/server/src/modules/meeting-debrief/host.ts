import type { FastifyInstance } from "fastify";
import type {
  MeetingDebriefDetail,
  MeetingDebriefExtraction,
  MeetingDebriefIdentitySummary,
  MeetingDebriefIndex,
  MeetingDebriefIndexEntry,
  MeetingDebriefReviewState,
  MeetingDebriefReviewView,
  MeetingDebriefRunResult,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_FIELDS,
  MEETING_DEBRIEF_INTAKE,
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
  type RunMeta,
  type RunSummary,
} from "@chief-of-staff-demo/shared";
import type { HostedModule } from "../../engine/host.js";
import { RunNotResumableError, Runner } from "../../engine/runner.js";
import type { RunHandle, Runs } from "../../runs.js";
import { latestDecisionsByMention } from "./extraction.js";
import {
  approvalBlockers,
  parseReviewState,
  serializeReviewState,
  type DebriefApprovalGateDeps,
} from "./review.js";
import { EMAIL_PATTERN } from "../../person-profile/profiles.js";
import type { DebriefProfileDirectory } from "./profiles.js";
import {
  meetingDebriefModule,
  type DebriefInput,
  type DebriefCatalogReader,
  type DebriefExtractInput,
  type DebriefIdentityReviewReader,
  type MeetingDebriefModuleDeps,
} from "./module.js";

import type { DebriefIdentityReview } from "./deps.js";
export type { DebriefIdentityReview } from "./deps.js";
export type { DebriefProfileDirectory } from "./profiles.js";

export interface MeetingDebriefHostDeps {
  /** Constructed once by the Shell: the run directory has one owner. */
  runs: Runs;
  catalog: DebriefCatalogReader;
  identity: DebriefIdentityReviewReader;
  /** Deterministic extraction seam (tests, hermetic runtimes). */
  extract?: (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;
  getCompleteJson?: MeetingDebriefModuleDeps["getCompleteJson"];
  getLlmInfo?: MeetingDebriefModuleDeps["getLlmInfo"];
  log?: (message: string) => void;
  now?: () => Date;
  /**
   * What the Workspace calls the Meeting a Transcript belongs to. A Debrief
   * addressed by its Drive file name reads as
   * "Copy of Erin- Richard-…-transcript-2026-06-04T20-30-00.000Z.json"; the
   * Meeting already carries a name a person would use.
   */
  meetingTitle?: (meetingId: string) => string | null;
  /** The Profile surface the review binds attendees and recipients through. */
  profiles?: DebriefProfileDirectory;
  /** The confirmed owner identity's email, for the approval gate (spec #450). */
  ownerEmail?: () => string | null;
  /** The outward-write surface terminal approval reaches (issue #141). */
  outputs?: MeetingDebriefModuleDeps["outputs"];
  /** Where extracted proposals become durable Action Items (issue #177). */
  materializeActionItems?: MeetingDebriefModuleDeps["materializeActionItems"];
  /**
   * Staleness hand-off to the Brief side (issue #162): fired after a review
   * action-item mutation (done/dismissed) persists, so the Daily/Weekly
   * briefings that derive from action items go stale. Never throws into the
   * review path — the shell wires it to MeetingBriefHost.notifyActionItemsChanged.
   */
}

function parseRunResult(raw: string | null): MeetingDebriefRunResult | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as MeetingDebriefRunResult;
  } catch {
    return null;
  }
}

/**
 * The mention kinds the Debrief presents as people. The Catalog retains every
 * span it classifies — products, and the all-capital runs it files as
 * `unknown` — deliberately, so identity review can see them; but the Debrief's
 * section asks who was mentioned, and answering it with Chrome, Playwright and
 * CIM is answering a different question.
 */
const PERSON_MENTION_KINDS = new Set(["person", "ambiguous-name"]);

/** The Catalog's review state, summarized for the Debrief surfaces. */
function identitySummary(review: DebriefIdentityReview): MeetingDebriefIdentitySummary {
  const latestDecision = new Map<string, { outcome: string; profileId: string | null }>();
  for (const [mentionId, decision] of latestDecisionsByMention(review.decisions)) {
    latestDecision.set(mentionId, { outcome: decision.outcome, profileId: decision.profileId });
  }
  const resolved: MeetingDebriefIdentitySummary["resolved"] = [];
  const unresolved: MeetingDebriefIdentitySummary["unresolved"] = [];
  for (const mention of review.mentions) {
    if (!PERSON_MENTION_KINDS.has(mention.kind)) continue;
    const decision = latestDecision.get(mention.id);
    if (
      decision &&
      (decision.outcome === "linked" || decision.outcome === "created") &&
      decision.profileId
    ) {
      resolved.push({
        mentionId: mention.id,
        surfaceText: mention.surfaceText,
        profileId: decision.profileId,
      });
    } else if (!decision || decision.outcome === "unresolved") {
      unresolved.push({ mentionId: mention.id, surfaceText: mention.surfaceText });
    }
  }
  return {
    resolved,
    unresolved,
    organizations: review.organizations.map((organization) => ({
      mentionId: organization.id,
      surfaceText: organization.surfaceText,
    })),
  };
}

/** The JSON body of a review route, read once and shaped loosely at the edge. */
interface RosterBody {
  entries?: Array<{ email?: unknown; displayName?: unknown }>;
}
interface RecipientBody {
  profileId?: unknown;
  email?: unknown;
}

/**
 * Meeting Debrief host — what the Shell holds (HostedModule) and what the
 * Transcript Catalog calls when mining completes (`process` / `backfill`,
 * issue #139). Exactly one Run per Transcript revision: a second mining pass
 * finds the Run it already made and starts nothing. Issue #140 adds the
 * review surface: the review wait, its expiry, roster and recipient
 * decisions, the approval gate, and redo after approval.
 */
export class MeetingDebriefHost implements HostedModule {
  readonly id = MEETING_DEBRIEF_MODULE_ID;
  readonly version = MEETING_DEBRIEF_MODULE_VERSION;
  private readonly runner: Runner<DebriefInput>;
  private readonly runs: Runs;
  private readonly catalog: DebriefCatalogReader;
  private readonly identity: DebriefIdentityReviewReader;
  private readonly gate: DebriefApprovalGateDeps;
  private readonly profiles: DebriefProfileDirectory | null;
  private readonly meetingTitle: ((meetingId: string) => string | null) | null;
  /** transcriptId → runId, rebuilt once per process from Runs and the log. */
  private knownRuns: Map<string, string> | null = null;
  /** `process` serializes through one chain, so two passes never race a scan. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: MeetingDebriefHostDeps) {
    this.runs = deps.runs;
    this.catalog = deps.catalog;
    this.identity = deps.identity;
    this.profiles = deps.profiles ?? null;
    this.meetingTitle = deps.meetingTitle ?? null;
    /* A host without owner identity or a Profile directory keeps the gate
       closed: approval then reports its blockers instead of passing. */
    this.gate = {
      ownerEmail: deps.ownerEmail ?? (() => null),
      verifiedForEmail: deps.profiles
        ? (email) => deps.profiles!.verifiedForEmail(email)
        : () => null,
    };
    this.runner = new Runner({
      runs: deps.runs,
      module: meetingDebriefModule({
        catalog: deps.catalog,
        identity: deps.identity,
        ...(deps.extract ? { extract: deps.extract } : {}),
        ...(deps.getCompleteJson ? { getCompleteJson: deps.getCompleteJson } : {}),
        ...(deps.getLlmInfo ? { getLlmInfo: deps.getLlmInfo } : {}),
        gate: this.gate,
        ...(deps.outputs ? { outputs: deps.outputs } : {}),
        ...(deps.materializeActionItems
          ? { materializeActionItems: deps.materializeActionItems }
          : {}),
        ...(deps.now ? { now: deps.now } : {}),
      }),
      log: deps.log,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  /** Resolves when every enqueued Run has settled (test seam). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  start(): void {
    this.runner.startRecoveryLoop();
    void this.releaseLegacyReviewWaits();
  }

  /**
   * Release Runs left blocked against the review wait an older build armed.
   *
   * Review no longer gates a Debrief, so a Run sitting against a thirty-day
   * owner wait is waiting for something that will never be asked of it. One
   * pass on boot carries each into the review Stage, which settles it and
   * ends the Run. Idempotent — a released Run is no longer blocked, so a
   * second boot finds nothing.
   */
  private async releaseLegacyReviewWaits(): Promise<void> {
    for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
      const meta = this.runs.open(summary.id)?.read();
      if (meta?.status !== "blocked" || meta.wait?.stage !== "review") continue;
      try {
        await this.runner.resumeRun(summary.id);
      } catch {
        // A Run that will not resume stays as it is; the next boot tries again.
      }
    }
  }

  stop(): void {
    this.runner.stopRecoveryLoop();
  }
  retryRun(id: string): Promise<RunMeta> {
    return this.runner.retryRun(id);
  }

  /**
   * Sweep due review waits now (ADR-0020's clock-resume path). The Runner's
   * recovery loop runs this on its slow tick; the hermetic journey calls it
   * to make expiry observable without waiting out the tick.
   */
  recover(): Promise<number> {
    return this.runner.recoverRuns();
  }

  /**
   * The one seam for owner-requested turns. A finished Run is re-entered at
   * its review Stage; a Run still blocked by an older build resumes the way
   * it always did. Overridable so a test can force the Shell-side call to
   * fail and prove the persisted request reverts instead of stranding it.
   */
  protected resumeOwnerTurn(runId: string): Promise<RunMeta> {
    const meta = this.runs.open(runId)?.read();
    if (meta?.status === "done" || meta?.status === "skipped") {
      return this.runner.reenterRun(runId, "review", "owner_review_action", {
        kind: "review",
        action: "owner",
      });
    }
    return this.runner.resumeRun(runId);
  }

  /** Undo a persisted owner request the Shell could not carry out. */
  private revertRequest(run: RunHandle, state: MeetingDebriefReviewState): void {
    this.writeState(run, { ...state, request: null });
  }

  /** The Catalog's mining-completion hand-off for one immutable Transcript. */
  process(record: TranscriptRecord): Promise<void> {
    const next = this.chain.then(() => this.processOne(record));
    this.chain = next.catch(() => {});
    return next;
  }

  /** The Catalog's historical hand-off: every registered record, every pass. */
  async backfill(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) {
      await this.process(record);
    }
  }

  private async processOne(record: TranscriptRecord): Promise<void> {
    if (this.knownRunFor(record.id)) return;
    const runId = await this.runner.startRun(
      {
        intake: MEETING_DEBRIEF_INTAKE,
        fileName: record.source.fileName,
        sourceUrl: record.source.sourceUrl,
        externalId: record.id,
      },
      { kind: "fresh", transcriptId: record.id },
    );
    this.knownRuns?.set(record.id, runId);
  }

  private knownRunFor(transcriptId: string): string | null {
    if (this.knownRuns === null) {
      const map = new Map<string, string>();
      for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
        const meta = this.runs.open(summary.id)?.read();
        if (meta?.externalId) map.set(meta.externalId, summary.id);
      }
      this.knownRuns = map;
    }
    return this.knownRuns.get(transcriptId) ?? null;
  }

  /**
   * A Run whose review the owner may still change: blocked in the review
   * wait, holding a review record, nothing approved, no action in flight.
   */
  /**
   * A Run the owner can still act on. A Debrief finishes as soon as it has
   * extracted — nothing waits — so `done` is the ordinary case here; `blocked`
   * is only a Run left mid-wait by an older build. Already approved or with a
   * request in flight, it is not open to another.
   */
  /** The Meeting's name, falling back to the file the Transcript came from. */
  private titleFor(
    record: { meetingId?: string | null; source: { fileName: string } } | null,
  ): string | null {
    if (!record) return null;
    const named = record.meetingId ? this.meetingTitle?.(record.meetingId) : null;
    return named ?? record.source.fileName;
  }

  private reviewable(runId: string): { run: RunHandle; state: MeetingDebriefReviewState } | null {
    const run = this.runs.open(runId);
    if (!run) return null;
    const meta = run.read();
    const open =
      meta.status === "done" || (meta.status === "blocked" && meta.wait?.stage === "review");
    if (!open) return null;
    const state = parseReviewState(run.readArtifact("review.json"));
    if (!state || state.approval || state.request) return null;
    return { run, state };
  }

  private writeState(run: RunHandle, state: MeetingDebriefReviewState): void {
    run.writeArtifact("review.json", serializeReviewState(state));
  }

  /**
   * Redo after approval (spec #453): a distinct Run re-extracts the same
   * immutable transcript. The approved Run is untouched — one local result
   * stays aligned with the draft and Task receipts the next slice creates.
   */
  private async redo(runId: string): Promise<{ runId: string }> {
    const run = this.runs.open(runId);
    if (!run) throw new RedoRefusedError("unknown-run", "No such Meeting Debrief Run.");
    const meta = run.read();
    const state = parseReviewState(run.readArtifact("review.json"));
    if (meta.status !== "done" || !state?.approval) {
      throw new RedoRefusedError(
        "redo-requires-approval",
        "Only an approved Debrief can be redone.",
      );
    }
    const transcriptId = meta.externalId;
    const record = transcriptId ? this.catalog.getTranscript(transcriptId) : null;
    if (!record) {
      throw new RedoRefusedError(
        "transcript-not-in-catalog",
        "The Transcript Catalog no longer holds this transcript.",
      );
    }
    const redoRunId = await this.runner.startRun(
      {
        intake: MEETING_DEBRIEF_INTAKE,
        fileName: record.source.fileName,
        sourceUrl: record.source.sourceUrl,
        externalId: record.id,
      },
      { kind: "fresh", transcriptId: record.id },
    );
    this.runs.open(redoRunId)?.appendEvent("debrief_redo", { ofRunId: runId });
    return { runId: redoRunId };
  }

  /**
   * The one state a Debrief still carries for the owner: whether its gated
   * outward writes have gone out. Extraction no longer waits for anybody, so
   * there is nothing else to report here.
   */
  private reviewStateOf(state: MeetingDebriefReviewState | null): "published" | null {
    return state?.approval ? "published" : null;
  }

  /** The approved sibling of a not-yet-approved Run, if one exists. */
  private duplicateWarningFor(
    runId: string,
    transcriptId: string | null,
    isApproved: boolean,
  ): MeetingDebriefReviewView["duplicateWarning"] {
    if (!transcriptId || isApproved) return null;
    for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
      if (summary.id === runId) continue;
      const run = this.runs.open(summary.id);
      if (!run || run.read().externalId !== transcriptId) continue;
      const other = parseReviewState(run.readArtifact("review.json"));
      if (other?.approval) return { approvedRunId: summary.id };
    }
    return null;
  }

  /**
   * The Gmail draft this Run created, read from its receipt (issue #182). A
   * draft, never a sent message: the URL opens Gmail's own compose view of
   * it, so finishing and sending stays the owner's own act.
   */
  private draftFor(run: RunHandle): MeetingDebriefReviewView["draft"] {
    const raw = run.readArtifact("draft.json");
    if (!raw) return null;
    try {
      const receipt = JSON.parse(raw) as { draftId?: unknown; to?: unknown };
      if (typeof receipt.draftId !== "string") return null;
      return {
        draftId: receipt.draftId,
        url: `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(receipt.draftId)}`,
        recipientCount: Array.isArray(receipt.to) ? receipt.to.length : 0,
      };
    } catch {
      return null;
    }
  }

  private async buildReviewView(
    run: RunHandle,
    runId: string,
    meta: RunMeta,
    state: MeetingDebriefReviewState,
    extraction: MeetingDebriefExtraction | null,
  ): Promise<MeetingDebriefReviewView> {
    const stateName = this.reviewStateOf(state) ?? "extracted";
    const owner = this.gate.ownerEmail();
    const automaticRecipients = state.roster.entries
      .filter(
        (entry): entry is typeof entry & { profileId: string; profileRevision: number } =>
          entry.profileId !== null && entry.profileRevision !== null && entry.email !== owner,
      )
      .map((entry) => ({
        profileId: entry.profileId,
        profileRevision: entry.profileRevision,
        email: entry.email,
      }));
    return {
      state: stateName,
      approvedAt: state.approval?.approvedAt ?? null,
      draft: this.draftFor(run),
      roster: {
        status: state.roster.status,
        confirmedAt: state.roster.confirmedAt,
        entries: state.roster.entries,
      },
      automaticRecipients,
      additionalRecipients: state.recipients.additional,
      suggestedRecipients: extraction?.suggestedRecipients ?? [],
      /* Blockers describe the outward writes, which are the one thing still
         gated — so they are reported until those writes have gone out. */
      approvalBlockers: stateName === "published" ? [] : approvalBlockers(state, this.gate),
      duplicateWarning: this.duplicateWarningFor(runId, meta.externalId, stateName === "published"),
    };
  }

  private entryFor(summary: RunSummary): MeetingDebriefIndexEntry | null {
    const run = this.runs.open(summary.id);
    if (!run) return null;
    const meta = run.read();
    if (!meta.externalId) return null;
    const record = this.catalog.getTranscript(meta.externalId);
    /* A Debrief the Catalog no longer has a Transcript for is not listed. It
       is how a retired duplicate leaves the journey — the Run stays exactly
       where it is, and the meeting it covered is still here under the copy
       that was kept, rather than three times over. */
    if (record === null) return null;
    const review = this.identity.reviewFor(meta.externalId);
    const identity = identitySummary(review);
    const extraction = parseRunResult(run.readArtifact("result.json"));
    const state = parseReviewState(run.readArtifact("review.json"));
    const linked = record.occurrence !== null;
    const rosterStatus = record.roster.length > 0 ? "prefilled" : "requires_confirmation";
    const owner = this.gate.ownerEmail();
    const automaticCount = state
      ? state.roster.entries.filter((entry) => entry.profileId !== null && entry.email !== owner)
          .length
      : 0;
    return {
      runId: summary.id,
      transcriptId: meta.externalId,
      meetingId: record.meetingId,
      status: summary.status,
      summary: summary.summary,
      meetingDate: record.meetingDate,
      fileName: this.titleFor(record) ?? meta.fileName ?? null,
      linked,
      occurrenceKey: record.occurrence?.occurrenceKey ?? null,
      rosterStatus,
      rosterSize: record.roster.length,
      identity: {
        resolvedCount: identity.resolved.length,
        unresolvedCount: identity.unresolved.length,
        organizationCount: identity.organizations.length,
      },
      reviewReadiness: extraction
        ? rosterStatus === "prefilled"
          ? "ready"
          : "needs_roster"
        : "no_extraction",
      reviewState: this.reviewStateOf(state),
      rosterConfirmed: state?.roster.status === "confirmed",
      recipientCount: automaticCount + (state?.recipients.additional.length ?? 0),
    };
  }

  private buildIndex(): MeetingDebriefIndex {
    const entries: MeetingDebriefIndexEntry[] = [];
    for (const summary of this.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs) {
      const entry = this.entryFor(summary);
      if (entry) entries.push(entry);
    }
    return { entries };
  }

  private async buildDetail(runId: string): Promise<MeetingDebriefDetail | null> {
    const summary = this.runs.detail(runId);
    if (!summary || summary.module !== MEETING_DEBRIEF_MODULE_ID) return null;
    const run = this.runs.open(runId);
    if (!run) return null;
    const meta = run.read();
    if (!meta.externalId) return null;
    const record = this.catalog.getTranscript(meta.externalId);
    const identity = identitySummary(this.identity.reviewFor(meta.externalId));
    const extraction = parseRunResult(run.readArtifact("result.json"));
    const state = parseReviewState(run.readArtifact("review.json"));
    const linked = record?.occurrence != null;
    const rosterStatus =
      record !== null && record.roster.length > 0 ? "prefilled" : "requires_confirmation";
    return {
      runId,
      transcriptId: meta.externalId,
      meetingId: record?.meetingId ?? null,
      status: summary.status,
      summary: summary.summary,
      skipReason: summary.skipReason,
      meetingDate: record?.meetingDate ?? null,
      fileName: record?.source.fileName ?? meta.fileName ?? null,
      sourceUrl: record?.source.sourceUrl ?? null,
      linked,
      occurrence: record?.occurrence
        ? {
            occurrenceKey: record.occurrence.occurrenceKey,
            calendarEventId: record.occurrence.calendarEventId,
          }
        : null,
      roster: record?.roster ?? [],
      speakers: record?.speakers ?? [],
      rosterStatus,
      identity,
      extraction: extraction?.debrief ?? null,
      reviewReadiness: extraction
        ? rosterStatus === "prefilled"
          ? "ready"
          : "needs_roster"
        : "no_extraction",
      review: state
        ? await this.buildReviewView(run, runId, meta, state, extraction?.debrief ?? null)
        : null,
    };
  }

  routes(app: FastifyInstance): void {
    app.get("/api/meeting-debrief/index", async () => this.buildIndex());
    app.get("/api/meeting-debrief/:runId", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const detail = await this.buildDetail(runId);
      if (!detail) {
        reply.code(404).send({ error: "Unknown Meeting Debrief Run" });
        return;
      }
      return detail;
    });

    app.post("/api/meeting-debrief/:runId/regenerate", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const found = this.reviewable(runId);
      if (!found) {
        reply.code(409).send({ error: "run-not-reviewable" });
        return;
      }
      const body = request.body as { field?: unknown };
      const field = body.field;
      if (typeof field !== "string" || !MEETING_DEBRIEF_FIELDS.includes(field as never)) {
        reply.code(400).send({ error: "unknown-field" });
        return;
      }
      found.state.request = { kind: "regenerate", field: field as never };
      this.writeState(found.run, found.state);
      found.run.appendEvent("debrief_regeneration_requested", { field });
      try {
        await this.resumeOwnerTurn(runId);
      } catch (error) {
        if (error instanceof RunNotResumableError) {
          /* The Shell never carried the request out: revert it, so the review
             stays unlocked and the route reports the failure honestly. */
          this.revertRequest(found.run, found.state);
          reply.code(409).send({ error: "run-not-resumable" });
          return;
        }
        throw error;
      }
      return { resumed: true, field };
    });

    app.post("/api/meeting-debrief/:runId/roster", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const found = this.reviewable(runId);
      if (!found) {
        reply.code(409).send({ error: "run-not-reviewable" });
        return;
      }
      const body = (request.body ?? {}) as RosterBody;
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const seen = new Set<string>();
      const cleaned: Array<{ email: string; displayName: string | null }> = [];
      for (const entry of entries) {
        if (typeof entry.email !== "string" || !EMAIL_PATTERN.test(entry.email.trim())) {
          reply.code(400).send({ error: "invalid-roster-entry" });
          return;
        }
        const email = entry.email.trim().toLowerCase();
        if (seen.has(email)) {
          reply.code(409).send({ error: "duplicate-roster-entry", email });
          return;
        }
        seen.add(email);
        cleaned.push({
          email,
          displayName:
            typeof entry.displayName === "string" && entry.displayName.trim() !== ""
              ? entry.displayName.trim()
              : null,
        });
      }

      const meta = found.run.read();
      const record = meta.externalId ? this.catalog.getTranscript(meta.externalId) : null;
      const linked = record?.occurrence != null;
      if (linked && !this.profiles) {
        reply.code(503).send({ error: "profile-directory-unconfigured" });
        return;
      }
      const bound: MeetingDebriefReviewState["roster"]["entries"] = [];
      const occurrenceKey = record?.occurrence?.occurrenceKey ?? null;
      /* Only emails the Calendar occurrence itself lists are Calendar's to
         anchor: a typed email absent from the roster is bound to an existing
         holder like an unlinked entry, and never minted a Calendar shell. */
      const occurrenceRosterEmails = new Set(
        (record?.roster ?? []).map((person) => person.email.trim().toLowerCase()),
      );
      try {
        for (const entry of cleaned) {
          const calendarListed = linked && occurrenceRosterEmails.has(entry.email);
          if (calendarListed && this.profiles) {
            const pinned = this.profiles.ensureCalendarAttendee(
              entry.email,
              `meeting-debrief roster — occurrence ${occurrenceKey}`,
            );
            bound.push({ ...entry, ...pinned });
          } else {
            const holder = this.profiles?.holderForEmail(entry.email) ?? null;
            bound.push({
              email: entry.email,
              displayName: entry.displayName,
              profileId: holder?.profileId ?? null,
              profileRevision: holder?.profileRevision ?? null,
            });
          }
        }
      } catch (error) {
        // A conflicting stable identifier refuses the whole confirmation —
        // never a silent merge (spec #117 creation and matching policy).
        reply.code(409).send({
          error: "roster-conflict",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const confirmedAt = new Date().toISOString();
      found.state.roster = { status: "confirmed", confirmedAt, entries: bound };
      this.writeState(found.run, found.state);
      found.run.appendEvent("review_roster_confirmed", { attendees: bound.length });
      return { roster: { status: "confirmed", confirmedAt, entries: bound } };
    });

    app.post("/api/meeting-debrief/:runId/recipients", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const found = this.reviewable(runId);
      if (!found) {
        reply.code(409).send({ error: "run-not-reviewable" });
        return;
      }
      if (!this.profiles) {
        reply.code(503).send({ error: "profile-directory-unconfigured" });
        return;
      }
      const body = (request.body ?? {}) as RecipientBody;
      const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (profileId === "" || !EMAIL_PATTERN.test(email)) {
        reply.code(400).send({ error: "invalid-recipient" });
        return;
      }
      /* A suggested non-attendee becomes a recipient only through this
         explicit, verified selection (spec #461): the Profile must be
         current, and its Calendar-anchored identity must hold the email. */
      const verified = this.profiles.verifiedForSelection(profileId, email);
      if (!verified) {
        reply.code(409).send({
          error: "recipient-unverified",
          message:
            "A recipient needs a confirmed Person Profile with a verified (Calendar-anchored) email.",
        });
        return;
      }
      const exists = found.state.recipients.additional.some(
        (recipient) => recipient.profileId === verified.profileId || recipient.email === email,
      );
      if (exists) {
        reply.code(409).send({ error: "recipient-duplicate" });
        return;
      }
      found.state.recipients.additional.push({
        profileId: verified.profileId,
        profileRevision: verified.profileRevision,
        email,
      });
      this.writeState(found.run, found.state);
      found.run.appendEvent("review_recipient_added", { profileId, email });
      return { recipients: found.state.recipients.additional };
    });

    app.delete("/api/meeting-debrief/:runId/recipients/:profileId", async (request, reply) => {
      const { runId, profileId } = request.params as { runId: string; profileId: string };
      const found = this.reviewable(runId);
      if (!found) {
        reply.code(409).send({ error: "run-not-reviewable" });
        return;
      }
      const remaining = found.state.recipients.additional.filter(
        (recipient) => recipient.profileId !== profileId,
      );
      if (remaining.length === found.state.recipients.additional.length) {
        reply.code(404).send({ error: "unknown-recipient" });
        return;
      }
      found.state.recipients.additional = remaining;
      this.writeState(found.run, found.state);
      found.run.appendEvent("review_recipient_removed", { profileId });
      return { recipients: remaining };
    });

    app.post("/api/meeting-debrief/:runId/approve", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const found = this.reviewable(runId);
      if (!found) {
        reply.code(409).send({ error: "run-not-reviewable" });
        return;
      }
      const blockers = approvalBlockers(found.state, this.gate);
      if (blockers.length > 0) {
        reply.code(409).send({ error: "approval-blocked", blockers });
        return;
      }
      found.state.request = { kind: "approve" };
      this.writeState(found.run, found.state);
      found.run.appendEvent("debrief_approval_requested", {});
      try {
        await this.resumeOwnerTurn(runId);
      } catch (error) {
        if (error instanceof RunNotResumableError) {
          this.revertRequest(found.run, found.state);
          reply.code(409).send({ error: "run-not-resumable" });
          return;
        }
        throw error;
      }
      return { resumed: true };
    });

    app.post("/api/meeting-debrief/:runId/redo", async (request, reply) => {
      const { runId } = request.params as { runId: string };
      try {
        return await this.redo(runId);
      } catch (error) {
        if (error instanceof RedoRefusedError) {
          reply.code(409).send({ error: error.condition, message: error.message });
          return;
        }
        throw error;
      }
    });
  }
}

/** Why redo refused: a condition the review surface renders. */
class RedoRefusedError extends Error {
  constructor(
    readonly condition: string,
    message: string,
  ) {
    super(message);
    this.name = "RedoRefusedError";
  }
}
