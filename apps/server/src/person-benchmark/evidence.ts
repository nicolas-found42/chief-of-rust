import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  PersonSourceDocumentSchema,
  TRANSCRIPT_EVIDENCE_SOURCE,
} from "@chief-of-staff-demo/shared";

const ENTRIES = [
  "person-profiles",
  "person-dossiers",
  "person-dossier-revisions",
  "person-source-documents",
  "person-source-families",
  "person-research.json",
  "snapshot-manifest.json",
];
const MAX_BYTES = 512 * 1024 * 1024;

/** One allowlist controls copying, public validation and exact byte attestation. */
function evidenceFiles(root: string): string[] {
  if (lstatSync(root).isSymbolicLink())
    throw new Error("Evidence workspace must not be a symlink.");
  const files: string[] = [];
  let bytes = 0;
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Evidence contains a forbidden symlink.");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
          throw new Error("Invalid evidence record path.");
        visit(`${relative}/${name}`);
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 32 * 1024 * 1024 || bytes > MAX_BYTES || files.length >= 100000)
        throw new Error("Evidence bundle exceeds the bounded snapshot size.");
      files.push(relative);
    } else throw new Error("Evidence must contain only regular files and directories.");
  };
  for (const entry of ENTRIES) {
    // lstat must inspect dangling links too; existsSync alone follows links.
    try {
      lstatSync(join(root, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    visit(entry);
  }
  return files.sort();
}

function validatePublic(root: string, files: string[]): void {
  for (const relative of files) {
    if (
      !relative.startsWith("person-source-documents/") &&
      !relative.startsWith("person-profiles/")
    )
      continue;
    try {
      const value: unknown = JSON.parse(readFileSync(join(root, relative), "utf8"));
      if (relative.startsWith("person-source-documents/")) {
        const source = PersonSourceDocumentSchema.parse(value);
        if (
          source.visibility !== "public" ||
          source.transcriptId ||
          source.sourceClass === "workspace" ||
          source.sourceClass === "manual"
        )
          throw new Error("private");
        if (source.hash !== createHash("sha256").update(source.text).digest("hex"))
          throw new Error("hash");
      } else if (
        typeof value !== "object" ||
        value === null ||
        !("evidence" in value) ||
        !Array.isArray(value.evidence) ||
        value.evidence.some(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "source" in entry &&
            entry.source === TRANSCRIPT_EVIDENCE_SOURCE,
        )
      )
        throw new Error("private profile");
    } catch {
      throw new Error(`Invalid or nonpublic evidence record: ${relative.slice(0, 200)}`);
    }
  }
}

function evidenceBundleHash(root: string): string {
  const files = evidenceFiles(root);
  validatePublic(root, files);
  const hash = createHash("sha256");
  for (const relative of files) {
    const bytes = readFileSync(join(root, relative));
    hash.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
}

/** Copy first, then verify both hashes; a changing source snapshot is refused. */
export function copyEvidence(source: string, destination: string): string {
  const before = evidenceBundleHash(source);
  for (const relative of evidenceFiles(source)) {
    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, relative), target);
  }
  const copied = evidenceBundleHash(destination);
  if (before !== copied || evidenceBundleHash(source) !== copied)
    throw new Error("Evidence changed while copying the snapshot.");
  return copied;
}

export function retainEvidence(
  source: string,
  destination: string,
  operationIds: string[],
): string {
  mkdirSync(destination);
  copyEvidence(source, destination);
  writeFileSync(
    join(destination, "snapshot-manifest.json"),
    JSON.stringify(
      {
        sourceWorkspace: source,
        completedOperationIds: operationIds,
        note: "Isolated public benchmark evidence; no provider configuration copied. Listed operations finished, including bounded or interrupted outcomes.",
      },
      null,
      2,
    ),
  );
  return evidenceBundleHash(destination);
}
