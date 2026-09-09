import {
  BenchmarkSourceContributionSchema,
  type BenchmarkJudgement,
  type BenchmarkSourceContribution,
  type PersonDossier,
  type PersonSourceDocument,
} from "@chief-of-staff-demo/shared";

/** Trace evaluated recovery through actual retained citations after both assessments. */
export function sourceContributions(
  dossier: PersonDossier | null,
  sources: PersonSourceDocument[],
  judgements: BenchmarkJudgement[],
  rejectedClaimIds: Set<string>,
): BenchmarkSourceContribution[] {
  const family = (source: PersonSourceDocument): BenchmarkSourceContribution["family"] => {
    const parsed = BenchmarkSourceContributionSchema.shape.family.safeParse(source.evidenceFamily);
    return parsed.success ? parsed.data : "unclassified";
  };
  const byId = new Map(sources.map((source) => [source.id, source]));
  const contributions = new Map<
    BenchmarkSourceContribution["family"],
    BenchmarkSourceContribution
  >();
  for (const source of sources) {
    const key = family(source);
    const contribution: BenchmarkSourceContribution = contributions.get(key) ?? {
      family: key,
      sources: [],
      claimIds: [],
      recoveredFactIds: [],
      exclusiveRecoveredFactIds: [],
    };
    contribution.sources.push({
      id: source.id,
      url: source.url,
      hash: source.hash,
      upstreamIndex: source.upstreamIndex ?? null,
      cited: false,
      /* A retained source document holds a version or holds none — the field
         is `string | undefined` there, with no third state — so absent at this
         layer already means the route stated no version, and null is how a
         freshly written report says so. Absent in a *report* means something
         else entirely: that the report predates the field. Keeping this `??
         null` is what preserves that difference; passing `undefined` through
         would make a new report indistinguishable from a pre-#252 one. */
      sourceVersion: source.sourceVersion ?? null,
    });
    contributions.set(key, contribution);
  }
  for (const claim of dossier?.claims ?? []) {
    const cited = claim.citations.flatMap((citation) => {
      const source = byId.get(citation.sourceId);
      return source ? [source] : [];
    });
    const families = new Set(cited.map(family));
    const supported =
      (claim.status === "supported" || claim.status === "claimed") &&
      !rejectedClaimIds.has(claim.id) &&
      claim.citations.length > 0 &&
      claim.citations.every((citation) => {
        const source = byId.get(citation.sourceId);
        return (
          source?.visibility === "public" &&
          citation.quote.length > 0 &&
          source.text.includes(citation.quote)
        );
      });
    const recovered = supported
      ? judgements
          .filter(
            (judgement) =>
              judgement.claimId === claim.id &&
              judgement.verdict === "recovered" &&
              !judgement.reviewRequired,
          )
          .map((judgement) => judgement.factId)
      : [];
    for (const key of families) {
      const contribution = contributions.get(key)!;
      contribution.claimIds.push(claim.id);
      for (const source of contribution.sources)
        if (claim.citations.some((citation) => citation.sourceId === source.id))
          source.cited = true;
      contribution.recoveredFactIds.push(...recovered);
      if (families.size === 1) contribution.exclusiveRecoveredFactIds.push(...recovered);
    }
  }
  return [...contributions.values()]
    .sort((a, b) => a.family.localeCompare(b.family))
    .map((entry) => ({
      ...entry,
      claimIds: [...new Set(entry.claimIds)],
      recoveredFactIds: [...new Set(entry.recoveredFactIds)],
      exclusiveRecoveredFactIds: [...new Set(entry.exclusiveRecoveredFactIds)],
    }));
}
