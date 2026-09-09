import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AMBIGUITY_CAUSES,
  classifyJudgement,
  classifyPerson,
  downstreamFixFor,
  normalizeQuote,
  summarizeAssignments,
  type AmbiguityAssignment,
  type ClassifiablePerson,
} from "../../../apps/server/src/person-benchmark/ambiguity.js";

const GUARD_SUFFIX = "(Downgraded: the quoted dossier text does not occur in the dossier.)";
const NO_QUOTE_SUFFIX =
  "(Downgraded: the verdict names a dossier claim but quotes no dossier text.)";

function person(overrides: Partial<ClassifiablePerson> = {}): ClassifiablePerson {
  return {
    slug: "example-person",
    claimCount: 0,
    referenceFailure: null,
    supportStatus: "completed",
    supportFailure: null,
    unresolved: [],
    overclaims: [],
    integritySubjects: [],
    sourceContributionClaims: [],
    judgements: [],
    ...overrides,
  };
}

function judgement(overrides: Partial<ClassifiablePerson["judgements"][number]> = {}) {
  return {
    factId: "example-fact",
    verdict: "ambiguous",
    referenceQuote: "The reference fact statement.",
    evidenceQuote: null,
    claimId: null,
    rationale: "Judge rationale.",
    ...overrides,
  };
}

const corpus = () => null;

describe("normalizeQuote", () => {
  it("ignores case, whitespace and trailing punctuation", () => {
    expect(normalizeQuote("  Hola   Mundo. ")).toBe(normalizeQuote("hola mundo"));
  });
});

describe("classifyJudgement", () => {
  it("assigns judge-call-failed when the reference judge call threw", () => {
    const assignment = classifyJudgement(
      "expanded",
      person({
        referenceFailure:
          "Judge reference assessment failed: openrouter: a model call was in flight (ceiling 30000ms)",
        claimCount: 9,
      }),
      judgement({ rationale: "The judge did not return a usable verdict for this run." }),
      corpus(),
    );
    expect(assignment.cause).toBe("judge-call-failed");
    expect(assignment.basis.join("\n")).toContain("phases.reference.failure=");
  });

  it("assigns unresolved-support-observation when support findings are unresolved", () => {
    const assignment = classifyJudgement(
      "expanded",
      person({
        claimCount: 11,
        supportStatus: "failed",
        supportFailure: "Judge support findings named unknown claims.",
        unresolved: [{ claimId: "unresolved-claim-id", citedQuote: null }],
      }),
      judgement({
        factId: "nestle-ceo",
        claimId: "other-claim-id",
        evidenceQuote: "Freixe was CEO of Nestlé.",
        rationale:
          "Original semantic verdict: partial; downgraded to ambiguous because " +
          "support/usefulness assessment did not complete; positive recovery credit is withheld.",
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("unresolved-support-observation");
    // The unresolved observation names a different claim than the verdict's own.
    expect(assignment.basis.join("\n")).toContain("unresolv");
  });

  it("assigns support-assessment-failed when support failed with no unresolved findings", () => {
    const assignment = classifyJudgement(
      "expanded",
      person({
        claimCount: 6,
        supportStatus: "failed",
        supportFailure: "Judge support/usefulness assessment failed: ceiling fired",
      }),
      judgement({
        claimId: "gm-claim",
        evidenceQuote: "Barra was named CEO in 2013.",
        rationale:
          "Original semantic verdict: partial; downgraded to ambiguous because " +
          "support/usefulness assessment did not complete; positive recovery credit is withheld.",
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("support-assessment-failed");
  });

  it("assigns empty-dossier-no-evidence for an uncited verdict on an empty dossier", () => {
    const assignment = classifyJudgement(
      "fixed",
      person({ claimCount: 0 }),
      judgement({ rationale: `The dossier contains no claims. ${GUARD_SUFFIX}` }),
      corpus(),
    );
    expect(assignment.cause).toBe("empty-dossier-no-evidence");
  });

  it("assigns no-evidence-cited-nonempty-dossier when claims exist but none is cited", () => {
    const assignment = classifyJudgement(
      "expanded",
      person({ claimCount: 4 }),
      judgement({ rationale: `The dossier contains no mention of X. ${GUARD_SUFFIX}` }),
      corpus(),
    );
    expect(assignment.cause).toBe("no-evidence-cited-nonempty-dossier");
  });

  it("assigns no-evidence-cited-nonempty-dossier when a named claim is never quoted", () => {
    /* Issue #236: the judge seam forces this verdict to ambiguous with its own
       marker rather than the exact-claim guard's, and it is still the same
       cause — a verdict with no dossier text to check. */
    const assignment = classifyJudgement(
      "expanded",
      person({ claimCount: 4 }),
      judgement({
        claimId: "broadening-claim",
        rationale: `The dossier claims something broader. ${NO_QUOTE_SUFFIX}`,
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("no-evidence-cited-nonempty-dossier");
    expect(assignment.basis.join("\n")).toContain("quotes no dossier text");
    expect(assignment.basis.join("\n")).toContain("named and evidenceQuote=null");
  });

  it("assigns quote-matches-reference-text when the quote equals the reference wording", () => {
    const reference = "Danielsson became CEO on 1 January 2018";
    const assignment = classifyJudgement(
      "fixed",
      person({
        claimCount: 6,
        integritySubjects: ["claim-1"],
        sourceContributionClaims: [{ claimId: "claim-1", family: "documents-publishers" }],
      }),
      judgement({
        referenceQuote: reference,
        evidenceQuote: `${reference}.`,
        claimId: "claim-1",
        rationale: `Same fact with date. ${GUARD_SUFFIX}`,
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("quote-matches-reference-text");
  });

  it("assigns judge-quoted-citation-passage when the quote is the cited passage", () => {
    const cited =
      "Arvind Krishna is senior vice president and director, IBM Research. In this role, he helps guide strategy.";
    const assignment = classifyJudgement(
      "expanded",
      person({
        claimCount: 14,
        overclaims: [{ claimId: "claim-2", citedQuote: cited }],
        sourceContributionClaims: [{ claimId: "claim-2", family: "documents-publishers" }],
      }),
      judgement({
        referenceQuote: "Krishna joined Watson Research in 1990.",
        // The judge quoted a truncated prefix of the citation passage, not the claim.
        evidenceQuote: cited.slice(0, 60),
        claimId: "claim-2",
        rationale: `States senior research leadership. ${GUARD_SUFFIX}`,
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("judge-quoted-citation-passage");
  });

  it("assigns judge-quoted-citation-passage from the claim-excerpt-selection marker alone", () => {
    const assignment = classifyJudgement(
      "fixed",
      // No retained citedQuote: the verdict names its own cause.
      person({ claimCount: 6, integritySubjects: ["claim-9"] }),
      judgement({
        referenceQuote: "Danielsson became CEO on 1 January 2018.",
        evidenceQuote: "Danielsson tillträdde som verkställande direktör.",
        claimId: "claim-9",
        rationale:
          "Same fact with date. " +
          "(Downgraded: the quoted dossier text does not occur in the dossier. " +
          "The quotation is from the named claim's cited passage, not the claim statement.)",
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("judge-quoted-citation-passage");
    expect(assignment.basis.join("\n")).toContain("claim-excerpt-selection marker");
  });

  it("leaves a claim retained nowhere explicitly undetermined, never unknown", () => {
    const assignment = classifyJudgement(
      "fixed",
      person({ claimCount: 3 }),
      judgement({
        claimId: "invented-id",
        evidenceQuote: "Some dossier-like sentence.",
        rationale: `Matched text. ${GUARD_SUFFIX}`,
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("undetermined-quote-mismatch");
    expect(assignment.basis.join("\n")).toContain("cannot prove the claim is unknown");
  });

  it("assigns integrity-overclaim-downgrade when the because-clause cites no support failure", () => {
    const assignment = classifyJudgement(
      "expanded",
      person({
        claimCount: 6,
        supportStatus: "completed",
        supportFailure: null,
        overclaims: [{ claimId: "gm-claim", citedQuote: null }],
      }),
      judgement({
        claimId: "gm-claim",
        evidenceQuote: "Barra was named CEO in 2013.",
        rationale:
          "Original semantic verdict: recovered; downgraded to ambiguous because " +
          "the matched claim has a validated overclaim finding, including findings requiring review. " +
          "Dossier says named CEO in 2013.",
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("integrity-overclaim-downgrade");
  });

  it("assigns judge-semantic-ambiguous when the judge itself was uncertain", () => {
    const statement = "The dossier hints at the fact but never states it plainly.";
    const assignment = classifyJudgement(
      "fixed",
      person({
        claimCount: 2,
        sourceContributionClaims: [{ claimId: "claim-3", family: "documents-publishers" }],
      }),
      judgement({
        claimId: "claim-3",
        evidenceQuote: "A hint at the fact in the dossier wording",
        rationale: statement,
      }),
      statement,
    );
    expect(assignment.cause).toBe("judge-semantic-ambiguous");
    expect(assignment.corpusStatement).toBe(statement);
  });

  it("leaves an unresolvable quote mismatch explicitly undetermined, never guessed", () => {
    const assignment = classifyJudgement(
      "incumbent",
      person({
        claimCount: 3,
        sourceContributionClaims: [{ claimId: "claim-4", family: "documents-publishers" }],
      }),
      judgement({
        referenceQuote: "Cottam authored Radical Help about the welfare state.",
        evidenceQuote: "In her new book Radical Help she shows a new design",
        claimId: "claim-4",
        rationale: `Authored Radical Help. ${GUARD_SUFFIX}`,
      }),
      corpus(),
    );
    expect(assignment.cause).toBe("undetermined-quote-mismatch");
    expect(assignment.downstreamFix).toContain("no code fix is attributable");
  });
});

describe("classifyPerson and summarizeAssignments", () => {
  it("classifies only ambiguous verdicts and counts per cause per population", () => {
    const target = person({
      claimCount: 0,
      judgements: [
        judgement({ factId: "a", rationale: `No claims. ${GUARD_SUFFIX}` }),
        // Non-ambiguous verdicts are out of scope for this classifier.
        { ...judgement({ factId: "b", verdict: "missing", rationale: "Not stated." }) },
      ],
    });
    const assignments: AmbiguityAssignment[] = classifyPerson("fixed", target, corpus);
    expect(assignments.map((entry) => entry.factId)).toEqual(["a"]);
    const summary = summarizeAssignments(assignments);
    expect(summary.total).toBe(1);
    expect(summary.perCausePerPopulation.fixed["empty-dossier-no-evidence"]).toBe(1);
  });

  it("covers every named cause with a downstream fix", () => {
    expect(AMBIGUITY_CAUSES).toHaveLength(11);
    for (const cause of AMBIGUITY_CAUSES) expect(downstreamFixFor(cause).length).toBeGreaterThan(0);
  });
});

it("rejects duplicate --population labels before processing any report", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/person-ambiguity-classification.mts",
      "--report",
      "a.json",
      "--population",
      "fixed",
      "--report",
      "b.json",
      "--population",
      "fixed",
    ],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--population values must be unique.");
});

it("rejects a --report path outside the repository before reading it", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/person-ambiguity-classification.mts",
      "--report",
      "../outside-the-repository.json",
      "--population",
      "fixed",
    ],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--report path must live inside the repository");
});
