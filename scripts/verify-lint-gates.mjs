import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the policies we moved from ESLint in an isolated source tree, so
// intentional violations cannot race the real compiler or unit-test gates.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "cosd-lint-gates-"));
const executable = join(dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8"));
config.jsPlugins = [{ name: "eslint-js", specifier: require.resolve("oxlint-plugin-eslint") }];

const probes = [
  {
    path: "apps/server/src/google/probe.ts",
    source:
      "const google = { auth: { OAuth2: class {} } }; export const client = new google.auth.OAuth2();\n",
    rule: null,
  },
  {
    path: "apps/server/src/modules/probe.ts",
    source:
      "const google = { auth: { OAuth2: class {} } }; export const client = new google.auth.OAuth2();\n",
    rule: "no-restricted-syntax",
  },
  {
    path: "apps/server/src/modules/import-probe.ts",
    source: "export { OAuth2Client } from 'google-auth-library';\n",
    rule: "no-restricted-imports",
  },
  {
    path: "apps/web/node-probe.ts",
    source: "import { readFile } from 'node:fs'; export { readFile };\n",
    rule: "no-restricted-imports",
  },
  {
    path: "apps/web/server-probe.ts",
    source: "import { secret } from '../../apps/server/src/secret'; export { secret };\n",
    rule: "no-restricted-imports",
  },
  {
    path: "apps/web/hooks-probe.tsx",
    source:
      "declare function useState(value: number): unknown; export function Example({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }\n",
    rule: "rules-of-hooks",
  },
  {
    path: "apps/web/refresh-probe.tsx",
    source: "export const answer = 42; export function Example() { return <div />; }\n",
    rule: "only-export-components",
  },
  {
    path: "apps/web/dependencies-probe.tsx",
    source:
      "declare function useEffect(effect: () => void, dependencies: unknown[]): void; export function Example({ value }: { value: number }) { useEffect(() => { console.log(value); }, []); return null; }\n",
    rule: "exhaustive-deps",
  },
  {
    path: "apps/server/src/floating-probe.ts",
    source: "export function dropped() { Promise.resolve(1); }\n",
    rule: "no-floating-promises",
  },
  {
    path: "apps/server/src/condition-probe.ts",
    source: "export function always(value: object) { return value ? 1 : 0; }\n",
    rule: "no-unnecessary-condition",
  },
  {
    path: "apps/server/src/assertion-probe.ts",
    source: "export function narrow(value: number) { return value as number; }\n",
    rule: "no-unnecessary-type-assertion",
  },
  {
    path: "apps/server/src/suppression-probe.ts",
    source:
      "export function narrow(value: number) {\n// oxlint-disable-next-line typescript/no-unnecessary-type-assertion\nreturn value as number;\n}\n",
    rule: null,
  },
];

try {
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
  writeFileSync(join(directory, ".oxlintrc.json"), JSON.stringify(config));
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "preserve",
        noEmit: true,
        types: [],
      },
      include: ["apps/**/*.ts", "apps/**/*.tsx"],
    }),
  );
  for (const probe of probes) {
    const path = join(directory, probe.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, probe.source);
    const result = spawnSync(process.execPath, [executable, "--max-warnings", "0", probe.path], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.error) throw result.error;
    if (probe.rule) {
      assert.equal(result.status, 1, `${probe.path} must fail lint:\n${output}`);
      assert.ok(output.includes(probe.rule), `${probe.path} must fail ${probe.rule}:\n${output}`);
    } else {
      assert.equal(result.status, 0, `${probe.path} must pass lint:\n${output}`);
    }
    rmSync(path);
  }
  process.stdout.write(`[lint-gates] ${probes.length} policy probes passed.\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
