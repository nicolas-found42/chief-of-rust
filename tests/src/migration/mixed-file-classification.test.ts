import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Program } from "oxc-parser";
import { parseSource } from "../source-ast.js";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { ConfigSchema } from "@chief-of-staff-demo/shared";
import { previewWorkspaceMigration } from "../../../apps/server/src/migration/workspace";

/**
 * The classification tables are a maintenance obligation with teeth (ADR-0046):
 * `config.json` and `relay.json` each hold authentication material next to
 * product state, so the migration parses them key by key against an explicit
 * table and fails the whole preview closed on a key that table does not name.
 *
 * That obligation had no test. `CONFIG_KEYS` mirrors `ConfigSchema` by hand, and
 * when #137 added `providerPolicy` to the schema the table was not updated —
 * every migration test still passed, because each one populated a hand-written
 * fixture that had also not been updated. The drift surfaced only when a browser
 * journey happened to run the preview over a Workspace a real Module had
 * written. A fixture cannot catch a key nobody remembered to add to it.
 *
 * So neither file's fixture is written here. Both are generated from the
 * declaration the table mirrors — `ConfigSchema` by zod introspection,
 * `RelayWorkspace` from its own interface declaration — populated to every leaf,
 * and put through the real preview. A key added to a declaration is populated by
 * construction, so a table that does not name it fails this test with the
 * dotted path, on the commit that adds it.
 *
 * The check is deliberately one-directional. Every key the declaration can
 * produce must be classified; a table key with no declaration behind it is not a
 * failure, because a pre-cutover `config.json` still holds keys the schema has
 * since dropped — `content-scout.notion` (#133), `guestProfile` (#136) — and
 * classifying those is exactly how the reset deletes them.
 */

/** The free key a `z.record` gets. Records are recognized by construction; the value is what is validated. */
const RECORD_KEY = "generated-record-key";

interface ZodInternals {
  typeName: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  keyType?: z.ZodTypeAny;
  values?: readonly string[];
  checks?: readonly { kind: string; value?: number; inclusive?: boolean }[];
  shape?: () => Record<string, z.ZodTypeAny>;
}

function internals(schema: z.ZodTypeAny): ZodInternals {
  return (schema as unknown as { _def: ZodInternals })._def;
}

/** The smallest number the declared checks allow, so generated values parse. */
function numberFor(def: ZodInternals): number {
  let low = 1;
  let high = Number.MAX_SAFE_INTEGER;
  for (const check of def.checks ?? []) {
    if (check.kind === "min" && check.value !== undefined) {
      low = Math.max(low, check.inclusive === false ? check.value + 1 : check.value);
    }
    if (check.kind === "max" && check.value !== undefined) high = Math.min(high, check.value);
  }
  return Math.min(Math.max(low, 1), high);
}

/**
 * One value populating every key the schema declares: every object key present,
 * one element in every array, one entry in every record. An unhandled zod type
 * throws rather than returning nothing — a schema that grows a construct this
 * walker cannot populate must be noticed here, not silently skipped.
 */
function populate(schema: z.ZodTypeAny, path: string): unknown {
  const def = internals(schema);
  switch (def.typeName) {
    case "ZodDefault":
    case "ZodOptional":
    case "ZodNullable":
      return populate(def.innerType!, path);
    case "ZodEffects":
      return populate(def.schema!, path);
    case "ZodObject": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(def.shape!())) {
        out[key] = populate(child, path ? `${path}.${key}` : key);
      }
      return out;
    }
    case "ZodArray":
      return [populate(def.type!, `${path}.0`)];
    case "ZodRecord": {
      const keys =
        def.keyType && internals(def.keyType).typeName === "ZodEnum"
          ? internals(def.keyType).values!
          : [RECORD_KEY];
      return Object.fromEntries(
        keys.map((key) => [key, populate(def.valueType!, `${path}.${key}`)]),
      );
    }
    case "ZodEnum":
      return def.values![0];
    case "ZodString":
      /* Lowercase and trimmed: `internalDomains` normalizes on parse, and the
         generator has to survive its own schema. */
      return `generated-${path.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    case "ZodNumber":
      return numberFor(def);
    case "ZodBoolean":
      return true;
    default:
      throw new Error(`populate(): unhandled zod type ${def.typeName} at "${path}"`);
  }
}

/** The findings a preview reported, or none when it produced an inventory. */
function findingsFor(workspaceDir: string) {
  const preview = previewWorkspaceMigration(workspaceDir);
  return preview.outcome === "unsafe-mixed-state" ? preview.findings : [];
}

function workspaceHolding(file: string, contents: unknown): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-classification-"));
  writeFileSync(join(workspaceDir, file), `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return workspaceDir;
}

describe("config.json classification covers ConfigSchema (#119, ADR-0046)", () => {
  const config = populate(ConfigSchema, "") as Record<string, unknown>;

  it("generates a config the schema itself accepts, to every leaf", () => {
    /* Without this the walker could pass by producing plausible keys with
       unusable values — the table would be checked against a shape the product
       can never store. */
    expect(() => ConfigSchema.parse(config)).not.toThrow();

    /* And it reaches the leaves under a record inside an object inside the
       Module namespace — the depth `providerPolicy` sits at, which is the depth
       the hand-written fixture failed to reach. */
    const modules = config.modules as Record<string, Record<string, unknown>>;
    const policy = modules["meeting-brief-generator"].providerPolicy as Record<string, unknown>;
    expect(Object.keys(policy[RECORD_KEY] as object).sort()).toEqual([
      "changedAt",
      "disabled",
      "reason",
    ]);
  });

  it("classifies every key ConfigSchema can produce", () => {
    expect(
      findingsFor(workspaceHolding("config.json", config)),
      "every ConfigSchema key must be named in CONFIG_KEYS — add the classification with the schema key",
    ).toEqual([]);
  });

  it("fails closed on a key the table does not name", () => {
    /* The mutation witness: the harness above passes because the table is
       complete, not because the preview accepts whatever it is handed. */
    const drifted = structuredClone(config) as Record<string, Record<string, object>>;
    drifted.modules["meeting-brief-generator"] = {
      ...drifted.modules["meeting-brief-generator"],
      unclassifiedSetting: "x",
    };
    expect(findingsFor(workspaceHolding("config.json", drifted))).toEqual([
      {
        entry: "config.json",
        key: "modules.meeting-brief-generator.unclassifiedSetting",
        reason: "unrecognized-key",
      },
    ]);
  });
});

/**
 * `relay.json` has no zod schema — `RelayWorkspace` is a plain interface — so
 * its keys come from the interface declaration instead. Same obligation, same
 * failure mode: a field added to the relay's durable state must be classified.
 */
const RELAY_STATE_FILE = fileURLToPath(
  new URL("../../../apps/server/src/relay/state.ts", import.meta.url),
);

/** One value per declared member, recursing into an interface an array element names. */
function populateInterface(source: Program, text: string, name: string): Record<string, unknown> {
  const declaration = source.body
    .map((statement) =>
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement,
    )
    .find(
      (statement) => statement?.type === "TSInterfaceDeclaration" && statement.id.name === name,
    );
  if (declaration?.type !== "TSInterfaceDeclaration")
    throw new Error(`interface ${name} not found in ${RELAY_STATE_FILE}`);
  const out: Record<string, unknown> = {};
  for (const member of declaration.body.body) {
    if (member.type !== "TSPropertySignature" || !member.typeAnnotation) continue;
    const key = text.slice(member.key.start, member.key.end);
    const type = member.typeAnnotation.typeAnnotation;
    out[key] =
      type.type === "TSArrayType" && type.elementType.type === "TSTypeReference"
        ? [
            populateInterface(
              source,
              text,
              text.slice(type.elementType.typeName.start, type.elementType.typeName.end),
            ),
          ]
        : `generated-${key.toLowerCase()}`;
  }
  return out;
}

describe("relay.json classification covers RelayWorkspace (#119, ADR-0046)", () => {
  it("classifies every field the relay's durable state declares", () => {
    const text = readFileSync(RELAY_STATE_FILE, "utf8");
    const source = parseSource(RELAY_STATE_FILE, text);
    const relay = populateInterface(source, text, "RelayWorkspace");
    /* Non-vacuous: the walker read the interface rather than an empty file, and
       reached the channel registration nested inside it. */
    expect(Object.keys(relay)).toContain("secret");
    expect(Object.keys((relay.channels as object[])[0])).toContain("token");

    expect(
      findingsFor(workspaceHolding("relay.json", relay)),
      "every RelayWorkspace field must be named in RELAY_KEYS",
    ).toEqual([]);
  });
});
