import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MeetingDebriefActionItem } from "@chief-of-staff-demo/shared";
import { openRuns } from "../../../apps/server/src/runs";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { buildDailyBriefingWork } from "../../../apps/server/src/tasks/briefing-projection";
import { buildDailyBriefing } from "../../../apps/server/src/modules/meeting-brief-generator/dailyBriefing";
import { renderDailyBriefingEmail } from "../../../apps/server/src/modules/meeting-brief-generator/output";

/**
 * The Daily Briefing reads canonical Tasks and materialized Action Items
 * (issue #192) rather than reconstructing a mixed action list from Run
 * receipts. The two identities stay separate all the way to the email.
 */
const NOW = new Date("2026-09-04T09:00:00.000Z");

function proposal(title: string, dueDate: string | null = null): MeetingDebriefActionItem {
  return {
    title,
    owner: null,
    ownerMentionId: null,
    ownerProfileId: null,
    dueDate,
  };
}

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-daily-work-"));
  const store = new TaskStore(workspaceDir);
  const tasks = new WorkspaceTasks({ store, now: () => NOW, timezone: () => "UTC" });
  const actionItems = new WorkspaceActionItems({ store, now: () => NOW });
  const meetings = new WorkspaceMeetings(workspaceDir, () => NOW);
  const runs = openRuns(workspaceDir);
  const briefing = () =>
    buildDailyBriefing(
      { meetings, runs, work: () => buildDailyBriefingWork({ tasks, actionItems }) },
      NOW,
      "UTC",
    );
  return { tasks, actionItems, meetings, briefing };
}

describe("the Daily Briefing's canonical work", () => {
  it("is built on a day with no Meetings at all, because work is still work", () => {
    const { tasks, briefing } = setup();
    expect(briefing()).toBeNull();

    tasks.create({ title: "Send the pricing note", dueDate: "2026-09-01" });

    const built = briefing();
    expect(built?.meetings).toEqual([]);
    expect(built?.summary).toContain("1 overdue");
    expect(built?.work.overdue.map((task) => task.title)).toEqual(["Send the pricing note"]);
  });

  it("separates overdue, due today and high priority without naming a Task twice", () => {
    const { tasks, briefing } = setup();
    tasks.create({ title: "Late", dueDate: "2026-09-01", priority: "high" });
    tasks.create({ title: "Today", dueDate: "2026-09-04", priority: "high" });
    tasks.create({ title: "Urgent, undated", priority: "high" });
    tasks.create({ title: "Quiet, undated" });

    const work = briefing()!.work;

    expect(work.overdue.map((task) => task.title)).toEqual(["Late"]);
    expect(work.dueToday.map((task) => task.title)).toEqual(["Today"]);
    expect(work.highPriority.map((task) => task.title)).toEqual(["Urgent, undated"]);
    expect(work.totals).toEqual({
      overdue: 1,
      dueToday: 1,
      highPriority: 1,
      pendingActionItems: 0,
    });
  });

  it("keeps a pending Action Item a proposal, and a promotion a Task", () => {
    const { tasks, actionItems, briefing } = setup();
    const [pending, promoted] = actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "t_1",
      meetingId: "meeting_1",
      actionItems: [proposal("Draft the summary", "2026-09-05"), proposal("Book the follow-up")],
    });
    const task = tasks.create({ title: "Book the follow-up", dueDate: "2026-09-04" });
    actionItems.recordPromotion(promoted.id, task.id);

    const work = briefing()!.work;

    expect(work.pendingActionItems).toEqual([
      {
        actionItemId: pending.id,
        title: "Draft the summary",
        dueDate: "2026-09-05",
        meetingId: "meeting_1",
      },
    ]);
    expect(work.dueToday.map((row) => row.taskId)).toEqual([task.id]);
  });

  it("carries both lists into the owner's email under their own headings", () => {
    const { tasks, actionItems, briefing } = setup();
    tasks.create({ title: "Send the pricing note", dueDate: "2026-09-01" });
    actionItems.materialize({
      debriefRunId: "run_1",
      transcriptId: "t_1",
      meetingId: null,
      actionItems: [proposal("Draft the summary")],
    });

    const email = renderDailyBriefingEmail(briefing()!);

    expect(email.text).toContain("Overdue Tasks:\n- Send the pricing note · due 2026-09-01");
    expect(email.text).toContain("Action Items awaiting review:\n- Draft the summary");
    expect(email.html).toContain("Action Items awaiting review");
    /* Nothing empty is drawn as a zero. */
    expect(email.text).not.toContain("High priority");
  });

  it("says how many rows a capped section did not draw", () => {
    const { tasks, briefing } = setup();
    for (let index = 0; index < 10; index += 1) {
      tasks.create({ title: `Late ${index}`, dueDate: "2026-09-01" });
    }

    const built = briefing()!;

    expect(built.work.overdue).toHaveLength(8);
    expect(built.work.totals.overdue).toBe(10);
    expect(renderDailyBriefingEmail(built).text).toContain("- and 2 more");
  });
});
