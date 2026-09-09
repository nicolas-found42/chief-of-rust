import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";

const FIXTURE =
  "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json";

it("accepts a provider that reports only one of the two token counts", () => {
  const report = BenchmarkReportSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL(FIXTURE, import.meta.url)), "utf8")),
  );
  const halfReported = structuredClone(report);
  halfReported.provenance.usage = {
    inputCharacters: 120,
    outputCharacters: 40,
    tokens: { input: 12, output: null },
    cost: 0.5,
  };
  const parsed = BenchmarkReportSchema.parse(halfReported);
  expect(parsed.provenance.usage?.tokens).toEqual({ input: 12, output: null });
});
