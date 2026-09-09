import type { TranscriptRecord, TranscriptRelevanceQuery } from "@chief-of-staff-demo/shared";
import type { TranscriptSemanticHit } from "./relevance.js";

/**
 * Index version 1: a deterministic local lexical index. No transcript text
 * leaves the Workspace (ADR-0001 local-first; the Catalog's disclosure names
 * the configured model only for extraction, not for this lane). A second
 * searcher reintroduces the seam; until then the index stays internal to the
 * relevance service.
 */
export const TRANSCRIPT_RELEVANCE_INDEX_VERSION = 1;

const MAX_CHUNK_CHARS = 400;
const PER_TERM_CAP = 5;
const PHRASE_BONUS = 12;
const MIN_TERM_CHARS = 3;

interface PreparedQuery {
  terms: string[];
  phrase: string | null;
}

function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (token) => token.length >= MIN_TERM_CHARS,
  );
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prepareQuery(query: TranscriptRelevanceQuery): PreparedQuery {
  const meeting = query.meeting;
  const contextParts = [
    meeting?.title ?? "",
    meeting?.purpose ?? "",
    ...(meeting?.topics ?? []),
    ...(meeting?.organizations ?? []),
    ...(meeting?.attendees ?? []),
  ];
  const terms = [...new Set(tokensOf([query.text, ...contextParts].join(" ")))];
  const phraseTokens = tokensOf(query.text);
  const phrase =
    phraseTokens.length >= 2
      ? phraseTokens
          .join(" ")
          .replace(/[^a-z0-9 ' -]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : null;
  return { terms, phrase: phrase && phrase.includes(" ") ? phrase : null };
}

/** Utterance-sized chunks: citations align to what a person actually said. */
function chunksOf(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    for (const piece of line.length > MAX_CHUNK_CHARS ? hardSlices(line) : [line]) {
      if (current && `${current}\n${piece}`.length > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hardSlices(line: string): string[] {
  const slices: string[] = [];
  for (let at = 0; at < line.length; at += MAX_CHUNK_CHARS) {
    slices.push(line.slice(at, at + MAX_CHUNK_CHARS));
  }
  return slices;
}

function countTerm(chunk: string, term: string): number {
  const matches = chunk.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"));
  return Math.min(matches?.length ?? 0, PER_TERM_CAP);
}

/**
 * The production relevance index: deterministic, explainable, in-process.
 * One best excerpt per retained Transcript; phrase matches outrank scattered
 * single-term matches; the explanation names exactly what matched. This is an
 * internal seam with its own tests, not an injected adapter: a second
 * searcher reintroduces the seam, until then callers use the service.
 */
export function searchLexicalIndex(input: {
  query: TranscriptRelevanceQuery;
  records: TranscriptRecord[];
}): TranscriptSemanticHit[] {
  const { query, records } = input;
  const prepared = prepareQuery(query);
  if (prepared.terms.length === 0) return [];
  const hits: TranscriptSemanticHit[] = [];
  for (const record of records) {
    let best: {
      chunk: string;
      score: number;
      matched: [string, number][];
      phrase: boolean;
    } | null = null;
    for (const chunk of chunksOf(record.normalizedText)) {
      const lower = chunk.toLowerCase();
      const matched: [string, number][] = [];
      for (const term of prepared.terms) {
        const count = countTerm(lower, term);
        if (count > 0) matched.push([term, count]);
      }
      if (matched.length === 0) continue;
      const phraseHit = prepared.phrase !== null && lower.includes(prepared.phrase);
      const score =
        matched.reduce((total, [, count]) => total + count, 0) + (phraseHit ? PHRASE_BONUS : 0);
      if (best === null || score > best.score) {
        best = { chunk, score, matched, phrase: phraseHit };
      }
    }
    if (best === null) continue;
    const matchedText = best.matched
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([term, count]) => `${term} ×${count}`)
      .join(", ");
    hits.push({
      transcriptId: record.id,
      excerpt: best.chunk,
      score: best.score,
      explanation: best.phrase
        ? `Matched the phrase "${prepared.phrase}"; terms: ${matchedText}.`
        : `Matched terms: ${matchedText}.`,
    });
  }
  return hits.sort((left, right) => right.score - left.score);
}
