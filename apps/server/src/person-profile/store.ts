import { identifier } from "./resolver.js";
import { parsePersonIdentifier } from "./identifier.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  PersonIdentitySignals,
  PersonProfile,
  PersonProfileDeletionReceipt,
  PersonProfileTombstone,
} from "@chief-of-staff-demo/shared";

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedHandle(value: string): string {
  return normalized(value).replace(/^@/, "");
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function intersects(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

export class PersonProfileStore {
  private readonly profilesDir: string;
  private readonly tombstonesDir: string;
  private readonly receiptsDir: string;

  constructor(workspaceDir: string) {
    this.profilesDir = join(workspaceDir, "person-profiles");
    this.tombstonesDir = join(workspaceDir, "person-profile-tombstones");
    this.receiptsDir = join(workspaceDir, "person-profile-deletion-receipts");
  }

  get(id: string): PersonProfile | null {
    return this.read(join(this.profilesDir, id, "current.json"));
  }

  getRevision(id: string, revision: number): PersonProfile | null {
    const persisted = this.read(join(this.profilesDir, id, "revisions", `${revision}.json`));
    if (persisted) return persisted;
    /* Profiles written before revisioned persistence kept only current.json:
       its revision is still exactly retrievable. */
    const current = this.read(join(this.profilesDir, id, "current.json"));
    return current && current.revision === revision ? current : null;
  }

  list(): PersonProfile[] {
    if (!existsSync(this.profilesDir)) return [];
    return readdirSync(this.profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.get(entry.name))
      .filter((profile): profile is PersonProfile => profile !== null);
  }

  /** Every persisted revision of one Profile, oldest first. Empty when unknown. */
  listRevisions(id: string): PersonProfile[] {
    const revisionsDir = join(this.profilesDir, id, "revisions");
    if (!existsSync(revisionsDir)) {
      const current = this.read(join(this.profilesDir, id, "current.json"));
      return current ? [current] : [];
    }
    return readdirSync(revisionsDir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((left, right) => left - right)
      .map((revision) => this.read(join(revisionsDir, `${revision}.json`)))
      .filter((profile): profile is PersonProfile => profile !== null);
  }

  findBySignals(signals: PersonIdentitySignals): PersonProfile | null {
    const emails = signals.emails.map(normalized).filter(Boolean);
    const urls = signals.profileUrls.map(normalizedUrl).filter((value): value is string => !!value);
    const handles = new Map(
      Object.entries(signals.handles).map(([platform, values]) => [
        normalized(platform),
        values.map(normalizedHandle).filter(Boolean),
      ]),
    );
    return (
      this.list().find((profile) => {
        if (intersects(profile.emails.map(normalized), emails)) return true;
        if (
          intersects(
            profile.profileUrls
              .map(normalizedUrl)
              .filter((value): value is string => value !== null),
            urls,
          )
        )
          return true;
        for (const [platform, values] of handles) {
          const stored = profile.handles[platform]?.map(normalizedHandle) ?? [];
          if (intersects(stored, values)) return true;
        }
        return false;
      }) ?? null
    );
  }

  save(profile: PersonProfile): void {
    if (this.getTombstone(profile.id)) throw new Error("Cannot recreate a privacy-deleted Profile");
    const root = join(this.profilesDir, profile.id);
    const revisions = join(root, "revisions");
    mkdirSync(revisions, { recursive: true });
    const content = `${JSON.stringify(profile, null, 2)}\n`;
    this.writeAtomic(join(revisions, `${profile.revision}.json`), content);
    this.writeAtomic(join(root, "current.json"), content);
  }

  /**
   * Lifecycle state belongs to the current resource, not to its immutable
   * factual revisions. Archive/restore therefore replaces only current.json;
   * exact revision reads keep returning the facts recorded at that revision.
   */
  saveCurrent(profile: PersonProfile): void {
    const root = join(this.profilesDir, profile.id);
    mkdirSync(root, { recursive: true });
    this.writeAtomic(join(root, "current.json"), `${JSON.stringify(profile, null, 2)}\n`);
  }

  /**
   * Rewrite one immutable revision in place. Only a deletion cascade needs
   * this (issue #128): transcript-origin evidence must not survive inside
   * revision copies, while every other fact of the revision stays exactly
   * as recorded.
   */
  replaceRevision(profile: PersonProfile): void {
    const revisions = join(this.profilesDir, profile.id, "revisions");
    mkdirSync(revisions, { recursive: true });
    this.writeAtomic(
      join(revisions, `${profile.revision}.json`),
      `${JSON.stringify(profile, null, 2)}\n`,
    );
  }

  /**
   * Removes the exact canonical record and every immutable factual revision,
   * then writes only a content-free referential tombstone. Source documents
   * live outside this store and are deliberately untouched.
   */
  privacyDelete(
    profile: PersonProfile,
    deletedAt: string,
  ): {
    canonicalProfileRecords: number;
    revisions: number;
    evidence: number;
    tombstone: PersonProfileTombstone;
  } {
    const revisions = this.listRevisions(profile.id);
    const evidenceIds = new Set(
      revisions
        .flatMap((revision) => [
          ...revision.publications,
          ...revision.mentions,
          ...revision.evidence,
        ])
        .map((item) => item.id),
    );
    rmSync(join(this.profilesDir, profile.id), { recursive: true, force: true });
    const tombstone: PersonProfileTombstone = { profileId: profile.id, deletedAt };
    mkdirSync(this.tombstonesDir, { recursive: true });
    this.writeAtomic(
      join(this.tombstonesDir, `${profile.id}.json`),
      `${JSON.stringify(tombstone, null, 2)}\n`,
    );
    for (const value of [...profile.emails, ...profile.profileUrls]) {
      const signals = parsePersonIdentifier(value);
      const keys = [identifier(signals), identifier({ ...signals, handles: {} })];
      for (const key of keys)
        this.writeAtomic(join(this.tombstonesDir, `${key}.json`), `${JSON.stringify(tombstone)}\n`);
    }
    return {
      canonicalProfileRecords: 1,
      revisions: revisions.length,
      evidence: evidenceIds.size,
      tombstone,
    };
  }

  getTombstone(profileId: string): PersonProfileTombstone | null {
    return this.readJson<PersonProfileTombstone>(join(this.tombstonesDir, `${profileId}.json`));
  }

  saveDeletionReceipt(receipt: PersonProfileDeletionReceipt): void {
    mkdirSync(this.receiptsDir, { recursive: true });
    this.writeAtomic(
      join(this.receiptsDir, `${receipt.profileId}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }

  getDeletionReceipt(profileId: string): PersonProfileDeletionReceipt | null {
    return this.readJson<PersonProfileDeletionReceipt>(join(this.receiptsDir, `${profileId}.json`));
  }

  private read(path: string): PersonProfile | null {
    return this.readJson<PersonProfile>(path);
  }

  private readJson<T>(path: string): T | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}
