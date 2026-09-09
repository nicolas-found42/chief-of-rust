import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface WorkspaceLayout {
  root: string;
  runsDir: string;
  configFile: string;
  stateFile: string;
  mockResultFile: string;
  intakeScheduleFile: string;
  runDir(runId: string): string;
}

export function workspaceLayout(root: string): WorkspaceLayout {
  const runsDir = join(root, "runs");
  return {
    root,
    runsDir,
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    mockResultFile: join(root, "mock-result.json"),
    intakeScheduleFile: join(root, "intake-schedules.json"),
    runDir: (runId: string) => join(runsDir, runId),
  };
}

/** `run_<UTC yyyymmdd>-<hhmmss>_<8 hex>` */
export function newRunId(now: Date = new Date()): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `run_${date}-${time}_${randomBytes(4).toString("hex")}`;
}

const RUN_ID_PATTERN = /^run_\d{8}-\d{6}_[0-9a-f]{8}$/;

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
