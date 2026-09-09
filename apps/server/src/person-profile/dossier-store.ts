import { createHash } from "node:crypto";
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
import {
  PersonDossierContentSchema,
  PersonDossierSchema,
  PersonDossierSectionSchema,
  PersonSourceDocumentSchema,
  type PersonClaim,
  type PersonDossier,
  type PersonDossierContent,
  type PersonSourceDocument,
} from "@chief-of-staff-demo/shared";

type PersonDossierSection = PersonDossierContent["sections"][number];

/**
 * Sections are derived accounts, never stored truth: they are rebuilt from the
 * claims on every publish, merge included, so a merged survivor reads the
 * merged record instead of waiting for the next research run.
 */
export function synthesizeSections(claims: PersonClaim[]): PersonDossierSection[] {
  return PersonDossierSectionSchema.options.map((key) => {
    const relevant = claims
      .filter(
        (claim) => claim.status !== "superseded" && (key === "overview" || claim.section === key),
      )
      .slice(0, key === "overview" ? 8 : 20);
    return {
      key,
      summary: [
        ...new Set(
          relevant.map(
            (claim) =>
              `${claim.status === "contested" ? "Contested account: " : claim.status === "claimed" ? "Claimed: " : claim.nature === "interpretation" ? "Interpretation: " : ""}${claim.statement}`,
          ),
        ),
      ]
        .join(" ")
        .slice(0, 8000),
      claimIds: relevant.map((claim) => claim.id),
      updatedAt: relevant.length ? new Date().toISOString() : null,
      state: relevant.length ? ("incomplete" as const) : ("unresearched" as const),
      gaps: relevant.length
        ? ["This account reflects the sources collected so far; further evidence may exist."]
        : ["No grounded evidence collected in this section yet."],
    };
  });
}

/** Source versions live separately so consumers and revisions never duplicate raw text. */
export class PersonDossierStore {
  constructor(private readonly root: string) {}

  retainSource(
    input: Omit<PersonSourceDocument, "schemaVersion" | "id" | "hash">,
  ): PersonSourceDocument {
    const hash = createHash("sha256").update(input.text).digest("hex");
    const familyPath = this.path("person-source-families", `${hash}_${input.visibility}`);
    const family = (this.read(familyPath) as { family: string } | null)?.family ?? input.family;
    if (!existsSync(familyPath)) this.write(familyPath, { family });
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          input.url,
          hash,
          input.visibility,
          input.sourceClass,
          family,
          input.attribution,
          input.extractionCoverage,
          input.capturedAt,
          input.sourceVersion,
          input.publishedAt,
          input.author,
          input.extractionRanges,
          input.title,
          input.rights,
          input.anchors,
          input.namedIndividuals,
          input.provenanceNote,
          input.outboundUrls,
          input.acquisition,
        ]),
      )
      .digest("hex");
    const source = PersonSourceDocumentSchema.parse({
      ...input,
      family,
      hash,
      id,
      schemaVersion: 1,
    });
    const path = this.path("person-source-documents", id);
    if (!existsSync(path)) this.write(path, source);
    return PersonSourceDocumentSchema.parse(this.read(path));
  }

  get(profileId: string): PersonDossier | null {
    const raw = this.read(this.path("person-dossiers", profileId));
    return raw === null ? null : PersonDossierSchema.parse(raw);
  }

  getRevision(profileId: string, revision: number): PersonDossier | null {
    const current = this.get(profileId);
    if (!current || !Number.isInteger(revision) || revision < 1 || revision > current.revision)
      return null;
    if (revision === current.revision) return current;
    const raw = this.read(this.revisionPath(profileId, revision));
    return raw === null ? null : PersonDossierSchema.parse(raw);
  }

  private revisionPath(profileId: string, revision: number): string {
    /* A revision lives in a directory named for the Profile, so the id has to
       clear the same identity check every flat record path does before it is
       joined — otherwise it could walk out of the Workspace root. */
    this.requireRecordIdentity(profileId);
    return join(this.root, "person-dossier-revisions", profileId, `${revision}.json`);
  }

  source(profileId: string, sourceId: string): PersonSourceDocument | null {
    const dossier = this.get(profileId);
    const attributed =
      !!dossier &&
      (dossier.sourceIds.includes(sourceId) ||
        dossier.claims.some((c) => c.citations.some((p) => p.sourceId === sourceId)));
    return attributed ? this.document(sourceId) : null;
  }

  publish(profileId: string, expectedRevision: number, input: PersonDossierContent): PersonDossier {
    if (existsSync(this.path("person-dossier-tombstones", profileId)))
      throw new Error("Profile was deleted");
    const content = PersonDossierContentSchema.parse(input);
    if ((this.get(profileId)?.revision ?? 0) !== expectedRevision)
      throw new Error("Dossier changed during research");
    content.sourceIds = [
      ...new Set([
        ...(content.sourceIds ?? []),
        ...content.claims.flatMap((c) => c.citations.map((p) => p.sourceId)),
      ]),
    ];
    if (content.sourceIds.some((id) => !this.document(id)))
      throw new Error("Dangling source reference");
    const claims = new Map(content.claims.map((c) => [c.id, c]));
    const works = new Map(content.works.map((w) => [w.id, w]));
    if (claims.size !== content.claims.length || works.size !== content.works.length)
      throw new Error("Duplicate record identity");
    const requireClaims = (ids: string[]) => {
      if (ids.some((id) => !claims.has(id))) throw new Error("Dangling claim reference");
    };
    const rejected = new Set(this.rejectedEntries(profileId));
    for (const id of content.sourceIds) {
      const source = this.document(id)!;
      if (rejected.has(source.url) || rejected.has(source.hash))
        throw new Error("Rejected attribution");
    }
    for (const claim of content.claims) {
      requireClaims([...claim.supports, ...claim.supersedes]);
      if (claim.status !== "unknown" && !claim.citations.length)
        throw new Error("Claim needs a source passage");
      for (const passage of claim.citations) {
        const source = this.document(passage.sourceId);
        if (source && (rejected.has(source.url) || rejected.has(source.hash)))
          throw new Error("Rejected attribution");
        if (!source || !source.text.includes(passage.quote))
          throw new Error("Invalid source passage");
      }
    }
    for (const work of content.works) {
      requireClaims(work.claimIds);
      for (const detail of [
        work.contribution,
        work.teamContribution,
        ...work.authority,
        ...work.scale,
        ...work.constraints,
        ...work.outcomes,
      ])
        if (detail) requireClaims(detail.claimIds);
    }
    for (const record of [...content.expertise, ...content.connections]) {
      requireClaims(record.claimIds);
      if (record.workIds.some((id) => !works.has(id))) throw new Error("Dangling work reference");
    }
    for (const expertise of content.expertise)
      if (expertise.support === "demonstrated" && !expertise.workIds.length)
        throw new Error("Demonstrated expertise requires work");
    for (const section of content.sections) requireClaims(section.claimIds);
    const prior = this.get(profileId);
    content.sections = content.sections.map((section) => {
      const old = prior?.sections.find((candidate) => candidate.key === section.key);
      if (
        old &&
        old.summary === section.summary &&
        JSON.stringify(old.claimIds) === JSON.stringify(section.claimIds) &&
        old.state === section.state
      )
        return { ...section, updatedAt: old.updatedAt };
      return section;
    });
    const dossier = PersonDossierSchema.parse({
      ...content,
      schemaVersion: 1,
      profileId,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    });
    const previous = this.get(profileId);
    if (previous && !existsSync(this.revisionPath(profileId, previous.revision)))
      this.write(this.revisionPath(profileId, previous.revision), previous);
    this.write(this.revisionPath(profileId, dossier.revision), dossier);
    this.write(this.path("person-dossiers", profileId), dossier);
    return dossier;
  }

  project(profileId: string, visibility: "public" | "private"): PersonDossier | null {
    const dossier = this.get(profileId);
    if (!dossier || visibility === "private") return dossier;
    return this.prune(dossier, (sourceId) => this.document(sourceId)?.visibility === "public");
  }

  removeTranscript(transcriptId: string): void {
    const directory = join(this.root, "person-dossiers");
    if (!existsSync(directory)) return;
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const profileId = file.slice(0, -5);
      const dossier = this.get(profileId)!;
      this.scrubHistory(
        profileId,
        (sourceId) => this.document(sourceId)?.transcriptId !== transcriptId,
      );
      const pruned = this.prune(
        dossier,
        (sourceId) => this.document(sourceId)?.transcriptId !== transcriptId,
      );
      if (JSON.stringify(pruned) !== JSON.stringify(dossier))
        this.publish(profileId, dossier.revision, pruned);
    }
    const documents = join(this.root, "person-source-documents");
    if (existsSync(documents))
      for (const file of readdirSync(documents)) {
        if (!file.endsWith(".json")) continue;
        const source = PersonSourceDocumentSchema.parse(this.read(join(documents, file)));
        if (source.transcriptId === transcriptId) {
          rmSync(join(documents, file), { force: true });
          rmSync(this.path("person-source-families", `${source.hash}_private`), { force: true });
        }
      }
  }

  private scrubHistory(profileId: string, keep: (sourceId: string) => boolean): void {
    const directory = join(this.root, "person-dossier-revisions", profileId);
    if (!existsSync(directory)) return;
    for (const file of readdirSync(directory)) {
      if (!/^\d+\.json$/.test(file)) continue;
      const path = join(directory, file);
      const old = PersonDossierSchema.parse(this.read(path));
      this.write(path, this.prune(old, keep));
    }
  }

  private prune(dossier: PersonDossier, keep: (id: string) => boolean): PersonDossier {
    const removed = new Set(
      dossier.claims
        .filter((c) => c.citations.length > 0 && c.citations.every((p) => !keep(p.sourceId)))
        .map((c) => c.id),
    );
    for (let changed = true; changed;) {
      changed = false;
      for (const claim of dossier.claims)
        if (!removed.has(claim.id) && claim.supports.some((id) => removed.has(id))) {
          removed.add(claim.id);
          changed = true;
        }
    }
    const valid = (ids: string[]) => ids.every((id) => !removed.has(id));
    const claims = dossier.claims
      .filter((c) => !removed.has(c.id))
      .map((c) => ({
        ...c,
        citations: c.citations.filter((p) => keep(p.sourceId)),
        supersedes: c.supersedes.filter((id) => !removed.has(id)),
      }));
    const works = dossier.works
      .filter((w) => valid(w.claimIds))
      .map((w) => ({
        ...w,
        contribution: w.contribution && valid(w.contribution.claimIds) ? w.contribution : null,
        teamContribution:
          w.teamContribution && valid(w.teamContribution.claimIds) ? w.teamContribution : null,
        authority: w.authority.filter((v) => valid(v.claimIds)),
        scale: w.scale.filter((v) => valid(v.claimIds)),
        constraints: w.constraints.filter((v) => valid(v.claimIds)),
        outcomes: w.outcomes.filter((v) => valid(v.claimIds)),
      }));
    const workIds = new Set(works.map((w) => w.id));
    return {
      ...dossier,
      sourceIds: dossier.sourceIds.filter(keep),
      claims,
      works,
      expertise: dossier.expertise.filter(
        (e) => valid(e.claimIds) && e.workIds.every((id) => workIds.has(id)),
      ),
      connections: dossier.connections.filter(
        (c) => valid(c.claimIds) && c.workIds.every((id) => workIds.has(id)),
      ),
      sections: dossier.sections.map((s) =>
        valid(s.claimIds)
          ? s
          : {
              ...s,
              summary: "",
              claimIds: [],
              state: "incomplete",
              gaps: ["Supporting evidence was removed or is outside this view."],
            },
      ),
    };
  }

  /** URL and content-hash strings the owner rejected for this Profile. */
  rejectedEntries(profileId: string): string[] {
    return (this.read(this.path("person-dossier-rejections", profileId)) ?? []) as string[];
  }

  detach(profileId: string, sourceId: string): void {
    const source = this.source(profileId, sourceId);
    const dossier = this.get(profileId);
    if (!source || !dossier) throw new Error("Source not attributed to this Profile");
    const path = this.path("person-dossier-rejections", profileId);
    this.write(path, [...new Set([...this.rejectedEntries(profileId), source.url, source.hash])]);
    /* Identical text is the same wrong-person content at another URL: the
       rejection covers the content hash, so mirrors cannot survive the detach
       and the publish guard below never trips on the store's own pruning. */
    const keep = (id: string) => {
      const document = this.document(id);
      return !!document && document.url !== source.url && document.hash !== source.hash;
    };
    this.publish(profileId, dossier.revision, this.prune(dossier, keep));
    this.scrubHistory(profileId, keep);
  }

  merge(survivorId: string, duplicateId: string): void {
    if (survivorId === duplicateId) throw new Error("Cannot merge a dossier into itself");
    const duplicate = this.get(duplicateId);
    if (!duplicate) return;
    const survivor = this.get(survivorId);
    const unique = <T extends { id: string }>(items: T[]) => [
      ...new Map(items.map((item) => [item.id, item])).values(),
    ];
    const claims = unique([...duplicate.claims, ...(survivor?.claims ?? [])]);
    this.publish(survivorId, survivor?.revision ?? 0, {
      sourceIds: [...new Set([...duplicate.sourceIds, ...(survivor?.sourceIds ?? [])])],
      claims,
      works: unique([...duplicate.works, ...(survivor?.works ?? [])]),
      connections: unique([...duplicate.connections, ...(survivor?.connections ?? [])]),
      expertise: [
        ...new Map(
          [...duplicate.expertise, ...(survivor?.expertise ?? [])].map((entry) => [
            JSON.stringify(entry),
            entry,
          ]),
        ).values(),
      ],
      sections: synthesizeSections(claims),
    });
    this.privacyDelete(duplicateId);
  }

  privacyDelete(profileId: string): string[] {
    const sourceIds = [...new Set(this.get(profileId)?.sourceIds ?? [])];
    this.write(this.path("person-dossier-tombstones", profileId), { profileId });
    rmSync(this.path("person-dossiers", profileId), { force: true });
    rmSync(this.path("person-dossier-rejections", profileId), { force: true });
    rmSync(join(this.root, "person-dossier-revisions", profileId), {
      recursive: true,
      force: true,
    });
    return sourceIds;
  }

  private document(id: string): PersonSourceDocument | null {
    const raw = this.read(this.path("person-source-documents", id));
    return raw === null ? null : PersonSourceDocumentSchema.parse(raw);
  }
  private path(folder: string, id: string): string {
    this.requireRecordIdentity(id);
    return join(this.root, folder, `${id}.json`);
  }
  private requireRecordIdentity(id: string): void {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid record identity");
  }
  private read(path: string): unknown {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }
  private write(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`);
    renameSync(`${path}.tmp`, path);
  }
}
