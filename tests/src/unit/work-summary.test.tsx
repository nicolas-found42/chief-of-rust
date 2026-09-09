// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskOverview } from "@chief-of-staff-demo/shared";
import { MetricStrip, WorkGroups } from "../../../apps/web/src/components/WorkSummary";

/**
 * The compact work surfaces (issue #192) and the Day Spine metric strip
 * (issue #193), rendered against fixtures rather than a server.
 *
 * The reason this exists: every compact row links to the canonical product
 * surface that owns the record it names, and the pending Action Item rows'
 * `#action-item-<id>` anchor was missing outright until `153eb8a`. A link to
 * an anchor nothing renders looks exactly like a working one, which is how it
 * survived — so the href is asserted here and the anchor it points at is
 * asserted in the browser journey.
 */
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function overview(partial: Partial<TaskOverview> = {}): TaskOverview {
  return fromPartial<TaskOverview>({
    today: "2026-09-05",
    counts: {
      open: 2,
      overdue: 1,
      dueToday: 0,
      pendingActionItems: 1,
      failedLinks: 0,
      conflictedLinks: 0,
    },
    tasks: [
      { id: "task_1", title: "Send the pricing sheet", dueDate: "2026-09-04", priority: "high" },
    ],
    actionItems: [
      { id: "ai_1", proposal: { title: "Draft the rollout note", dueDate: "2026-09-08" } },
    ],
    ...partial,
  });
}

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(createElement(MemoryRouter, null, element));
  });
  return container;
}

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted?.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

/** Every link's href, in render order — what a compact row is *for*. */
function hrefs(container: HTMLDivElement): string[] {
  return [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href") ?? "");
}

describe("the compact work surfaces", () => {
  it("links every Task row and every Action Item row to its own canonical anchor", async () => {
    const container = await mount(createElement(WorkGroups, { overview: overview() }));

    expect(hrefs(container)).toContain("/tasks#task-task_1");
    expect(hrefs(container)).toContain("/tasks#action-item-ai_1");
    expect(container.textContent).toContain("Send the pricing sheet");
    expect(container.textContent).toContain("Draft the rollout note");
  });

  it("keeps accepted work and proposals in two headed groups, never one queue", async () => {
    const container = await mount(createElement(WorkGroups, { overview: overview() }));

    /* Two sections, in this order: a Task is accepted work and an Action Item
       is a proposal awaiting a decision (issue #193). */
    const headings = [...container.querySelectorAll("h3")].map((heading) =>
      heading.textContent.trim(),
    );
    expect(headings).toEqual(["Tasks (2)", "Action Items awaiting review (1)"]);
    expect(container.querySelectorAll("section.work-group")).toHaveLength(2);
  });

  it("shows the total and a View all link only once a group exceeds the compact cap", async () => {
    const container = await mount(
      createElement(WorkGroups, {
        overview: overview({
          counts: {
            open: 31,
            overdue: 0,
            dueToday: 0,
            pendingActionItems: 1,
            failedLinks: 0,
            conflictedLinks: 0,
          },
          tasks: fromPartial(
            Array.from({ length: 8 }, (_, index) => ({
              id: `task_${index}`,
              title: `Task ${index}`,
              dueDate: null,
              priority: "none" as const,
            })),
          ),
        }),
      }),
    );

    expect(container.textContent).toContain("View all 31");
    /* Eight rows, whatever the total says. */
    expect(hrefs(container).filter((href) => href.startsWith("/tasks#task-"))).toHaveLength(8);
  });

  it("says nothing is waiting rather than showing an empty list", async () => {
    const container = await mount(
      createElement(WorkGroups, {
        overview: overview({
          counts: {
            open: 0,
            overdue: 0,
            dueToday: 0,
            pendingActionItems: 0,
            failedLinks: 0,
            conflictedLinks: 0,
          },
          tasks: [],
          actionItems: [],
        }),
      }),
    );

    expect(container.textContent).toContain("No open Tasks.");
    expect(container.textContent).toContain("Nothing is waiting on a decision.");
    expect(container.textContent).not.toContain("View all");
  });
});

describe("the Day Spine metric strip (issue #193)", () => {
  it("renders each figure with its label and the surface that owns it", async () => {
    const container = await mount(
      createElement(MetricStrip, {
        metrics: [
          { label: "Today", value: 3, to: "/meetings" },
          { label: "This week", value: 9, to: "/meetings/weekly" },
          { label: "Pending", value: 1, to: "/tasks#action-items" },
          { label: "Open", value: 2, to: "/tasks" },
          { label: "Overdue", value: 1, to: "/tasks" },
        ],
      }),
    );

    const metrics = [...container.querySelectorAll("li.work-metric")].map((metric) => [
      metric.querySelector(".work-metric-label")?.textContent,
      metric.querySelector(".work-metric-value")?.textContent,
    ]);
    expect(metrics).toEqual([
      ["Today", "3"],
      ["This week", "9"],
      ["Pending", "1"],
      ["Open", "2"],
      ["Overdue", "1"],
    ]);
    /* Navigation as well as a read-out: every figure is a link to the surface
       that owns it. */
    expect(hrefs(container)).toEqual([
      "/meetings",
      "/meetings/weekly",
      "/tasks#action-items",
      "/tasks",
      "/tasks",
    ]);
  });
});
