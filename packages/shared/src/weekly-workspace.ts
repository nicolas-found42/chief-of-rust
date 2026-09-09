import type { Task } from "./task.js";
import type { ActionItem } from "./action-item.js";

export interface WeeklyMeeting {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  group: "completed" | "in-progress" | "upcoming";
  artifactStatus: "ready" | "pending" | "failed" | "missing";
  sourceId: string | null;
}

export interface WeeklyWorkspaceView {
  weekStart: string;
  weekEnd: string;
  today: string;
  meetings: WeeklyMeeting[];
  overdue: Task[];
  dueThisWeek: Task[];
  pending: ActionItem[];
  summary: WeeklySummaryState;
}

export interface WeeklySummaryState {
  text: string | null;
  state: "empty" | "ready" | "stale" | "failed" | "consent-required";
  error: string | null;
  generatedAt: string | null;
  provider: string;
  model: string;
}
