import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLEAR_GENERATED_DATA_CONFIRMATION } from "@chief-of-staff-demo/shared";
import { DIRECTORIES, WHOLE_FILES } from "../migration/workspace.js";

/**
 * The repeatable generated-data clear: one destructive action that empties the
 * Workspace of everything the products generated — Runs, Person Profiles,
 * processed Transcripts, Brand Profiles, Content Projects, Content Research —
 * and of the checkpoints that track what was already ingested or scheduled.
 *
 * The boundary is the one ADR-0046 already drew and this repo maintains: the
 * migration's own classification tables. A directory or whole file named there
 * is deleted whole; anything else — config.json, relay.json, the migration's
 * own bookkeeping — is configuration or credentials this action never reads.
 * Sharing the tables is the point: the one audited line between generated
 * data and everything else cannot drift between the one-time cutover and this
 * repeatable action.
 *
 * Unlike the migration, nothing here touches a provider: the Sheets half of
 * the clear lives in the API route, which holds the Google connection. And
 * there is no completion marker — the action is repeatable by definition.
 */

/** One inventoried Workspace entry this action deletes, with its record count. */
interface GeneratedDataEntry {
  name: string;
  kind: "directory" | "file";
  /** Files inside a directory; a whole file is one record, so null. */
  fileCount: number | null;
}

export interface GeneratedDataInventory {
  entries: GeneratedDataEntry[];
}

/** The content-free record of one clear: names and counts, never stored values. */
export interface GeneratedDataClearReceipt {
  schemaVersion: 1;
  clearedAt: string;
  durationMs: number;
  local: {
    directories: { name: string; files: number }[];
    files: string[];
  };
}

export type GeneratedDataClearResult =
  { outcome: "confirmation-mismatch" } | { outcome: "cleared"; receipt: GeneratedDataClearReceipt };

function countFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}

/** What the Workspace currently holds that the clear would delete, names and counts only. */
export function previewGeneratedData(workspaceDir: string): GeneratedDataInventory {
  const entries: GeneratedDataEntry[] = [];
  if (!existsSync(workspaceDir)) return { entries };
  for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.hasOwn(DIRECTORIES, entry.name)) {
      entries.push({
        name: entry.name,
        kind: "directory",
        fileCount: countFiles(join(workspaceDir, entry.name)),
      });
    } else if (entry.isFile() && Object.hasOwn(WHOLE_FILES, entry.name)) {
      entries.push({ name: entry.name, kind: "file", fileCount: null });
    }
  }
  return { entries };
}

/**
 * The local half of the clear. The confirmation is checked before anything is
 * read or written — a mismatched phrase changes nothing, byte for byte.
 */
export function executeGeneratedDataClear(
  workspaceDir: string,
  input: { typedConfirmation: string },
): GeneratedDataClearResult {
  if (input.typedConfirmation !== CLEAR_GENERATED_DATA_CONFIRMATION) {
    return { outcome: "confirmation-mismatch" };
  }
  if (!existsSync(workspaceDir)) throw new Error("the Workspace directory to clear does not exist");

  const startedAt = Date.now();
  const directories: { name: string; files: number }[] = [];
  const files: string[] = [];

  for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
    if (entry.isDirectory() && Object.hasOwn(DIRECTORIES, entry.name)) {
      const name = entry.name;
      const removed = countFiles(join(workspaceDir, name));
      rmSync(join(workspaceDir, name), { recursive: true, force: true });
      directories.push({ name, files: removed });
    } else if (entry.isFile() && Object.hasOwn(WHOLE_FILES, entry.name)) {
      rmSync(join(workspaceDir, entry.name), { force: true });
      files.push(entry.name);
    }
  }

  return {
    outcome: "cleared",
    receipt: {
      schemaVersion: 1,
      clearedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      local: { directories, files },
    },
  };
}
