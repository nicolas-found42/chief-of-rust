import type {
  BenchmarkMode,
  BenchmarkPerson,
  PersonDossier,
  PersonSourceDocument,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../llm/providers.js";
import { assessPerson } from "./evaluate.js";

/** Assess only evidence already published at a cutoff, using the ordinary judge. */
export async function assessTimeline(input: {
  person: BenchmarkPerson;
  mode: BenchmarkMode;
  startedAt: string;
  revisions: PersonDossier[];
  sources: PersonSourceDocument[];
  minutes: number[];
  judge: CompleteJson;
}) {
  const started = Date.parse(input.startedAt);
  if (
    !Number.isFinite(started) ||
    input.minutes.length > 12 ||
    input.minutes.some((minute) => !Number.isFinite(minute) || minute <= 0 || minute > 60)
  )
    throw new Error("Invalid research timeline cutoffs");
  const revisions = [...input.revisions].sort((a, b) => a.revision - b.revision);
  const results = [];
  for (const minute of [...new Set(input.minutes)].sort((a, b) => a - b)) {
    const cutoff = started + minute * 60000;
    const dossier =
      revisions.filter((entry) => Date.parse(entry.updatedAt) <= cutoff).at(-1) ?? null;
    const sourceIds = new Set(dossier?.sourceIds ?? []);
    const sources = input.sources.filter((source) => sourceIds.has(source.id));
    if (sources.some((source) => source.visibility !== "public"))
      throw new Error("Timeline requires public evidence");
    const result = await assessPerson(input.person, input.mode, {
      dossier,
      sources,
      publicProjection: dossier,
      operation: null,
      judge: input.judge,
      elapsedMilliseconds: minute * 60000,
      failure:
        "Timed evidence snapshot; no operation completion verdict is inferred at this cutoff.",
    });
    results.push({ minute, revision: dossier?.revision ?? null, result });
  }
  return results;
}
