import type { CompleteJson } from "../../llm/providers.js";
import type { Runs } from "../../runs.js";
import { TranscriptCatalogStore } from "../../transcript-catalog/store.js";
import type { TranscriptIdentityService } from "../../transcript-catalog/identity.js";
import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";
import { MeetingDebriefHost, type MeetingDebriefHostDeps } from "./host.js";
import { workspaceProfileDirectory } from "./profiles.js";
import { googleDebriefOutputs } from "./googleOutputs.js";
import type { GoogleConnection } from "../../google/connection.js";

export interface MeetingDebriefProductionRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  getCompleteJson: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo: () => { provider: string; model: string };
  /** The Workspace Person Profiles interface the review binds identities through. */
  people: WorkspacePersonProfiles;
  /**
   * The Workspace's one identity service, which answers `reviewFor` directly.
   * This runtime used to assemble that answer from three filtered store reads
   * — the same three the hermetic runtime assembled, line for line.
   */
  identity: TranscriptIdentityService;
  /** The confirmed owner identity's email, as the Shell holds it (ADR-0036). */
  ownerEmail: () => string | null;
  /** What the Workspace calls the Meeting a Transcript belongs to. */
  meetingTitle?: (meetingId: string) => string | null;
  /**
   * The Workspace's Google connection, backing terminal approval's outward
   * writes (issue #141). Absent, approval still completes and the Module has
   * no way to reach Gmail or Tasks at all.
   */
  google?: GoogleConnection;
  /** The Tasks list owner Tasks are filed under. */
  tasklistName?: () => string;
  /**
   * Where a successful extraction's proposed commitments become durable
   * Workspace Action Items (issue #177). The Debrief produces them; the Tasks
   * product owns them.
   */
  materializeActionItems?: MeetingDebriefHostDeps["materializeActionItems"];
  /**
   * Staleness hand-off to the Brief side (issue #162): fired after a review
   * action-item mutation persists. The shell wires it to notifyActionItemsChanged.
   */
  log?: (message: string) => void;
}

export interface MeetingDebriefProductionRuntime {
  host: MeetingDebriefHost;
}

/**
 * Production composition root for the Meeting Debrief (issues #139/#140).
 * Every consumer reads the one Workspace directory the Transcript Catalog
 * owns: the immutable Transcript records and the identity-mining review
 * state. There is no Drive access and no conversion here — the Catalog is the
 * sole source. The review's Profile surface is the Workspace's Person
 * Profiles interface at the narrow directory seam; the owner identity is the
 * Shell's confirmed reference, read live on every gate decision.
 */
export function createMeetingDebriefProductionRuntime(
  options: MeetingDebriefProductionRuntimeOptions,
): MeetingDebriefProductionRuntime {
  const catalogStore = new TranscriptCatalogStore(options.workspaceDir);
  const host = new MeetingDebriefHost({
    runs: options.runs,
    catalog: {
      getTranscript: (transcriptId) => catalogStore.readTranscript(transcriptId),
    },
    identity: options.identity,
    profiles: workspaceProfileDirectory(options.people),
    ownerEmail: options.ownerEmail,
    ...(options.meetingTitle ? { meetingTitle: options.meetingTitle } : {}),
    getCompleteJson: options.getCompleteJson,
    getLlmInfo: options.getLlmInfo,
    ...(options.google
      ? {
          outputs: googleDebriefOutputs(options.google),
        }
      : {}),
    ...(options.materializeActionItems
      ? { materializeActionItems: options.materializeActionItems }
      : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  return { host };
}
