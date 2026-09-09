/* oxlint-disable typescript/no-unnecessary-condition -- module orchestrates optional stage deps and snapshot fields that may be absent on retry */
import type {
  MeetingBrief,
  MeetingBriefEvent,
  MeetingBriefRunResult,
  PersonProfileConsumerState,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID, MEETING_BRIEF_MODULE_VERSION } from "@chief-of-staff-demo/shared";
import {
  meetingBriefOccurrenceIdentity,
  parseMeetingBriefOccurrenceKey,
} from "@chief-of-staff-demo/shared";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import { snapshotEligibility, buildFrozenSnapshot } from "./snapshot.js";
import { occurrenceLookupWindow, type CalendarProvider } from "./calendar.js";
import type { GmailDeliveryProvider } from "./google/gmailDelivery.js";
import { executeDeliver } from "./deliver.js";
import { type FrozenMeetingOccurrence, type MeetingBriefGenerator } from "./generator.js";
export type MeetingBriefInput = MeetingBriefEvent & {
  occurrenceKey: string;
  supersedesRunId?: string | null;
  profileRefreshOf?: string;
};
export interface MeetingBriefModuleDeps {
  now?: () => Date;
  createBriefGenerator?: (context: RunContext) => MeetingBriefGenerator;
  gmailDeliveryProvider?: GmailDeliveryProvider | null;
  getOwnerEmail?: () => string | null;
  isOwnerProfileConfirmed?: () => boolean;
  /**
   * Manual-send intent for the deliver Stage (issue #163). The host returns
   * true for an explicit owner retry (and whenever per-Brief auto-send is
   * enabled); absent, the Stage sends — the historical behavior.
   */
  isManualSend?: (runId: string) => boolean;
  calendarProvider?: CalendarProvider;
  calendarSnapshotRequired?: boolean;
  personProfileConsumerState?: (
    profileId: string,
    profileRevision: number,
  ) => PersonProfileConsumerState | null;
}

function continuationInput(externalId: string | null, now: Date): MeetingBriefInput {
  const occurrenceKey = externalId ?? "unknown::unknown";
  const identity = parseMeetingBriefOccurrenceKey(occurrenceKey);
  const eventId = identity?.eventId ?? "unknown";
  const occurrenceId = identity?.occurrenceId ?? "unknown";
  return {
    calendarId: "primary",
    eventId,
    occurrenceId,
    occurrenceKey,
    version: "continuation",
    summary: "Meeting Brief continuation",
    startAt: now.toISOString(),
    endAt: now.toISOString(),
    attendees: [],
    status: "confirmed",
  };
}
/**
 * Meeting Brief Generator v1 — 4 fixed Stages (issue://80, ADR-0032/33/34).
 *
 * Stages: snapshot → enrich → compose → deliver (no dynamic names).
 */
export function meetingBriefModule(deps: MeetingBriefModuleDeps): ShellModule<MeetingBriefInput> {
  const now = deps.now ?? (() => new Date());

  return {
    id: MEETING_BRIEF_MODULE_ID,
    version: MEETING_BRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "snapshot") return "The calendar event could not be captured.";
      if (stage === "enrich") return "Enrichment failed — a required provider was unavailable.";
      if (stage === "compose") return "The meeting brief could not be composed.";
      if (stage === "deliver") return "The brief was ready but delivery failed.";
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      const fromStage = meta.failedStage;
      if (!["snapshot", "enrich", "compose", "deliver"].includes(fromStage)) return null;
      return {
        fromStage,
        reason: "failed_stage_is_safe_to_repeat",
        input: continuationInput(meta.externalId, now()),
        resetAttempts: false,
      };
    },

    planRecovery(state) {
      if (state.module !== MEETING_BRIEF_MODULE_ID) return null;
      if (state.status !== "pending" && state.status !== "running") return null;
      // Choose first incomplete stage by artifact presence.
      const files = new Set(state.files);
      if (!files.has("snapshot.json"))
        return {
          fromStage: "snapshot",
          reason: "durable_progress_first_incomplete",
          input: continuationInput(state.externalId, now()),
        };
      if (!files.has("enrich.json"))
        return {
          fromStage: "enrich",
          reason: "durable_progress_first_incomplete",
          input: continuationInput(state.externalId, now()),
        };
      if (!files.has("result.json"))
        return {
          fromStage: "compose",
          reason: "durable_progress_first_incomplete",
          input: continuationInput(state.externalId, now()),
        };
      return {
        fromStage: "deliver",
        reason: "durable_progress_first_incomplete",
        input: continuationInput(state.externalId, now()),
      };
    },

    planResume(meta) {
      if (meta.status === "blocked" && meta.wait?.reason === "quiet_period") {
        return {
          fromStage: "deliver",
          reason: "quiet_period_expired",
          input: continuationInput(meta.externalId, now()),
        };
      }
      if (meta.status === "blocked" && meta.wait?.reason === "provider_retry_backoff") {
        return {
          fromStage: "enrich",
          reason: "provider_retry_backoff_elapsed",
          input: continuationInput(meta.externalId, now()),
        };
      }
      return null;
    },

    async run(ctx: RunContext, input: MeetingBriefInput): Promise<RunOutcome> {
      const frozenSnapshotRaw = ctx.readFile("snapshot.json");
      let hasFrozenSnapshot = false;
      let frozenOccurrence: FrozenMeetingOccurrence | null = null;
      if (frozenSnapshotRaw) {
        try {
          const frozen = JSON.parse(frozenSnapshotRaw) as FrozenMeetingOccurrence;
          if (
            typeof frozen.calendarId === "string" &&
            typeof frozen.eventId === "string" &&
            typeof frozen.occurrenceId === "string" &&
            typeof frozen.occurrenceKey === "string" &&
            typeof frozen.version === "string" &&
            typeof frozen.capturedAt === "string" &&
            typeof frozen.materialFingerprint === "string" &&
            ["confirmed", "cancelled", "tentative"].includes(frozen.status) &&
            Array.isArray(frozen.attendees)
          ) {
            input = frozen;
            frozenOccurrence = frozen;
            hasFrozenSnapshot = true;
          }
        } catch {
          // A corrupt snapshot cannot be trusted as retry input; snapshot will run again and fail visibly if needed.
        }
      }
      const occurrenceKey = input.occurrenceKey;
      const snapshotAt = now().toISOString();
      const resolveOwner = (): string | null => {
        if (deps.getOwnerEmail) return deps.getOwnerEmail();
        return null;
      };
      const gmailDeliveryProvider = deps.gmailDeliveryProvider ?? null;

      // Retry optimization: if result.json already holds a brief and delivery is pending/failed,
      // we are retrying deliver. Snapshot/enrich/compose are preserved; skip them.
      let shouldSkipToDeliver = false;
      let existingBrief: MeetingBrief | null = null;
      const existingResultRaw = ctx.readFile("result.json");
      if (existingResultRaw) {
        try {
          const parsed = JSON.parse(existingResultRaw) as MeetingBriefRunResult;
          const hasBrief = parsed.meetingBrief && typeof parsed.meetingBrief === "object";
          const deliveryStatus = parsed.delivery?.status;
          if (hasBrief && (deliveryStatus === "failed" || deliveryStatus === "pending")) {
            existingBrief = parsed.meetingBrief;
            shouldSkipToDeliver = true;
          }
        } catch {
          // ignore parse failure
        }
      }
      // If snapshot.json missing but we think we should skip, don't skip — need snapshot
      if (shouldSkipToDeliver && !ctx.readFile("snapshot.json")) {
        shouldSkipToDeliver = false;
        existingBrief = null;
      }
      // snapshot — freezes current event, occurrence, version; ends skipped when not Eligible.
      // Retained frozen version via snapshot.json (ADR-0033).
      let snapshotSkipped = false;
      let snapshotSkipReason: string | null = null;
      if (!shouldSkipToDeliver && !hasFrozenSnapshot) {
        await ctx.stage("snapshot", async () => {
          // Freeze current Calendar truth when a provider is available. Provider failures fail
          // snapshot; a missing occurrence is an explicit skip, never stale Intake fallback.
          let current: MeetingBriefEvent = input;
          if (deps.calendarProvider) {
            let result: Awaited<ReturnType<CalendarProvider["listEvents"]>> | null = null;
            try {
              result = await deps.calendarProvider.listEvents({
                calendarId: input.calendarId,
                syncToken: null,
                ...occurrenceLookupWindow(now(), input.startAt),
              });
            } catch (error) {
              if (deps.calendarSnapshotRequired) throw error;
            }
            // A host with calendarUse "recheck" injects Calendar for delivery only, so a
            // failed list lands here best-effort. Production uses "snapshot", which sets
            // calendarSnapshotRequired above, so a failed list cannot reach this branch.
            if (result) {
              const found = result.events.find(
                (event) =>
                  meetingBriefOccurrenceIdentity(event.eventId, event.occurrenceId)
                    .occurrenceKey === occurrenceKey,
              );
              if (!found && deps.calendarSnapshotRequired) {
                const frozen = buildFrozenSnapshot(input, snapshotAt);
                ctx.writeFile(
                  "snapshot.json",
                  JSON.stringify(
                    { ...frozen, eligible: false, skipReason: "occurrence_not_found" },
                    null,
                    2,
                  ) + "\n",
                );
                ctx.event("snapshot_skipped", {
                  eventId: input.eventId,
                  occurrenceId: input.occurrenceId,
                  occurrenceKey,
                  version: input.version,
                  reason: "occurrence_not_found",
                });
                snapshotSkipped = true;
                snapshotSkipReason = "occurrence_not_found";
                return;
              }
              if (found) current = found;
            }
          }
          const owner = resolveOwner();
          const { eligible, reason } = snapshotEligibility(current, owner);
          if (!eligible) {
            ctx.event("snapshot_skipped", {
              eventId: current.eventId,
              occurrenceId: current.occurrenceId,
              occurrenceKey,
              version: current.version,
              reason,
            });
            const frozen = buildFrozenSnapshot(current, snapshotAt);
            ctx.writeFile(
              "snapshot.json",
              JSON.stringify({ ...frozen, eligible: false, skipReason: reason }, null, 2) + "\n",
            );
            snapshotSkipped = true;
            snapshotSkipReason = reason;
            return;
          }
          // Eligible: freeze snapshot
          ctx.event("snapshot_captured", {
            eventId: current.eventId,
            occurrenceId: current.occurrenceId,
            occurrenceKey,
            version: current.version,
            startAt: current.startAt,
          });
          const frozen: FrozenMeetingOccurrence = {
            ...buildFrozenSnapshot(current, snapshotAt),
            supersedesRunId: input.supersedesRunId ?? null,
            ...(input.profileRefreshOf ? { profileRefreshOf: input.profileRefreshOf } : {}),
          };
          ctx.writeFile(
            "snapshot.json",
            JSON.stringify(
              {
                ...frozen,
                eligible: true,
              },
              null,
              2,
            ) + "\n",
          );
          frozenOccurrence = frozen;
          input = frozen;
        });

        if (snapshotSkipped) {
          // No enrichment/email after skipped (issue://84).
          // Snapshot stage succeeded but Run ends skipped; remaining stages never run.
          return { status: "skipped", reason: snapshotSkipReason };
        }
      }

      // Generate one Brief through the deep content interface (issue #168).
      // Bundle selection, evidence collection, completeness, and prompt
      // assembly are all implementation detail behind generate(occurrence).
      let brief: MeetingBrief | null = existingBrief;
      if (!shouldSkipToDeliver) {
        if (!deps.createBriefGenerator) {
          throw new Error("Meeting Brief Generator is unavailable");
        }
        if (!frozenOccurrence) {
          throw new Error("Meeting Brief Generator requires a frozen occurrence");
        }
        brief = await deps.createBriefGenerator(ctx).generate(frozenOccurrence);
      }
      if (!brief) throw new Error("Deliver requires a composed Meeting Brief");
      const composedBrief = brief;
      // deliver — owner-only send with rechecks, idempotency, reconciliation (ADR-0034)
      const deliverOutcome = await ctx.stage("deliver", async () => {
        const deliverArgs: Parameters<typeof executeDeliver>[0] = {
          ctx,
          brief: composedBrief,
          input,
          occurrenceKey,
          now,
          calendarProvider: deps.calendarProvider ?? null,
          gmailDeliveryProvider: gmailDeliveryProvider ?? null,
          getOwnerEmail: () => resolveOwner(),
          // Absent, the Stage sends (historical behavior); the host passes its
          // explicit manual-send intent once per-Brief auto-send is disabled.
          manualSend: deps.isManualSend ? deps.isManualSend(ctx.runId) : true,
          ...(deps.isOwnerProfileConfirmed
            ? { isOwnerProfileConfirmed: deps.isOwnerProfileConfirmed }
            : {}),
          ...(deps.personProfileConsumerState
            ? { personProfileConsumerState: deps.personProfileConsumerState }
            : {}),
        };
        return executeDeliver(deliverArgs);
      });
      if (deliverOutcome.skipped) {
        return {
          status: "skipped",
          reason: deliverOutcome.skipReason ?? "cancelled_before_delivery",
        };
      }
      // Superseded is not a skip of the Run; it's a successful completion with delivery superseded.
      // The Run remains done, but index will show superseded delivery.

      return {
        status: "done",
        summary: `Brief for ${input.summary} — ${composedBrief.guests.length} guest(s)`,
        detail: {
          eventId: input.eventId,
          occurrenceKey,
          eventVersion: input.version,
          guests: composedBrief.guests.length,
        },
      };
    },
  };
}
