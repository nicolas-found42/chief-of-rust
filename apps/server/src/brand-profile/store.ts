import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BrandProfileRevision,
  BrandProfileRevisionSummary,
  BrandProfileSourceScan,
} from "@chief-of-staff-demo/shared";

type BrandProfileMetadata = BrandProfileRevisionSummary;

/**
 * Workspace-owned access to Brand Profile revisions — the resource Content
 * Engine presents under the label Brand Voice. Any consumer reads the current
 * revision here rather than through the Content Scout feature store. The paths
 * are the existing persistence contract: the same `content-scout/state.json`
 * metadata list and `content-scout/brand-profiles/<id>.md` bodies, unchanged.
 *
 * Until the clean-slate cutover retires Content Scout's state file, this store
 * and `ContentScoutStore` are two writers of that one file, through the same
 * `state.json.tmp` staging path. That is safe only because every filesystem
 * call in both is synchronous and neither holds state in memory: each mutation
 * reads, changes and writes without yielding, so no read-modify-write can
 * interleave with the other store's. Give either store an in-memory cache and
 * the other's writes are lost silently — which is why this one re-reads the
 * file on every call and spreads the keys it does not own back out untouched.
 */
export class WorkspaceBrandProfileStore {
  private readonly root: string;
  private readonly profilesDir: string;
  private readonly stateFile: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = join(workspaceDir, "content-scout");
    this.profilesDir = join(this.root, "brand-profiles");
    this.stateFile = join(this.root, "state.json");
  }

  accept(input: {
    markdown: string;
    sourceScan: BrandProfileSourceScan;
    note?: string | null;
    siteBaselineMarkdown?: string;
  }): BrandProfileRevision {
    const state = this.readState();
    const previous = this.current();
    const id = identifier("brand", this.now());
    const markdown = `${input.markdown.trimEnd()}\n`;
    const revision: BrandProfileRevision = {
      id,
      createdAt: this.now().toISOString(),
      markdown,
      sourceScan: input.sourceScan,
      note: input.note ?? null,
      changedSections: changedSections(previous?.markdown ?? "", markdown),
      siteBaselineMarkdown:
        input.siteBaselineMarkdown ?? previous?.siteBaselineMarkdown ?? markdown,
    };
    mkdirSync(this.profilesDir, { recursive: true });
    this.writeAtomic(join(this.profilesDir, `${id}.md`), markdown);
    state.brandProfiles.push({
      id: revision.id,
      createdAt: revision.createdAt,
      sourceScan: revision.sourceScan,
      note: revision.note,
      changedSections: revision.changedSections,
      siteBaselineMarkdown: revision.siteBaselineMarkdown!,
    });
    this.writeState(state);
    return revision;
  }

  current(): BrandProfileRevision | null {
    const metadata = this.readState().brandProfiles.at(-1);
    return metadata ? this.readRevision(metadata) : null;
  }

  get(id: string): BrandProfileRevision | null {
    const metadata = this.readState().brandProfiles.find((revision) => revision.id === id);
    return metadata ? this.readRevision(metadata) : null;
  }

  /** Newest last, matching the append-only state file; callers reverse for display. */
  list(): BrandProfileMetadata[] {
    return this.readState().brandProfiles;
  }

  private readRevision(metadata: BrandProfileMetadata): BrandProfileRevision | null {
    const path = join(this.profilesDir, `${metadata.id}.md`);
    return existsSync(path) ? { ...metadata, markdown: readFileSync(path, "utf8") } : null;
  }

  private readState(): { brandProfiles: BrandProfileMetadata[]; [key: string]: unknown } {
    if (!existsSync(this.stateFile)) return { brandProfiles: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, unknown>;
      return {
        ...parsed,
        brandProfiles: Array.isArray(parsed.brandProfiles)
          ? (parsed.brandProfiles as BrandProfileMetadata[])
          : [],
      };
    } catch {
      return { brandProfiles: [] };
    }
  }

  private writeState(state: {
    brandProfiles: BrandProfileMetadata[];
    [key: string]: unknown;
  }): void {
    this.writeAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  private writeAtomic(path: string, text: string): void {
    mkdirSync(this.root, { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, path);
  }
}

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

function sections(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index]!;
    const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    result.set(match[1]!.trim(), markdown.slice(start, end).trim());
  }
  return result;
}

function changedSections(previous: string, next: string): string[] {
  const before = sections(previous);
  const after = sections(next);
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (section) => before.get(section) !== after.get(section),
  );
}
