import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExtractionResultSchema,
  NormalizedExtractionResultSchema,
} from "@chief-of-staff-demo/shared";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures");

const golden = JSON.parse(readFileSync(join(fixturesDir, "mock-result.json"), "utf8")) as Record<
  string,
  unknown
>;

describe("ExtractionResultSchema", () => {
  it("accepts the golden result", () => {
    const parsed = ExtractionResultSchema.parse({
      ...golden,
      sourceId: "run_x",
      sourceFileName: "a.md",
    });
    expect(parsed.tasks).toHaveLength(3);
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.version).toBe(1);
  });

  it("rejects a malformed due date", () => {
    const bad = structuredClone(golden);
    (bad.tasks as { due: string }[])[0].due = "2026-8-24";
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it("rejects a due date with a time component", () => {
    const bad = structuredClone(golden);
    (bad.tasks as { due: string }[])[0].due = "2026-08-24T00:00:00Z";
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it("rejects extra properties on tasks", () => {
    const bad = structuredClone(golden);
    (bad.tasks as Record<string, unknown>[])[0].priority = "high";
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it("rejects an empty title", () => {
    const bad = structuredClone(golden);
    (bad.tasks as { title: string }[])[0].title = "";
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it("rejects a wrong version literal", () => {
    const bad = structuredClone(golden);
    bad.version = 2;
    expect(() => ExtractionResultSchema.parse(bad)).toThrow();
  });

  it("normalizes wire-shaped nulls into absent optionals", () => {
    const wire = {
      version: 1,
      sourceId: "run_x",
      sourceFileName: "a.md",
      sourceUrl: null,
      processedAt: "2026-08-18T00:00:00.000Z",
      isTranscript: true,
      skipReason: null,
      summary: "s",
      tasks: [{ title: "T", owner: null, due: "2026-08-21", notes: null, sourceQuote: "q" }],
      drafts: [{ to: "", subject: "S", body: "B", reason: null }],
    };
    const normalized = NormalizedExtractionResultSchema.parse(wire);
    expect(normalized.tasks[0]).toEqual({ title: "T", due: "2026-08-21", sourceQuote: "q" });
    expect(normalized.drafts[0]).toEqual({ to: "", subject: "S", body: "B" });
  });

  it("still rejects payloads valid in neither shape", () => {
    expect(() => NormalizedExtractionResultSchema.parse({ version: 1 })).toThrow();
  });
});
