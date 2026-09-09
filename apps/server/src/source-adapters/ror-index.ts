import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod/v3";
import type { PublicSearchResult } from "./search.js";

const RecordSchema = z.object({
  id: z.string().url(),
  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  names: z.array(z.object({ value: z.string() })).optional(),
});
const normalize = (name: string) =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Exact organization/alias lookup over an explicitly installed ROR v1/v2 dump. */
export function loadRorIndex(path: string) {
  if (statSync(path).size > 256 * 1024 * 1024) throw new Error("ROR data exceeds 256 MiB");
  const bytes = readFileSync(path);
  const records = z
    .array(RecordSchema)
    .max(500000)
    .parse(JSON.parse(bytes.toString("utf8")));
  const version = createHash("sha256").update(bytes).digest("hex");
  const index = new Map<string, Map<string, PublicSearchResult>>();
  for (const record of records) {
    const url = new URL(record.id);
    if (url.protocol !== "https:" || url.hostname !== "ror.org")
      throw new Error("Invalid ROR identifier");
    const names = [
      record.name,
      ...(record.aliases ?? []),
      ...(record.names ?? []).map((name) => name.value),
    ].filter((name): name is string => !!name);
    for (const name of names) {
      const key = normalize(name);
      const matches = index.get(key) ?? new Map<string, PublicSearchResult>();
      matches.set(record.id, {
        url: record.id,
        title: names[0] ?? name,
        snippet: "",
        entityType: "organization",
        upstreamIndex: "ror",
        sourceVersion: version,
      });
      index.set(key, matches);
    }
  }
  return {
    version,
    lookup(name: string): PublicSearchResult[] | null {
      const matches = index.get(normalize(name));
      // An ambiguous alias or miss takes the normal provider path, not a guess.
      return matches?.size === 1 ? [...matches.values()] : null;
    },
  };
}
