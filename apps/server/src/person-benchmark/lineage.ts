import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BenchmarkReportSchema, type BenchmarkReport } from "@chief-of-staff-demo/shared";

export interface SavedBenchmarkReport {
  path: string;
  hash: string;
  report: BenchmarkReport;
}
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

export function safeReportPath(root: string, path: string, allowMissing = false): string {
  const directory = resolve(root);
  const resolved = resolve(path);
  const inside = relative(directory, resolved);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside))
    throw new Error("Benchmark report lineage escapes its declared root.");
  if (
    !/^(fixed-documents|live-discovery)-(incumbent|expanded)(-reassessed)?-[a-f0-9]{16}\.json$/.test(
      basename(resolved),
    )
  )
    throw new Error("Lineage parents must use canonical benchmark report filenames.");
  let component = directory;
  if (lstatSync(component).isSymbolicLink())
    throw new Error("Benchmark lineage root must not be a symlink.");
  for (const part of inside.split(sep)) {
    component = resolve(component, part);
    try {
      if (lstatSync(component).isSymbolicLink())
        throw new Error("Benchmark report lineage contains a forbidden symlink.");
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolved;
}

export function readBenchmarkReport(path: string): SavedBenchmarkReport {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES)
    throw new Error("Invalid or oversized benchmark report file.");
  const bytes = readFileSync(path);
  try {
    return {
      path: resolve(path),
      hash: createHash("sha256").update(bytes).digest("hex"),
      report: BenchmarkReportSchema.parse(JSON.parse(bytes.toString("utf8"))),
    };
  } catch {
    throw new Error("Invalid benchmark report; expected a bounded structured benchmark result.");
  }
}

/** Verified oldest-first ancestry; no directories or arbitrary parent payloads are searched. */
export function reportLineage(
  input: SavedBenchmarkReport,
  declaredRoot?: string,
): { root: string; reports: SavedBenchmarkReport[] } {
  const root = resolve(
    declaredRoot ?? input.report.reassessment?.lineage?.root ?? dirname(input.path),
  );
  if (
    input.report.reassessment?.lineage &&
    resolve(input.report.reassessment.lineage.root) !== root
  )
    throw new Error("Reassessment must preserve the declared lineage root.");
  safeReportPath(root, input.path);
  const reports = [input];
  const seen = new Set([input.path]);
  let current = input;
  while (current.report.reassessment?.lineage) {
    if (reports.length >= 32) throw new Error("Benchmark report lineage exceeds 32 reports.");
    const link = current.report.reassessment.lineage;
    if (
      resolve(link.root) !== root ||
      isAbsolute(link.parent) ||
      link.parent.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid benchmark report parent location.");
    const parentPath = safeReportPath(root, resolve(root, link.parent));
    if (seen.has(parentPath)) throw new Error("Benchmark report lineage contains a cycle.");
    seen.add(parentPath);
    const parent = readBenchmarkReport(parentPath);
    if (
      parent.hash !== link.parentHash ||
      parent.hash !== current.report.reassessment.originalReportHash ||
      parent.report.runId !== current.report.reassessment.originalRunId
    )
      throw new Error("Benchmark parent report hash or identity does not match its attestation.");
    reports.push(parent);
    current = parent;
  }
  return { root, reports: reports.reverse() };
}
