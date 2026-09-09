import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CompletionRequest, CompleteJson } from "../llm/providers.js";

/**
 * Disk cache in front of one CompleteJson seam, so judge re-scores after a
 * judge fix, and a resumed run's already-judged people, cost nothing. Only
 * resolved answers are cached — a failed call is an outage, and an outage is
 * retried for real, never memorialized (the promptfoo rule). The namespace
 * isolates logically distinct call families: a judge-version bump or a
 * repeat index rides there, so a K-repeat arm keeps sampling fresh answers
 * even when two repeats happen to produce identical request text — a cached
 * answer is not a fresh sample.
 */

export interface CacheOptions {
  cacheDir: string;
  namespace: string;
  provider: string;
  model: string;
  disabled?: boolean;
}

interface CacheEntry {
  key: string;
  answer: unknown;
}

function entryKey(options: CacheOptions, request: CompletionRequest): string {
  /* The wire schema belongs in the key: two call sites that share prompt text
     but validate different shapes are not interchangeable answers. */
  const shape = JSON.stringify(zodToJsonSchema(request.schema, { $refStrategy: "none" }));
  return createHash("sha256")
    .update(
      JSON.stringify([
        options.namespace,
        options.provider,
        options.model,
        request.system,
        request.user,
        request.temperature ?? null,
        request.reasoningEffort ?? null,
        request.seed ?? null,
        shape,
      ]),
    )
    .digest("hex");
}

/** Wrap one CompleteJson so identical judged questions are answered locally. */
export function cachedCompleteJson(inner: CompleteJson, options: CacheOptions): CompleteJson {
  if (options.disabled) return inner;
  return async (request) => {
    const key = entryKey(options, request);
    const path = join(options.cacheDir, `${key}.json`);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
      if (entry.key === key) return entry.answer;
    } catch {
      /* Miss: absent, partially written, or corrupt. All are the same thing —
         the model gets the call. */
    }
    const answer = await inner(request);
    try {
      mkdirSync(options.cacheDir, { recursive: true });
      const entry: CacheEntry = { key, answer };
      writeFileSync(path, `${JSON.stringify(entry)}\n`);
    } catch {
      /* An unwritable cache degrades to no cache, never to a failure: the
         answer is already in hand and the run must not lose it. */
    }
    return answer;
  };
}
