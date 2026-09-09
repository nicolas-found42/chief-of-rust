import {
  PersonDossierQuerySchema,
  type PersonDossierQuery,
  type PersonDossierQueryResult,
  type PersonDossierMatch,
  type PersonDossierAnalysis,
  type PersonConnectionStep,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "./profiles.js";
import type { PersonDossierStore } from "./dossier-store.js";

function canonical(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return (
    (
      {
        "machine learning": "machine learning",
        ml: "machine learning",
        "regulatory compliance": "regulation",
        "regulatory engineering": "regulation",
        "production deployment": "deployment",
      } as Record<string, string>
    )[normalized] ?? normalized
  );
}

/** Answers are rebuilt from current, purpose-filtered records on every read. */
export class PersonDossierQueries {
  constructor(
    private readonly deps: { people: WorkspacePersonProfiles; dossiers: PersonDossierStore },
  ) {}
  connectionPath(
    fromId: string,
    toId: string,
    visibility: "public" | "private",
  ): PersonConnectionStep[] {
    const profiles = this.deps.people.search().filter((profile) => !profile.mergedInto);
    const active = new Set(profiles.map((profile) => profile.id));
    if (!active.has(fromId) || !active.has(toId) || fromId === toId) return [];
    const edges: PersonConnectionStep[] = [];
    for (const profile of profiles) {
      const dossier = this.deps.dossiers.project(profile.id, visibility);
      if (!dossier) continue;
      for (const connection of dossier.connections) {
        const matches = connection.counterpartyUrl
          ? profiles.filter((person) => person.profileUrls.includes(connection.counterpartyUrl!))
          : [];
        const target = connection.profileId ?? (matches.length === 1 ? matches[0]!.id : null);
        if (!target || !active.has(target)) continue;
        const claims = connection.claimIds.map((id) => dossier.claims.find((c) => c.id === id));
        if (claims.some((c) => !c || c.status !== "supported" || c.matchConfidence !== "high"))
          continue;
        edges.push({
          fromProfileId: profile.id,
          toProfileId: target,
          kind: connection.kind,
          direction: connection.direction,
          from: connection.from,
          to: connection.to,
          workIds: connection.workIds,
          claimIds: connection.claimIds,
          citations: claims.flatMap((c) => c?.citations ?? []),
        });
      }
    }
    const pending: { id: string; path: PersonConnectionStep[] }[] = [{ id: fromId, path: [] }];
    const visited = new Set([fromId]);
    for (let cursor = 0; cursor < pending.length && cursor < 1000; cursor += 1) {
      const current = pending[cursor]!;
      if (current.path.length >= 4) continue;
      for (const edge of edges) {
        const next =
          edge.fromProfileId === current.id
            ? edge.toProfileId
            : edge.toProfileId === current.id
              ? edge.fromProfileId
              : null;
        if (!next || visited.has(next)) continue;
        const path = [...current.path, edge];
        if (next === toId) return path;
        visited.add(next);
        pending.push({ id: next, path });
      }
    }
    return [];
  }

  analyse(profileId: string, visibility: "public" | "private"): PersonDossierAnalysis | null {
    const profile = this.deps.people.get(profileId);
    if (!profile || profile.archivedAt || profile.mergedInto) return null;
    const dossier = this.deps.dossiers.project(profileId, visibility);
    if (!dossier) return null;
    const validClaims = new Set(
      dossier.claims
        .filter((c) => c.status === "supported" && c.matchConfidence === "high")
        .map((c) => c.id),
    );
    const workIdentity = (id: string) => {
      const work = dossier.works.find((w) => w.id === id);
      if (!work) return id;
      if (work.url) {
        try {
          const url = new URL(work.url);
          url.hash = "";
          return `${work.kind}:${url.toString()}`;
        } catch {
          /* No valid canonical URL was documented. */
        }
      }
      return `${work.kind}:${canonical(work.title)}:${work.startedAt ?? "unknown"}`;
    };
    const activity = new Map<string, { period: string; kind: string; count: number }>();
    const seen = new Set<string>();
    for (const work of dossier.works) {
      if (
        !work.startedAt ||
        !/^\d{4}-\d{2}/.test(work.startedAt) ||
        !work.claimIds.every((id) => validClaims.has(id))
      )
        continue;
      const identity = workIdentity(work.id);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const period = work.startedAt.slice(0, 7);
      const key = `${period}:${work.kind}`;
      const entry = activity.get(key) ?? { period, kind: work.kind, count: 0 };
      entry.count += 1;
      activity.set(key, entry);
    }
    const collaborations = new Map<
      string,
      { counterparty: string; works: Map<string, string>; claims: Set<string> }
    >();
    for (const connection of dossier.connections) {
      if (
        !["co-authored", "co-founded", "collaborated"].includes(connection.kind) ||
        !connection.claimIds.every((id) => validClaims.has(id))
      )
        continue;
      const key = connection.profileId ?? connection.counterpartyUrl ?? connection.id;
      const entry = collaborations.get(key) ?? {
        counterparty: connection.counterparty,
        works: new Map<string, string>(),
        claims: new Set<string>(),
      };
      for (const workId of connection.workIds) entry.works.set(workIdentity(workId), workId);
      for (const claimId of connection.claimIds) entry.claims.add(claimId);
      collaborations.set(key, entry);
    }
    const composition: Record<string, number> = {};
    const byClaim = dossier.claims.map((claim) => {
      const sources = claim.citations
        .map((p) => this.deps.dossiers.source(profileId, p.sourceId))
        .filter((s) => s !== null);
      const sourceClasses = [...new Set(sources.map((s) => s.sourceClass))];
      for (const sourceClass of sourceClasses)
        composition[sourceClass] = (composition[sourceClass] ?? 0) + 1;
      return {
        claimId: claim.id,
        families: [...new Set(sources.map((s) => s.family))],
        sourceClasses,
      };
    });
    return {
      activity: [...activity.values()].sort((a, b) => a.period.localeCompare(b.period)),
      collaborations: [...collaborations.values()].map((entry) => ({
        counterparty: entry.counterparty,
        distinctWorks: entry.works.size,
        workIds: [...entry.works.values()],
        claimIds: [...entry.claims],
      })),
      quality: {
        totalClaims: dossier.claims.length,
        singleSourceClaims: byClaim.filter((c) => c.families.length === 1).length,
        unknownClaims: dossier.claims.filter((c) => c.status === "unknown").length,
        contestedClaims: dossier.claims.filter((c) => c.status === "contested").length,
        composition,
        byClaim,
      },
      scope:
        "Observed dated artifacts only; missing private work and collection gaps prevent interpreting activity as total productivity. Repeated collaboration does not establish access or willingness to help. Exact copies share a source family; rewritten syndication may remain undetected.",
    };
  }

  search(input: PersonDossierQuery): PersonDossierQueryResult {
    const query = PersonDossierQuerySchema.parse(input);
    const profiles = this.deps.people.search().filter((p) => !p.mergedInto);
    const demonstrated: PersonDossierMatch[] = [];
    const claimed: PersonDossierMatch[] = [];
    let researchedProfiles = 0;
    for (const profile of profiles) {
      const dossier = this.deps.dossiers.project(profile.id, query.visibility);
      if (!dossier || !dossier.claims.length) continue;
      researchedProfiles += 1;
      const usable = new Set(
        dossier.claims
          .filter(
            (c) => ["supported", "claimed"].includes(c.status) && c.matchConfidence === "high",
          )
          .map((c) => c.id),
      );
      const supported = new Set(
        dossier.claims
          .filter((c) => c.status === "supported" && c.matchConfidence === "high")
          .map((c) => c.id),
      );
      const works = dossier.works.filter(
        (work) =>
          work.claimIds.every((id) => usable.has(id)) &&
          query.constraints.every((constraint) =>
            work.constraints.some(
              (c) =>
                c.text.toLowerCase().includes(constraint.toLowerCase()) &&
                c.claimIds.every((id) => supported.has(id)),
            ),
          ) &&
          (!query.scale ||
            work.scale.some(
              (scale) =>
                canonical(scale.unit) === canonical(query.scale!.unit) &&
                scale.value >= query.scale!.minimum &&
                scale.claimIds.every((id) => supported.has(id)),
            )) &&
          (!query.from || (!!work.startedAt && work.startedAt >= query.from)) &&
          (!query.to || (!!work.startedAt && work.startedAt <= query.to)),
      );
      if ((query.scale || query.constraints.length || query.from || query.to) && !works.length)
        continue;
      const workIds = new Set(works.map((w) => w.id));
      const expertise = dossier.expertise.filter(
        (e) =>
          e.claimIds.every((id) => usable.has(id)) &&
          (!e.workIds.length || e.workIds.some((id) => workIds.has(id))),
      );
      const categories = query.categories.map(canonical);
      if (
        !categories.every((category) => expertise.some((e) => canonical(e.category) === category))
      )
        continue;
      const matchedClaims = dossier.claims.filter(
        (c) =>
          usable.has(c.id) &&
          (!query.query || c.statement.toLowerCase().includes(query.query.toLowerCase())),
      );
      const matchingWorks = works.filter(
        (w) =>
          !query.query ||
          [w.title, w.contribution?.text ?? "", ...w.constraints.map((c) => c.text)]
            .join(" ")
            .toLowerCase()
            .includes(query.query.toLowerCase()),
      );
      if (query.query && !matchedClaims.length && !matchingWorks.length) continue;
      /* Team output is not the person's contribution (#204 row 1 and row 3):
         demonstrated expertise needs a matching work whose individual
         contribution is itself documented and supported. */
      const documentedContribution = (workId: string) => {
        const work = works.find((w) => w.id === workId);
        return !!work?.contribution && work.contribution.claimIds.every((id) => supported.has(id));
      };
      const demonstratedExpertise = expertise.filter(
        (e) =>
          e.support === "demonstrated" &&
          e.claimIds.every((id) => supported.has(id)) &&
          e.workIds.some(documentedContribution),
      );
      const isDemonstrated = categories.length
        ? categories.every((category) =>
            demonstratedExpertise.some((e) => canonical(e.category) === category),
          )
        : matchingWorks.some(
            (w) => w.contribution && w.contribution.claimIds.every((id) => supported.has(id)),
          );
      const relevantExpertise = expertise.filter(
        (e) => !categories.length || categories.includes(canonical(e.category)),
      );
      const ids = new Set([
        ...relevantExpertise.flatMap((e) => e.claimIds),
        ...matchingWorks.flatMap((w) => [
          ...w.claimIds,
          ...(w.contribution?.claimIds ?? []),
          ...w.scale.flatMap((s) => s.claimIds),
          ...w.constraints.flatMap((c) => c.claimIds),
        ]),
        ...matchedClaims.map((c) => c.id),
      ]);
      const claims = dossier.claims.filter((c) => ids.has(c.id));
      const match: PersonDossierMatch = {
        profileId: profile.id,
        name:
          profile.fullName ??
          (query.visibility === "private" ? profile.primaryEmail : null) ??
          "Unnamed Profile",
        dossierRevision: dossier.revision,
        workIds: matchingWorks.map((w) => w.id),
        claimIds: claims.map((c) => c.id),
        citations: [
          ...new Map(
            claims.flatMap((c) => c.citations).map((p) => [JSON.stringify(p), p]),
          ).values(),
        ],
        gaps: [
          ...(matchingWorks.some((w) => !w.contribution)
            ? ["Individual contribution is undocumented for some work."]
            : []),
          ...(matchingWorks.some((w) => !w.scale.length)
            ? ["Operating scale is unmeasured for some work."]
            : []),
        ],
      };
      (isDemonstrated ? demonstrated : claimed).push(match);
    }
    return {
      demonstrated,
      claimed,
      coverage: {
        activeProfiles: profiles.length,
        researchedProfiles,
        demonstrated: demonstrated.length,
        claimedOnly: claimed.length,
      },
      scope:
        "Observed active Workspace Profiles only. Unresearched people and missing private work prevent claims of global rarity, productivity, availability or access.",
    };
  }
}
