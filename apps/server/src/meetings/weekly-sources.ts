import { createHash } from "node:crypto";
import type {
  MeetingBriefRunResult,
  MeetingDebriefRunResult,
  WeeklyWorkspaceView,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID, MEETING_DEBRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "./store.js";
import type { Runs } from "../runs.js";

/** Meeting Wizard owns artifact selection and the finite projection sent to Weekly generation.
 * Coverage is filled for every deterministic meeting; model evidence is capped at forty.
 */
export function weeklyMeetingSources(deps: {
  meetings: Pick<WorkspaceMeetings, "get">;
  runs: Runs;
  meetingIdForTranscript?: (transcriptId: string) => string | null;
}): (view: WeeklyWorkspaceView) => object[] {
  return (view) => {
    const sources: object[] = [];
    for (const meeting of view.meetings) {
      const sourceMeeting = deps.meetings.get(meeting.id)!;
      const completed = meeting.group === "completed";
      const module = completed ? MEETING_DEBRIEF_MODULE_ID : MEETING_BRIEF_MODULE_ID;
      for (const summary of deps.runs.list({ module }).runs) {
        const run = deps.runs.open(summary.id);
        if (!run) continue;
        const raw = run.readArtifact("result.json");
        let result: (MeetingBriefRunResult & MeetingDebriefRunResult) | null = null;
        try {
          result = raw
            ? (JSON.parse(raw) as MeetingBriefRunResult & MeetingDebriefRunResult)
            : null;
        } catch {
          /* missing artifact */
        }
        const matches = completed
          ? result && deps.meetingIdForTranscript?.(result.transcriptId) === meeting.id
          : run.read().externalId === sourceMeeting.occurrenceKey;
        if (!matches) continue;
        if (run.read().status !== "done" || !(completed ? result?.debrief : result?.meetingBrief)) {
          if (meeting.artifactStatus === "missing")
            meeting.artifactStatus = run.read().status === "failed" ? "failed" : "pending";
          continue;
        }
        meeting.artifactStatus = "ready";
        meeting.sourceId = run.id;
        const common = {
          meetingId: meeting.id,
          title: meeting.title.slice(0, 300),
          date: meeting.startAt,
          group: meeting.group,
          sourceId: run.id,
          sourceRevision: createHash("sha256")
            .update(raw ?? "")
            .digest("hex"),
        };
        if (completed && result?.debrief) {
          const debrief = result.debrief;
          sources.push({
            ...common,
            summary: debrief.summary.slice(0, 1200),
            decisions: debrief.decisions.slice(0, 8).map(({ statement, evidence }) => ({
              statement: statement.slice(0, 500),
              evidence: evidence?.slice(0, 500) ?? null,
            })),
            actionItems: debrief.actionItems.slice(0, 8).map(({ title, owner, dueDate }) => ({
              title: title.slice(0, 500),
              owner: owner?.slice(0, 200) ?? null,
              dueDate,
            })),
            openQuestions: debrief.openQuestions.slice(0, 8).map(({ question, raisedBy }) => ({
              question: question.slice(0, 500),
              raisedBy: raisedBy?.slice(0, 200) ?? null,
            })),
          });
        } else if (result?.meetingBrief) {
          const brief = result.meetingBrief;
          sources.push({
            ...common,
            summary: brief.summary.slice(0, 1200),
            topics: boundedLines(brief.conversationStarters),
            preparation: boundedLines(
              ((brief.guests as typeof brief.guests | undefined) ?? [])
                .slice(0, 8)
                .flatMap((guest) =>
                  ((guest.talkingPoints as string[] | undefined) ?? []).slice(0, 8),
                ),
            ),
            uncertainties: boundedLines(brief.uncertainty),
          });
        }
        break;
      }
    }
    return sources.slice(0, 40);
  };
}

/** Finite selection from already composed Brief/Debrief fields, never raw evidence. */
function boundedLines(lines: string[]): string[] {
  return lines.slice(0, 8).map((line) => line.slice(0, 500));
}
