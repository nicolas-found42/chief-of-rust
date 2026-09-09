import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkComparisonSchema, BenchmarkReportSchema } from "@chief-of-staff-demo/shared";

/**
 * Committed benchmark artifacts are evidence, and a schema change that stops
 * them loading destroys it in place: reassessment (#270) and the acceptance
 * comparison (#259) both read artifacts written by earlier runs, including runs
 * recorded as failed. A field newly added to a retained source therefore has to
 * stay optional for as long as those artifacts are kept — absent means the
 * report predates the field, which is not the same as the route stating no
 * version.
 */
const ARTIFACTS = join(import.meta.dirname, "../../../artifacts/person-benchmark");

function artifacts(): string[] {
  return readdirSync(ARTIFACTS)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !name.includes(".person.") && !name.includes(".operation."));
}

describe("committed benchmark artifacts stay loadable", () => {
  it("finds artifacts to check", () => {
    expect(artifacts().length).toBeGreaterThan(0);
  });

  for (const name of artifacts()) {
    it(`parses ${name}`, () => {
      const raw: unknown = JSON.parse(readFileSync(join(ARTIFACTS, name), "utf8"));
      const schema = name === "comparison.json" ? BenchmarkComparisonSchema : BenchmarkReportSchema;
      const parsed = schema.safeParse(raw);
      /* Name the offending paths: "invalid" alone does not say which field a
         schema change just made unreadable. */
      const detail = parsed.success
        ? ""
        : parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
            .join(" | ");
      expect(detail).toBe("");
    });
  }
});
