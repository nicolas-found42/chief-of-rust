import { describe, expect, it } from "vitest";
import type { Task } from "@chief-of-staff-demo/shared";
import { compareTasks, groupTasks, taskGroupOf } from "@chief-of-staff-demo/shared";

/**
 * How open Tasks are read (issue #175): four due-date groups in the Workspace
 * timezone, and one deterministic order. Pure over a calendar date, which is
 * exactly why a date-only Task near a UTC boundary can be tested at all.
 */
function task(fields: Partial<Task> & { id: string }): Task {
  return {
    title: fields.id,
    notes: "",
    status: "open",
    dueDate: null,
    priority: "none",
    listId: "inbox",
    responsiblePerson: { kind: "owner" },
    destination: { provider: "local" },
    source: null,
    externalLink: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    deletedAt: null,
    ...fields,
  };
}

describe("grouping open Tasks by due date", () => {
  it("puts each Task in Overdue, Today, Upcoming or No due date", () => {
    const today = "2026-09-04";
    expect(taskGroupOf(task({ id: "a", dueDate: "2026-09-03" }), today)).toBe("overdue");
    expect(taskGroupOf(task({ id: "b", dueDate: "2026-09-04" }), today)).toBe("today");
    expect(taskGroupOf(task({ id: "c", dueDate: "2026-09-05" }), today)).toBe("upcoming");
    expect(taskGroupOf(task({ id: "d", dueDate: null }), today)).toBe("no-due-date");
  });

  it("keeps a date-only Task in its local-date group across a UTC boundary", () => {
    /* 2026-09-04 in Auckland is still 2026-09-03 in UTC. A Task due that day
       is Today for the person whose day it is, and reading it in UTC would
       report it Overdue — which is the whole reason the Workspace timezone
       decides "today" rather than the surface. */
    const due = task({ id: "boundary", dueDate: "2026-09-04" });
    expect(taskGroupOf(due, "2026-09-04")).toBe("today");
    expect(taskGroupOf(due, "2026-09-03")).toBe("upcoming");
  });
});

describe("the default order", () => {
  it("sorts by due date, then priority, then oldest first", () => {
    const tasks = [
      task({ id: "no-date", dueDate: null, priority: "high" }),
      task({ id: "later", dueDate: "2026-09-06" }),
      task({ id: "low-today", dueDate: "2026-09-04", priority: "low" }),
      task({ id: "high-today", dueDate: "2026-09-04", priority: "high" }),
      task({
        id: "high-today-older",
        dueDate: "2026-09-04",
        priority: "high",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];

    expect([...tasks].sort(compareTasks).map((entry) => entry.id)).toEqual([
      "high-today-older",
      "high-today",
      "low-today",
      "later",
      "no-date",
    ]);
  });

  it("groups in that same order", () => {
    const groups = groupTasks(
      [
        task({ id: "overdue-low", dueDate: "2026-09-01", priority: "low" }),
        task({ id: "overdue-high", dueDate: "2026-09-01", priority: "high" }),
        task({ id: "someday" }),
      ],
      "2026-09-04",
    );

    expect(groups.overdue.map((entry) => entry.id)).toEqual(["overdue-high", "overdue-low"]);
    expect(groups.today).toEqual([]);
    expect(groups["no-due-date"].map((entry) => entry.id)).toEqual(["someday"]);
  });
});
