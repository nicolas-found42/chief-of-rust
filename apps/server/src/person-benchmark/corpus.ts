import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  BENCHMARK_DOSSIER_REQUIREMENTS,
  BenchmarkPersonSchema,
  BenchmarkCollectionScenarioSchema,
  type BenchmarkCollectionScenario,
  type BenchmarkDossierRequirement,
  type BenchmarkPerson,
} from "@chief-of-staff-demo/shared";

/**
 * The Person Research Benchmark corpus on disk.
 *
 * One file per Benchmark Person, each carrying its own retained excerpts, so a
 * reference can be read, diffed and corrected as a unit. Loading validates the
 * two things a reference must never get wrong: every excerpt hashes to what it
 * says it does, and every reference quote actually occurs in the excerpt it
 * cites. A corpus that fails either is refused rather than evaluated, because
 * a benchmark that cannot verify its own references cannot judge anything.
 */
export interface BenchmarkCorpus {
  version: string;
  people: BenchmarkPerson[];
  scenarios: BenchmarkCollectionScenario[];
  /** Problems that made a file unusable. Never silently skipped. */
  rejected: { file: string; reason: string }[];
}

const DEFAULT_CORPUS_DIR = "benchmark/person-research/people";

export function loadCorpus(directory = DEFAULT_CORPUS_DIR): BenchmarkCorpus {
  if (!existsSync(directory)) throw new Error(`Benchmark corpus directory not found: ${directory}`);
  const people: BenchmarkPerson[] = [];
  const rejected: { file: string; reason: string }[] = [];
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith(".json")) continue;
    const path = join(directory, file);
    try {
      const person = BenchmarkPersonSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      const problems = validateReference(person);
      if (people.some((entry) => entry.slug === person.slug))
        problems.push(`duplicate person slug ${person.slug}`);
      if (problems.length) {
        rejected.push({ file, reason: problems.join("; ") });
        continue;
      }
      people.push(person);
    } catch (error) {
      rejected.push({ file, reason: error instanceof Error ? error.message : "unreadable" });
    }
  }
  /* The corpus version is derived from the references themselves, so a report
     cannot claim to have run against a corpus it did not run against. */
  const scenarios: BenchmarkCollectionScenario[] = [];
  const scenarioPath = join(directory, "..", "collection-scenarios.json");
  if (existsSync(scenarioPath)) {
    try {
      const entries = BenchmarkCollectionScenarioSchema.array()
        .max(100)
        .parse(JSON.parse(readFileSync(scenarioPath, "utf8")));
      for (const scenario of entries) {
        if (scenarios.some((entry) => entry.id === scenario.id))
          throw new Error(`Duplicate collection scenario ${scenario.id}`);
        for (const expected of scenario.expected) {
          const person = people.find((entry) => entry.slug === expected.slug);
          if (
            !person ||
            expected.factIds.some((id) => !person.facts.some((fact) => fact.id === id))
          )
            throw new Error(
              `Collection scenario ${scenario.id} cites an unknown person or reference fact.`,
            );
        }
        scenarios.push(scenario);
      }
    } catch (error) {
      rejected.push({
        file: scenarioPath,
        reason: error instanceof Error ? error.message : "Unreadable collection scenarios.",
      });
    }
  }
  const version = createHash("sha256")
    .update(JSON.stringify(scenarios.length ? { people, scenarios } : people))
    .digest("hex")
    .slice(0, 16);
  return { version, people, scenarios, rejected };
}

/** Everything a reference has to satisfy before it may judge anything. */
export function validateReference(person: BenchmarkPerson): string[] {
  const problems: string[] = [];
  const documents = new Map(person.documents.map((document) => [document.id, document]));
  const documentIds = new Set<string>();
  for (const document of person.documents) {
    if (documentIds.has(document.id)) problems.push(`document ${document.id}: duplicate id`);
    documentIds.add(document.id);
    const hash = createHash("sha256").update(document.excerpt).digest("hex");
    if (hash !== document.hash)
      problems.push(`document ${document.id}: excerpt does not match its recorded hash`);
  }
  const factIds = new Set<string>();
  for (const fact of person.facts) {
    if (factIds.has(fact.id)) problems.push(`fact ${fact.id}: duplicate id`);
    factIds.add(fact.id);
    for (const support of fact.support) {
      const document = documents.get(support.documentId);
      if (!document) {
        problems.push(`fact ${fact.id}: cites unknown document ${support.documentId}`);
        continue;
      }
      if (!normalize(document.excerpt).includes(normalize(support.quote)))
        problems.push(
          `fact ${fact.id}: quote does not occur in the retained excerpt of ${support.documentId}`,
        );
    }
  }
  return problems;
}

/** Whitespace-insensitive containment: excerpts wrap, quotes do not. */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * What live research is allowed to see.
 *
 * Built by construction rather than by deletion: this returns a fresh object
 * with only the lookup signals, so a later field added to `BenchmarkPerson`
 * cannot leak into the pipeline under test by being forgotten here.
 */
export function isolatedLookup(person: BenchmarkPerson): {
  fullName: string;
  currentEmployer?: string;
  profileUrls: string[];
  emails: string[];
} {
  return {
    fullName: person.lookup.fullName,
    ...(person.lookup.employerHint ? { currentEmployer: person.lookup.employerHint } : {}),
    profileUrls: [...person.lookup.profileUrls],
    emails: [...person.lookup.emails],
  };
}

/** Which of the twenty dossier requirements the collection exercises. */
export function requirementCoverage(
  people: BenchmarkPerson[],
): { requirement: BenchmarkDossierRequirement; label: string; facts: number; people: number }[] {
  return (Object.keys(BENCHMARK_DOSSIER_REQUIREMENTS) as BenchmarkDossierRequirement[]).map(
    (requirement) => {
      const matching = people.filter((person) =>
        person.facts.some((fact) => fact.requirements.includes(requirement)),
      );
      return {
        requirement,
        label: BENCHMARK_DOSSIER_REQUIREMENTS[requirement],
        facts: people.reduce(
          (count, person) =>
            count + person.facts.filter((fact) => fact.requirements.includes(requirement)).length,
          0,
        ),
        people: matching.length,
      };
    },
  );
}
