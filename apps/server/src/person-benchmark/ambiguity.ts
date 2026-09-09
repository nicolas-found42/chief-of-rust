/**
 * Deterministic classification of ambiguous semantic verdicts (issue #234).
 *
 * The classifier reads retained benchmark reports only: it repeats no
 * research, makes no model calls, and never alters the input reports. Every
 * ambiguous verdict is assigned exactly one named cause; anything that cannot
 * be decided from retained evidence lands in `undetermined-quote-mismatch`
 * explicitly, never guessed.
 *
 * Mechanism background (apps/server/src/person-benchmark/judge.ts and
 * evaluate.ts): the exact-claim guard forces a verdict to ambiguous when the
 * judge's quoted dossier text is not a verbatim substring of the named claim
 * (`(Downgraded: the quoted dossier text does not occur in the dossier.)`);
 * evaluate.ts downgrades recovered/partial verdicts to ambiguous when the
 * support/usefulness assessment did not complete
 * (`Original semantic verdict: ...; downgraded to ambiguous because ...`);
 * a verdict that names a dossier claim without quoting it is forced to
 * ambiguous too (`(Downgraded: the verdict names a dossier claim but quotes no
 * dossier text.)`); and a thrown reference-phase judge call leaves every fact
 * of that person ambiguous (`The judge did not return a usable verdict for
 * this run.`).
 */
export const AMBIGUITY_CAUSES = [
  "judge-call-failed",
  "support-assessment-failed",
  "unresolved-support-observation",
  "integrity-overclaim-downgrade",
  "empty-dossier-no-evidence",
  "no-evidence-cited-nonempty-dossier",
  "quote-matches-reference-text",
  "judge-quoted-citation-passage",
  // Retained as a named hypothesis from the issue, but never emitted: the
  // retained claim-ID lists are partial, so absence there cannot prove a
  // claim is unknown. Unresolvable IDs land in undetermined-quote-mismatch.
  "unknown-claim-id",
  "judge-semantic-ambiguous",
  "undetermined-quote-mismatch",
] as const;

export type AmbiguityCause = (typeof AMBIGUITY_CAUSES)[number];

/** Rationale markers written by the judge/evaluator seams. */
const JUDGE_CALL_FAILURE_RATIONALE = "The judge did not return a usable verdict for this run.";
const GUARD_DOWNGRADE_MARKER = "does not occur in the dossier";
/** Written by the judge seam when the quotation is from the named claim's cited passage (issue #235). */
const CITATION_PASSAGE_MARKER = "cited passage, not the claim statement";
/** Written by the judge seam when a verdict names a claim it never quoted (issue #236). */
const NO_QUOTE_MARKER = "quotes no dossier text";
export const EVALUATOR_DOWNGRADE_PREFIX = "Original semantic verdict:";
/** Literal evaluate.ts writes when incomplete support withholds credit. */
const SUPPORT_DOWNGRADE_MARKER = "support/usefulness assessment did not complete";

/** Minimum normalized characters before a quote-prefix comparison counts. */
const CITATION_PREFIX_MIN_LENGTH = 20;

/** Narrow structural view of one retained support/overclaim-style finding. */
interface AmbiguityFinding {
  claimId: string;
  citedQuote: string | null;
}

/** Narrow structural view of one retained person result. */
export interface ClassifiablePerson {
  slug: string;
  claimCount: number;
  referenceFailure: string | null;
  supportStatus: string;
  supportFailure: string | null;
  unresolved: AmbiguityFinding[];
  overclaims: AmbiguityFinding[];
  integritySubjects: string[];
  sourceContributionClaims: { claimId: string; family: string }[];
  judgements: {
    factId: string;
    verdict: string;
    referenceQuote: string;
    evidenceQuote: string | null;
    claimId: string | null;
    rationale: string;
  }[];
}

export interface AmbiguityAssignment {
  population: string;
  personSlug: string;
  factId: string;
  claimId: string | null;
  evidenceQuote: string | null;
  referenceQuote: string;
  corpusStatement: string | null;
  cause: AmbiguityCause;
  /** Checkable citations: the verdict, claim and citation each rests on. */
  basis: string[];
  /** Which downstream fix this cause needs, naming its seam. */
  downstreamFix: string;
}

/** Normalize for quote comparison: compatibility width, whitespace, case. */
export function normalizeQuote(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’.…]+$/g, "")
    .trim()
    .toLowerCase();
}

const DOWNSTREAM_FIX: Record<AmbiguityCause, string> = {
  "judge-call-failed":
    "Judge reliability: reference-phase call ceiling/binding recovery " +
    "(apps/server/src/person-benchmark/judge.ts; judge-failure fallback in evaluate.ts).",
  "support-assessment-failed":
    "Judge reliability: support/usefulness-phase call robustness and the " +
    "AssessmentSchema contract (judge.ts; evaluate.ts).",
  "unresolved-support-observation":
    "Support observation resolution: judge support prompt plus verbatim-statement " +
    "and citation-index discipline (validFinding in judge.ts).",
  "integrity-overclaim-downgrade":
    "evaluate.ts credit gate: a validated overclaim finding or failed critical " +
    "integrity checks withheld recovery credit for the matched claim " +
    "(factualReliability seam); the downgrade is working as intended.",
  "empty-dossier-no-evidence":
    "Judge prompt: short-circuit an empty dossier to missing with no evidence " +
    "instead of a non-missing verdict without evidence (judge.ts recovery prompt).",
  "no-evidence-cited-nonempty-dossier":
    "Judge citation discipline: require a claimId plus a verbatim claim excerpt for " +
    "every non-missing verdict, and a quote from every verdict that names a claim " +
    "(judge.ts recovery prompt; the exact-claim guard stays).",
  "quote-matches-reference-text":
    "Judge quoting discipline plus guard normalization: quote the supplied dossier " +
    "claim rather than the reference wording, and normalize trailing punctuation in " +
    "the exact-claim guard (judge.ts).",
  "judge-quoted-citation-passage":
    "Judge quoting discipline: quote the matched dossier claim statement, never the " +
    "claim's cited source passage (judge.ts recovery prompt).",
  "unknown-claim-id":
    "Claim retention: judge-named claim IDs must resolve against the retained " +
    "dossier claim inventory (evidence.ts retention; judge.ts claimId instruction).",
  "judge-semantic-ambiguous":
    "Semantic judging of paraphrase against reference wording " +
    "(judge.ts recovery prompt; corpus wording).",
  "undetermined-quote-mismatch":
    "Evidence retention: retain the full dossier claim inventory (statements) in " +
    "reassessment evidence so the mismatch can be decided (evidence.ts); no code " +
    "fix is attributable from retained evidence.",
};

export function downstreamFixFor(cause: AmbiguityCause): string {
  return DOWNSTREAM_FIX[cause];
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Classify one ambiguous judgement. Non-ambiguous judgements are never passed
 * here; see classifyPerson. corpusStatement is the reference fact text from
 * the corpus when it resolves, otherwise null (the verdict's own
 * referenceQuote remains the citation).
 */
export function classifyJudgement(
  population: string,
  person: ClassifiablePerson,
  judgement: ClassifiablePerson["judgements"][number],
  corpusStatement: string | null,
): AmbiguityAssignment {
  const base = {
    population,
    personSlug: person.slug,
    factId: judgement.factId,
    claimId: judgement.claimId,
    evidenceQuote: judgement.evidenceQuote,
    referenceQuote: judgement.referenceQuote,
    corpusStatement,
  };
  const verdictBasis = `verdict ${judgement.factId}=ambiguous (${person.slug}/${population})`;
  const namedWithoutQuote = judgement.rationale.includes(NO_QUOTE_MARKER);
  const guardBasis = namedWithoutQuote
    ? `rationale carries the claim-quotation downgrade ` +
      `"(Downgraded: the verdict names a dossier claim but quotes no dossier text.)"`
    : `rationale carries the exact-claim-guard downgrade ` +
      `"(Downgraded: the quoted dossier text does not occur in the dossier.)"`;

  if (judgement.rationale === JUDGE_CALL_FAILURE_RATIONALE) {
    return {
      ...base,
      cause: "judge-call-failed",
      basis: [
        verdictBasis,
        `rationale is exactly "The judge did not return a usable verdict for this run."`,
        `phases.reference.failure=${JSON.stringify(person.referenceFailure)}`,
        `richness.claims=${String(person.claimCount)}`,
      ],
      downstreamFix: DOWNSTREAM_FIX["judge-call-failed"],
    };
  }

  if (judgement.rationale.startsWith(EVALUATOR_DOWNGRADE_PREFIX)) {
    const original = (
      judgement.rationale.slice(EVALUATOR_DOWNGRADE_PREFIX.length).split(";")[0] ?? ""
    ).trim();
    if (!judgement.rationale.includes(SUPPORT_DOWNGRADE_MARKER)) {
      return {
        ...base,
        cause: "integrity-overclaim-downgrade",
        basis: [
          verdictBasis,
          `rationale starts with "Original semantic verdict: ${original}" but its because-clause ` +
            `names no incomplete support/usefulness assessment`,
          `the downgrade attributes to a validated overclaim finding and/or failed critical ` +
            `integrity checks on the matched claim`,
          `phases.support.status=${person.supportStatus}`,
        ],
        downstreamFix: DOWNSTREAM_FIX["integrity-overclaim-downgrade"],
      };
    }
    if (person.unresolved.length > 0) {
      const named = person.unresolved.map((entry) => shortId(entry.claimId)).join(", ");
      return {
        ...base,
        cause: "unresolved-support-observation",
        basis: [
          verdictBasis,
          `rationale starts with "Original semantic verdict: ${original}" downgraded for an incomplete support/usefulness assessment`,
          `phases.support.status=${person.supportStatus}`,
          `phases.support.failure=${JSON.stringify(person.supportFailure)}`,
          `unresolved support observations name claim(s): ${named}`,
          `this verdict's claim (${shortId(judgement.claimId ?? "null")}) is withheld credit regardless of which claim was unresolved`,
        ],
        downstreamFix: DOWNSTREAM_FIX["unresolved-support-observation"],
      };
    }
    return {
      ...base,
      cause: "support-assessment-failed",
      basis: [
        verdictBasis,
        `rationale starts with "Original semantic verdict: ${original}" downgraded for an incomplete support/usefulness assessment`,
        `phases.support.status=${person.supportStatus}`,
        `phases.support.failure=${JSON.stringify(person.supportFailure)}`,
        `no unresolved support observations are retained for ${person.slug}`,
      ],
      downstreamFix: DOWNSTREAM_FIX["support-assessment-failed"],
    };
  }

  if (judgement.rationale.includes(GUARD_DOWNGRADE_MARKER) || namedWithoutQuote) {
    /* Claim-excerpt-selection verdicts (issue #235) name their own cause: the
       judge seam detected the quotation in the named claim's cited passage,
       so no retained citedQuote comparison is needed to decide the mismatch. */
    if (judgement.claimId !== null && judgement.rationale.includes(CITATION_PASSAGE_MARKER)) {
      return {
        ...base,
        cause: "judge-quoted-citation-passage",
        basis: [
          verdictBasis,
          guardBasis,
          `rationale carries the claim-excerpt-selection marker "The quotation is from the named claim's cited passage, not the claim statement", ` +
            `so the judge quoted the claim's cited source passage rather than the claim statement`,
        ],
        downstreamFix: DOWNSTREAM_FIX["judge-quoted-citation-passage"],
      };
    }
    /* No dossier text was quoted, so there is nothing to compare against a
       claim statement or a cited passage. Whether the judge also named a
       claim only changes the basis, not the cause (issue #236). */
    if (judgement.evidenceQuote === null) {
      const quotationBasis =
        judgement.claimId === null
          ? `claimId=null and evidenceQuote=null: the judge named no claim and quoted no dossier text`
          : `claimId ${shortId(judgement.claimId)} is named and evidenceQuote=null: the judge named a claim and quoted no dossier text`;
      if (person.claimCount === 0) {
        return {
          ...base,
          cause: "empty-dossier-no-evidence",
          basis: [
            verdictBasis,
            guardBasis,
            quotationBasis,
            `richness.claims=0: the dossier holds no claim that could have been cited`,
          ],
          downstreamFix: DOWNSTREAM_FIX["empty-dossier-no-evidence"],
        };
      }
      return {
        ...base,
        cause: "no-evidence-cited-nonempty-dossier",
        basis: [
          verdictBasis,
          guardBasis,
          quotationBasis,
          `richness.claims=${String(person.claimCount)}: the dossier holds claims, none of them cited`,
        ],
        downstreamFix: DOWNSTREAM_FIX["no-evidence-cited-nonempty-dossier"],
      };
    }

    if (judgement.claimId !== null) {
      const known = new Map<string, string>();
      for (const entry of person.overclaims) known.set(entry.claimId, "overclaims");
      for (const subject of person.integritySubjects)
        if (!known.has(subject)) known.set(subject, "integrity findings");
      for (const entry of person.sourceContributionClaims)
        if (!known.has(entry.claimId))
          known.set(entry.claimId, `sourceContributions:${entry.family}`);
      for (const entry of person.unresolved)
        if (!known.has(entry.claimId)) known.set(entry.claimId, "unresolvedFindings");
      const where = known.get(judgement.claimId);
      if (where === undefined) {
        return {
          ...base,
          cause: "undetermined-quote-mismatch",
          basis: [
            verdictBasis,
            guardBasis,
            `claimId ${shortId(judgement.claimId)} appears in no retained claim-ID list ` +
              `(overclaims, integrity subjects, sourceContributions claimIds, unresolvedFindings) for ${person.slug}, ` +
              `but those lists are partial, so absence there cannot prove the claim is unknown`,
          ],
          downstreamFix: DOWNSTREAM_FIX["undetermined-quote-mismatch"],
        };
      }
      const claimBasis =
        `claimId ${shortId(judgement.claimId)} is retained via ${where} for ${person.slug}, ` +
        `so the ID is known and the guard failed on the quoted text`;
      const normalizedEvidence = normalizeQuote(judgement.evidenceQuote);
      const normalizedReference = normalizeQuote(judgement.referenceQuote);
      if (normalizedEvidence.length > 0 && normalizedEvidence === normalizedReference) {
        return {
          ...base,
          cause: "quote-matches-reference-text",
          basis: [
            verdictBasis,
            guardBasis,
            claimBasis,
            `normalized evidenceQuote equals normalized referenceQuote; the judge quoted the reference wording, not a verbatim excerpt of the named claim`,
          ],
          downstreamFix: DOWNSTREAM_FIX["quote-matches-reference-text"],
        };
      }
      const retainedQuotes = [...person.overclaims, ...person.unresolved]
        .filter((entry) => entry.claimId === judgement.claimId && entry.citedQuote !== null)
        .map((entry) => normalizeQuote(entry.citedQuote as string))
        .filter((quote) => quote.length >= CITATION_PREFIX_MIN_LENGTH);
      const cited = retainedQuotes.find(
        (quote) =>
          normalizedEvidence.length >= CITATION_PREFIX_MIN_LENGTH &&
          (quote.startsWith(normalizedEvidence) || normalizedEvidence.startsWith(quote)),
      );
      if (cited !== undefined) {
        return {
          ...base,
          cause: "judge-quoted-citation-passage",
          basis: [
            verdictBasis,
            guardBasis,
            claimBasis,
            `evidenceQuote is a prefix of (or equals) the retained citedQuote for the same claim, ` +
              `so the judge quoted the claim's cited source passage rather than the claim statement`,
          ],
          downstreamFix: DOWNSTREAM_FIX["judge-quoted-citation-passage"],
        };
      }
      return {
        ...base,
        cause: "undetermined-quote-mismatch",
        basis: [
          verdictBasis,
          guardBasis,
          claimBasis,
          `evidenceQuote matches neither the reference wording nor any retained cited passage for this claim, ` +
            `and the dossier claim statements are not retained, so the exact mismatch cannot be decided`,
        ],
        downstreamFix: DOWNSTREAM_FIX["undetermined-quote-mismatch"],
      };
    }

    return {
      ...base,
      cause: "undetermined-quote-mismatch",
      basis: [
        verdictBasis,
        guardBasis,
        `evidence is quoted but no claim is named (claimId=null); without the dossier claim inventory no cause can be decided`,
      ],
      downstreamFix: DOWNSTREAM_FIX["undetermined-quote-mismatch"],
    };
  }

  return {
    ...base,
    cause: "judge-semantic-ambiguous",
    basis: [
      verdictBasis,
      `rationale carries no downgrade marker: the judge itself returned ambiguous and the exact-claim guard passed`,
      `rationale=${JSON.stringify(judgement.rationale.slice(0, 200))}`,
    ],
    downstreamFix: DOWNSTREAM_FIX["judge-semantic-ambiguous"],
  };
}

/**
 * Classify every ambiguous verdict of one person. Returns one assignment per
 * verdict === "ambiguous", in judgement order. Throws nothing: a verdict carrying
 * no downgrade marker is the judge's own ambiguity (judge-semantic-ambiguous).
 */
export function classifyPerson(
  population: string,
  person: ClassifiablePerson,
  corpusStatementFor: (slug: string, factId: string) => string | null,
): AmbiguityAssignment[] {
  const assignments: AmbiguityAssignment[] = [];
  for (const judgement of person.judgements) {
    if (judgement.verdict !== "ambiguous") continue;
    assignments.push(
      classifyJudgement(
        population,
        person,
        judgement,
        corpusStatementFor(person.slug, judgement.factId),
      ),
    );
  }
  return assignments;
}

export interface AmbiguitySummary {
  total: number;
  perPopulation: Record<string, number>;
  perCause: Record<string, number>;
  perCausePerPopulation: Record<string, Record<string, number>>;
}

export function summarizeAssignments(assignments: AmbiguityAssignment[]): AmbiguitySummary {
  const summary: AmbiguitySummary = {
    total: assignments.length,
    perPopulation: {},
    perCause: {},
    perCausePerPopulation: {},
  };
  const bump = (bucket: Record<string, number>, key: string): void => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const assignment of assignments) {
    bump(summary.perPopulation, assignment.population);
    bump(summary.perCause, assignment.cause);
    let bucket = summary.perCausePerPopulation[assignment.population];
    if (bucket === undefined) {
      bucket = {};
      summary.perCausePerPopulation[assignment.population] = bucket;
    }
    bump(bucket, assignment.cause);
  }
  return summary;
}
