import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Visitor, type Program } from "oxc-parser";
import { parseSource } from "../source-ast.js";
import { describe, expect, it } from "vitest";

/**
 * No remaining caller performs a legacy dual-write (issue #199).
 *
 * The retired *routes* answering 404 is the behavioural half of this criterion,
 * and `meeting-debrief-review.test.ts` already holds it. A 404 says nothing
 * about a caller inside the process that never went through HTTP, and the
 * criterion is explicitly about callers: "a regression suite proves no
 * remaining caller performs legacy dual-write". "Nobody does this" cannot be
 * proven by exercising the callers you remembered to exercise, so this half
 * reads the tree.
 *
 * Its sibling `shell-composition.test.ts` warns that source text was the wrong
 * evidence for #125, and that warning is respected here: nothing below matches
 * prose. Every assertion is a parsed fact — an import edge, or a string literal
 * the program actually evaluates — so a comment mentioning a retired seam is
 * not a finding, and renaming a symbol inside a comment cannot make one go away.
 */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PRODUCTION = ["apps/server/src", "apps/web/src", "packages/shared/src"];
const DEBRIEF = "apps/server/src/modules/meeting-debrief";

/** Every production TypeScript file, read from the tree rather than listed. */
function filesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      filesUnder(path, found);
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) found.push(path);
  }
  return found;
}

function parse(path: string): Program {
  return parseSource(path);
}

/** Every string the file evaluates, comments and identifiers excluded. */
function stringLiterals(source: Program): string[] {
  const found: string[] = [];
  new Visitor({
    Literal(node) {
      if (typeof node.value === "string") found.push(node.value);
    },
    TemplateElement(node) {
      found.push(node.value.cooked ?? node.value.raw);
    },
  }).visit(source);
  return found;
}

/** Every module specifier the file imports from. */
function importedModules(source: Program): string[] {
  return source.body
    .filter((statement) => statement.type === "ImportDeclaration")
    .map((statement) => statement.source.value);
}

/**
 * What a legacy dual-write needed to name, as the program names it. Both were
 * string literals in the code that was retired: the Run-level receipt file the
 * Debrief wrote beside its `result.json`, and the positional routes its review
 * surface called.
 */
const RETIRED_LITERALS = [
  {
    what: "the Run-level Google Task receipt file",
    matches: (text: string) => text === "tasks.json",
    /* What the retired code wrote, and what the canonical code writes. */
    caught: ["tasks.json"],
    allowed: ["result.json", "review.json", "draft.json"],
  },
  {
    what: "a positional Meeting Debrief action-item route",
    matches: (text: string) =>
      /meeting-debrief\/.*action-items|action-items\/.*\/(drop|done)/.test(text),
    caught: [
      "/api/meeting-debrief/action-items",
      "/api/meeting-debrief/:runId/action-items/:index/drop",
      "/api/meeting-debrief/run_1/action-items/0/done",
    ],
    /* The canonical Action Item routes, which name a stable identity. */
    allowed: [
      "/api/action-items/:actionItemId/promote",
      "/api/action-items/:actionItemId/dismiss",
      "/api/action-items/:actionItemId/restore",
    ],
  },
];

describe("no production caller performs a legacy dual-write (#199)", () => {
  const production = PRODUCTION.flatMap((root) => filesUnder(join(REPO, root)));
  const debrief = filesUnder(join(REPO, DEBRIEF));

  it("reads the whole production tree, so the claim covers every caller", () => {
    /* A scan that silently found nothing to read would pass every assertion
       below without proving anything. */
    expect(production.length).toBeGreaterThan(100);
    expect(debrief.length).toBeGreaterThan(3);
  });

  it.each(RETIRED_LITERALS)(
    "recognizes $what when it sees it, and leaves its replacement alone",
    ({ matches, caught, allowed }) => {
      /* A matcher that matched nothing would let the scan below pass without
         proving anything, and one that matched the canonical replacement would
         fail on correct code. Both halves are asserted before the scan runs. */
      expect(caught.filter(matches)).toEqual(caught);
      expect(allowed.filter(matches)).toEqual([]);
    },
  );

  it.each(RETIRED_LITERALS)("finds no caller naming $what", ({ matches }) => {
    const offenders = production
      .filter((path) => {
        /* The migration reads the historical receipt; only the Debrief that
           wrote one is retired. Reading old evidence is the point of #183. */
        if (path.endsWith("tasks/legacy-migration.ts") || path.endsWith("tasks/store.ts")) {
          return false;
        }
        return stringLiterals(parse(path)).some(matches);
      })
      .map((path) => relative(REPO, path));

    expect(offenders).toEqual([]);
  });

  it("gives the Meeting Debrief module no import edge to the Tasks module at all", () => {
    /* The structural form of "Meeting Debrief produces Action Items and drafts
       without owning promoted Tasks or receipts" (issue #200). Unlike the two
       assertions above, this one has no historical positive control — the
       dual-write reached Google through the shared outputs port rather than
       through the Tasks module, so this edge was absent even then. It is a
       forward guard on the boundary, not evidence about what was removed. */
    const offenders = debrief
      .map((path) => ({
        path: relative(REPO, path),
        tasks: importedModules(parse(path)).filter((module) => /(^|\/)tasks\//.test(module)),
      }))
      .filter((file) => file.tasks.length > 0);

    expect(offenders).toEqual([]);
  });
});
