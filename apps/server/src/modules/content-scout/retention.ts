import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type {
  ContentScoutCleanupPreview,
  ContentScoutCleanupReceipt,
  ContentScoutStorageUse,
} from "@chief-of-staff-demo/shared";
import {
  sanitizeDiagnosticBody,
  sanitizeDiagnosticContentType,
} from "../../source-adapters/diagnostics.js";

interface TemporaryRecord {
  id: string;
  createdAt: string;
  category: "sanitized_diagnostics" | "temporary_media";
  contentType: string;
  body: string;
  outcome?: "failed";
}

const THIRTY_DAYS_MS = 30 * 86_400_000;
const TWENTY_FOUR_HOURS_MS = 86_400_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function walkFiles(root: string, skip: Set<string> = new Set()): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || skip.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function usage(files: string[]): { files: number; bytes: number } {
  return {
    files: files.length,
    bytes: files.reduce((total, path) => total + statSync(path).size, 0),
  };
}

/** Retention and deletion policy behind one allowlisted Content Scout interface. */
export class ContentScoutRetention {
  private readonly workspaceRoot: string;
  private readonly root: string;
  private readonly diagnosticsDir: string;
  private readonly mediaDir: string;
  private readonly transcriptsDir: string;
  private readonly receiptsFile: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date,
  ) {
    this.workspaceRoot = resolve(workspaceDir);
    this.root = join(this.workspaceRoot, "content-scout");
    this.diagnosticsDir = join(this.root, "temporary", "sanitized-diagnostics");
    this.mediaDir = join(this.root, "temporary", "media");
    this.transcriptsDir = join(this.root, "evidence-transcripts");
    this.receiptsFile = join(this.root, "cleanup-receipts.jsonl");
  }

  recordSanitizedDiagnostic(input: { id: string; contentType: string; body: string }): void {
    this.writeTemporary(this.diagnosticsDir, {
      id: input.id,
      createdAt: this.now().toISOString(),
      category: "sanitized_diagnostics",
      contentType: sanitizeDiagnosticContentType(input.contentType) ?? "application/octet-stream",
      body: sanitizeDiagnosticBody(input.body),
    });
  }

  recordTemporaryMedia(input: { id: string; outcome: "processed" | "failed"; bytes: string }): {
    retained: boolean;
  } {
    const path = this.recordPath(this.mediaDir, input.id);
    if (input.outcome === "processed") {
      if (existsSync(path)) unlinkSync(path);
      return { retained: false };
    }
    this.writeTemporary(this.mediaDir, {
      id: input.id,
      createdAt: this.now().toISOString(),
      category: "temporary_media",
      contentType: "application/octet-stream;base64",
      body: Buffer.from(input.bytes).toString("base64"),
      outcome: "failed",
    });
    return { retained: true };
  }

  retainEvidenceTranscript(input: { id: string; text: string }): void {
    const path = this.recordPath(this.transcriptsDir, input.id, ".txt");
    if (existsSync(path)) return;
    mkdirSync(this.transcriptsDir, { recursive: true });
    writeFileSync(path, input.text, "utf8");
  }

  storageUse(): ContentScoutStorageUse {
    const contentScoutRuns = this.contentScoutRunFiles();
    const durableRootFiles = walkFiles(this.root, new Set(["temporary", "evidence-transcripts"]));
    return {
      measuredAt: this.now().toISOString(),
      categories: {
        durableRecords: usage([...durableRootFiles, ...contentScoutRuns]),
        sanitizedDiagnostics: usage(walkFiles(this.diagnosticsDir)),
        temporaryMedia: usage(walkFiles(this.mediaDir)),
        retainedEvidenceTranscripts: usage(walkFiles(this.transcriptsDir)),
      },
    };
  }

  preview(): ContentScoutCleanupPreview {
    const now = this.now().getTime();
    const items: ContentScoutCleanupPreview["items"] = [];
    for (const path of walkFiles(this.diagnosticsDir)) {
      const record = this.readTemporary(path, "sanitized_diagnostics");
      if (record && Date.parse(record.createdAt) <= now - THIRTY_DAYS_MS) {
        items.push({
          id: record.id,
          category: record.category,
          relativePath: relative(this.workspaceRoot, path),
          bytes: statSync(path).size,
          reason: "older_than_30_days",
        });
      }
    }
    for (const path of walkFiles(this.mediaDir)) {
      const record = this.readTemporary(path, "temporary_media");
      if (
        record?.outcome === "failed" &&
        Date.parse(record.createdAt) <= now - TWENTY_FOUR_HOURS_MS
      ) {
        items.push({
          id: record.id,
          category: record.category,
          relativePath: relative(this.workspaceRoot, path),
          bytes: statSync(path).size,
          reason: "failed_media_older_than_24_hours",
        });
      }
    }
    items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      scope: "expired_temporary_data",
      measuredAt: this.now().toISOString(),
      items,
      files: items.length,
      bytes: items.reduce((total, item) => total + item.bytes, 0),
    };
  }

  enforce(): ContentScoutCleanupReceipt | null {
    return this.preview().files > 0 ? this.cleanup(false) : null;
  }

  cleanup(dryRun = false): ContentScoutCleanupReceipt {
    const preview = this.preview();
    let deleted = 0;
    if (!dryRun) {
      for (const item of preview.items) {
        const allowed =
          item.category === "sanitized_diagnostics" ? this.diagnosticsDir : this.mediaDir;
        const path = this.insideWorkspace(item.relativePath);
        const allowedRelative = relative(allowed, path);
        if (
          allowedRelative.startsWith(`..${sep}`) ||
          allowedRelative === ".." ||
          basename(path) !== `${item.id}.json`
        ) {
          throw new Error("Cleanup target escaped its scoped Content Scout directory.");
        }
        if (existsSync(path)) {
          unlinkSync(path);
          deleted += 1;
        }
      }
    }
    const executedAt = this.now().toISOString();
    const receipt: ContentScoutCleanupReceipt = {
      ...preview,
      id: `cleanup-${createHash("sha256")
        .update(
          `${executedAt}|${dryRun}|${preview.items.map((item) => item.relativePath).join("|")}`,
        )
        .digest("hex")
        .slice(0, 16)}`,
      executedAt,
      dryRun,
      deleted,
    };
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.receiptsFile, `${JSON.stringify(receipt)}\n`, "utf8");
    return receipt;
  }

  private writeTemporary(directory: string, record: TemporaryRecord): void {
    const path = this.recordPath(directory, record.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private recordPath(directory: string, id: string, extension = ".json"): string {
    if (!SAFE_ID.test(id)) throw new Error("Temporary data requires a safe identifier.");
    const path = resolve(directory, `${id}${extension}`);
    const scoped = relative(directory, path);
    if (scoped.startsWith(`..${sep}`) || scoped === ".." || resolve(path) === this.workspaceRoot) {
      throw new Error("Temporary data path escaped the Workspace.");
    }
    return path;
  }

  private insideWorkspace(relativePath: string): string {
    const path = resolve(this.workspaceRoot, relativePath);
    const scoped = relative(this.workspaceRoot, path);
    if (scoped === "" || scoped === ".." || scoped.startsWith(`..${sep}`)) {
      throw new Error("Cleanup target must be a file inside the Workspace.");
    }
    return path;
  }

  private readTemporary(
    path: string,
    category: TemporaryRecord["category"],
  ): TemporaryRecord | null {
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as TemporaryRecord;
      return record.category === category && SAFE_ID.test(record.id) ? record : null;
    } catch {
      return null;
    }
  }

  private contentScoutRunFiles(): string[] {
    const runsDir = join(this.workspaceRoot, "runs");
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
      const runDir = join(runsDir, entry.name);
      try {
        const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as {
          module?: string;
        };
        return meta.module === "content-scout" ? walkFiles(runDir) : [];
      } catch {
        return [];
      }
    });
  }
}
