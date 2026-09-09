import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DIRECTORIES, WHOLE_FILES } from "../../../apps/server/src/migration/workspace";
import {
  executeGeneratedDataClear,
  previewGeneratedData,
} from "../../../apps/server/src/clear-data/workspace";

/**
 * The repeatable generated-data clear's local half. Its boundary is the
 * migration's own classification tables (ADR-0046), so every fixture seeds the
 * whole table plus the files the tables do not name: config.json, relay.json,
 * and the migration's bookkeeping — the clear must delete exactly the tables
 * and hold everything else byte-for-byte. Every fixture is a throwaway
 * temporary Workspace — never the repository's own.
 */

const PHRASE = "CLEAR ALL DATA";

/** A credential-shaped value, to prove the preview never discloses content. */
const SECRET = "sk-secret-value-1";

function seedWorkspace(label: string): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), `cos-clear-data-${label}-`));
  for (const directory of Object.keys(DIRECTORIES)) {
    mkdirSync(join(workspaceDir, directory, "nested"), { recursive: true });
    writeFileSync(join(workspaceDir, directory, "nested", "record.json"), "{}");
  }
  for (const file of Object.keys(WHOLE_FILES)) {
    writeFileSync(join(workspaceDir, file), "{}");
  }
  writeFileSync(join(workspaceDir, "config.json"), JSON.stringify({ apiKey: SECRET }));
  writeFileSync(join(workspaceDir, "relay.json"), JSON.stringify({ secret: SECRET }));
  mkdirSync(join(workspaceDir, "migration"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "migration", "completed.json"),
    JSON.stringify({ migratedAt: "2026-09-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(workspaceDir, "migration", "receipt.json"),
    JSON.stringify({ categories: { directories: 3 } }),
  );
  return workspaceDir;
}

/** Everything a fixture Workspace holds, so a result can be proved to change none of it. */
function snapshot(workspaceDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(workspaceDir, "");
  return files;
}

describe("previewGeneratedData", () => {
  it("lists every table entry the Workspace holds, with counts, and nothing the tables do not name", () => {
    const workspaceDir = seedWorkspace("preview-full");
    const preview = previewGeneratedData(workspaceDir);

    const names = preview.entries.map((entry) => entry.name).sort();
    expect(names).toEqual([...Object.keys(DIRECTORIES), ...Object.keys(WHOLE_FILES)].sort());
    for (const entry of preview.entries) {
      if (entry.kind === "directory") expect(entry.fileCount).toBe(1);
      else expect(entry.fileCount).toBeNull();
    }
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });

  it("reports an empty Workspace as no entries", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-clear-data-empty-"));
    expect(previewGeneratedData(workspaceDir).entries).toEqual([]);
  });
});

describe("executeGeneratedDataClear", () => {
  let workspaceDir = "";
  let preserved: Record<string, string>;

  beforeEach(() => {
    workspaceDir = seedWorkspace("execute");
    preserved = {
      "config.json": readFileSync(join(workspaceDir, "config.json"), "utf8"),
      "relay.json": readFileSync(join(workspaceDir, "relay.json"), "utf8"),
      "migration/completed.json": readFileSync(
        join(workspaceDir, "migration", "completed.json"),
        "utf8",
      ),
      "migration/receipt.json": readFileSync(
        join(workspaceDir, "migration", "receipt.json"),
        "utf8",
      ),
    };
  });

  it("refuses a mismatched phrase and changes nothing, byte for byte", () => {
    const before = snapshot(workspaceDir);
    const result = executeGeneratedDataClear(workspaceDir, { typedConfirmation: "clear all data" });

    expect(result.outcome).toBe("confirmation-mismatch");
    expect(snapshot(workspaceDir)).toEqual(before);
  });

  it("deletes exactly the tables' entries and holds everything else byte-for-byte", () => {
    const result = executeGeneratedDataClear(workspaceDir, { typedConfirmation: PHRASE });

    if (result.outcome !== "cleared") throw new Error("the clear should have completed");
    for (const directory of Object.keys(DIRECTORIES)) {
      expect(existsSync(join(workspaceDir, directory)), directory).toBe(false);
    }
    for (const file of Object.keys(WHOLE_FILES)) {
      expect(existsSync(join(workspaceDir, file)), file).toBe(false);
    }
    for (const [name, content] of Object.entries(preserved)) {
      expect(readFileSync(join(workspaceDir, name), "utf8"), name).toBe(content);
    }
    expect(result.receipt.local.directories.map((entry) => entry.name).sort()).toEqual(
      Object.keys(DIRECTORIES).sort(),
    );
    for (const entry of result.receipt.local.directories) {
      expect(entry.files).toBe(1);
    }
    expect(result.receipt.local.files.sort()).toEqual(Object.keys(WHOLE_FILES).sort());
    expect(result.receipt.schemaVersion).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("tolerates a partially cleared Workspace and is repeatable", () => {
    executeGeneratedDataClear(workspaceDir, { typedConfirmation: PHRASE });
    const second = executeGeneratedDataClear(workspaceDir, { typedConfirmation: PHRASE });

    if (second.outcome !== "cleared") throw new Error("the second clear should have completed");
    expect(second.receipt.local.directories).toEqual([]);
    expect(second.receipt.local.files).toEqual([]);
  });
});
