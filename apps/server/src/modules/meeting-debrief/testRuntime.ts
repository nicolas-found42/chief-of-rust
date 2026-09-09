import type {
  IdentityDecision,
  MeetingDebriefExtraction,
  OrganizationMention,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import type { FastifyInstance } from "fastify";
import type { Runs } from "../../runs.js";
import { TranscriptCatalogStore } from "../../transcript-catalog/store.js";
import { TranscriptIdentityStore } from "../../transcript-catalog/identity-store.js";
import type { TranscriptIdentityService } from "../../transcript-catalog/identity.js";
import { MEETING_DEBRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost, type MeetingDebriefHostDeps } from "./host.js";
import { workspaceProfileDirectory } from "./profiles.js";
import { PersonProfileStore } from "../../person-profile/store.js";
import { WorkspacePersonProfiles } from "../../person-profile/profiles.js";

export interface MeetingDebriefTestRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  /**
   * The Workspace's one identity service, read through for `reviewFor`. The
   * seed below still writes fixture mentions and decisions straight to the
   * store: seeding is durable state, and reading it back is a question.
   */
  identity: TranscriptIdentityService;
  /** The confirmed owner identity's email, as the Shell holds it. */
  ownerEmail?: () => string | null;
  /**
   * Staleness hand-off to the Brief side (issue #162): fired after a review
   * action-item mutation persists. The shell wires it to notifyActionItemsChanged.
   */
  /** Where extracted proposals become durable Workspace Action Items (issue #177). */
  materializeActionItems?: MeetingDebriefHostDeps["materializeActionItems"];
  log?: (message: string) => void;
}

/** What the hermetic seed route accepts for one transcript's identity state. */
interface SeedIdentityState {
  mentions?: TranscriptMention[];
  decisions?: IdentityDecision[];
  organizations?: OrganizationMention[];
}

/** Calendar-anchored Profiles the hermetic journey can seed before review. */
interface SeedProfile {
  fullName: string;
  email: string;
}

interface MeetingDebriefSeedPayload {
  /** The immutable record exactly as the Catalog would have registered it. */
  transcript: TranscriptRecord;
  identity?: SeedIdentityState;
  profiles?: SeedProfile[];
  /** Seed as an already-approved Run, to exercise the duplicate-warning path. */
  approved?: boolean;
}

export interface MeetingDebriefTestRuntime {
  host: MeetingDebriefHost;
  /** Writes the immutable artifact + identity state, then hands the record to
   *  the host at the exact seam the Catalog calls on mining completion. */
  seed(payload: MeetingDebriefSeedPayload): Promise<string>;
  setNow(value: Date): void;
  advance(ms: number): Date;
}

/**
 * Deterministic extraction for the hermetic journey: it derives the structured
 * debrief from the record's own lines and resolves owners against the Catalog
 * review state the same way the model-backed path must — by naming the mention
 * whose surface text the owner matches. A follow-up line addressed to a
 * non-roster person ("I will send you the summary, Carol") produces the
 * suggested recipient the review surface then confirms explicitly.
 */
function deterministicDebriefExtraction(
  record: TranscriptRecord,
  identity: { mentions: TranscriptMention[] },
): MeetingDebriefExtraction {
  const lines = record.normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const speakerOf = (line: string): string | null => {
    const separator = line.indexOf(":");
    return separator > 0 ? line.slice(0, separator).trim() : null;
  };
  const decisionLine =
    lines.find((line) => /decided|agreed|we will ship|decision/i.test(line)) ?? lines[0] ?? "";
  const actionLine =
    lines.find((line) => /\bI will\b|\bwill own\b|\bfollow up\b|\btake a look\b/i.test(line)) ?? "";
  const questionLine = lines.find((line) => line.includes("?")) ?? "";

  const mentionForSurface = (surface: string | null): TranscriptMention | null => {
    if (!surface) return null;
    const needle = surface.toLowerCase();
    return (
      identity.mentions.find(
        (mention) =>
          mention.surfaceText.toLowerCase() === needle || mention.normalizedForms.includes(needle),
      ) ?? null
    );
  };

  const actionOwner = speakerOf(actionLine);
  const actionMention = mentionForSurface(actionOwner);
  const decisionSpeaker = speakerOf(decisionLine);
  const questionSpeaker = speakerOf(questionLine);

  const rosterEmails = new Set(record.roster.map((person) => person.email.toLowerCase()));
  const suggestedRecipients: Array<{ name: string; email: string | null }> = [];
  for (const line of lines) {
    const match = /(?:send|share|forward)[^.]*\bto\s+([A-Z][a-z]+)/.exec(line);
    const name = match?.[1];
    if (!name || rosterEmails.has(name.toLowerCase())) continue;
    if (suggestedRecipients.some((suggestion) => suggestion.name === name)) continue;
    suggestedRecipients.push({ name, email: null });
  }

  return {
    version: 1,
    summary: `Retrospective of ${record.source.fileName}: ${decisionLine || "no decision line found"}`,
    decisions: [
      {
        statement: decisionLine || "No explicit decision was recorded",
        evidence: decisionLine || null,
      },
    ],
    actionItems: actionLine
      ? [
          {
            title: actionLine.replace(/^[^:]*:\s*/, ""),
            owner: actionOwner ?? actionMention?.surfaceText ?? null,
            ownerMentionId: actionMention?.id ?? null,
            ownerProfileId: null,
            dueDate: record.meetingDate,
          },
        ]
      : [],
    openQuestions: questionLine
      ? [{ question: questionLine.replace(/^[^:]*:\s*/, ""), raisedBy: questionSpeaker }]
      : [],
    effectivenessEvidence: `The transcript has ${lines.length} utterance lines; the decision was stated by ${
      decisionSpeaker ?? "an unidentified speaker"
    }.`,
    coachingAdvice: "Close open questions in the next session and confirm the roster.",
    suggestedRecipients,
  };
}

/**
 * Hermetic runtime for the browser journey (ENABLE_TEST_SEED=1). Everything
 * the production runtime reads is real — the Workspace Catalog store, the
 * identity store, and the Person Profiles store — only the extraction is
 * deterministic and the clock is settable, so the journey can never depend on
 * a live model or on the real passage of thirty days.
 */
export function createMeetingDebriefTestRuntime(
  options: MeetingDebriefTestRuntimeOptions,
): MeetingDebriefTestRuntime {
  const catalogStore = new TranscriptCatalogStore(options.workspaceDir);
  /* Seeding only: the fixture writes go straight to durable state, while
     every read the host makes goes through options.identity. */
  const identityStore = new TranscriptIdentityStore(options.workspaceDir);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(options.workspaceDir),
    lifecycle: [],
  });
  let nowMs = Date.now();
  const host = new MeetingDebriefHost({
    runs: options.runs,
    catalog: {
      getTranscript: (transcriptId) => catalogStore.readTranscript(transcriptId),
    },
    identity: options.identity,
    extract: async ({ record, identity }) =>
      deterministicDebriefExtraction(record, { mentions: identity.mentions }),
    now: () => new Date(nowMs),
    profiles: workspaceProfileDirectory(people),
    ...(options.ownerEmail ? { ownerEmail: options.ownerEmail } : {}),
    ...(options.materializeActionItems
      ? { materializeActionItems: options.materializeActionItems }
      : {}),
    ...(options.log ? { log: options.log } : {}),
  });

  const seedProfile = (profile: SeedProfile): void => {
    const email = profile.email.trim().toLowerCase();
    /* Only Calendar may anchor a stable email shell (spec #117); the journey's
       seed stands in for that exact provenance, then corrects the name on. */
    const { profile: shell } = people.ensureCalendarAttendeeProfile({
      email,
      provenance: "meeting-debrief hermetic journey",
    });
    if (profile.fullName) {
      people.correct(shell.id, { fullName: profile.fullName });
    }
  };

  return {
    host,
    setNow(value: Date) {
      nowMs = value.getTime();
    },
    advance(ms: number) {
      nowMs += ms;
      return new Date(nowMs);
    },
    async seed(payload: MeetingDebriefSeedPayload): Promise<string> {
      const record = payload.transcript;
      for (const profile of payload.profiles ?? []) {
        seedProfile(profile);
      }
      if (payload.identity?.mentions) {
        identityStore.replaceMentions(record.id, payload.identity.mentions);
      }
      if (payload.identity?.organizations) {
        identityStore.replaceOrganizations(record.id, payload.identity.organizations);
      }
      if (payload.identity?.decisions) {
        for (const decision of payload.identity.decisions) {
          identityStore.appendDecision(decision);
        }
      }
      catalogStore.saveTranscript(record);
      await host.process(record);
      await host.idle();
      const summary = options.runs
        .list({ module: MEETING_DEBRIEF_MODULE_ID })
        .runs.find((entry) => {
          const meta = options.runs.open(entry.id)?.read();
          return meta?.externalId === record.id;
        });
      if (!summary) {
        throw new Error(`Meeting Debrief Run was not created for ${record.id}`);
      }
      return summary.id;
    },
  };
}

export function registerMeetingDebriefTestRoutes(
  app: FastifyInstance,
  runtime: MeetingDebriefTestRuntime,
): void {
  app.post("/api/test/meeting-debrief/seed", async (request, reply) => {
    const payload = request.body as MeetingDebriefSeedPayload;
    if (!payload.transcript.id) {
      reply.code(400).send({ error: "seed requires a transcript with an id" });
      return;
    }
    const runId = await runtime.seed(payload);
    return { runId };
  });
  app.post("/api/test/meeting-debrief/advance", async (request) => {
    const body = request.body as { ms?: number; now?: string };
    if (body.now) {
      runtime.setNow(new Date(body.now));
    } else if (typeof body.ms === "number") {
      runtime.advance(body.ms);
    }
    const recovered = await runtime.host.recover();
    await runtime.host.idle();
    return { recovered };
  });
}
