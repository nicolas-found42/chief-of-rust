import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PersonDossierStore } from "../apps/server/src/person-profile/dossier-store.js";
import { PersonProfileStore } from "../apps/server/src/person-profile/store.js";
import { WorkspacePersonProfiles } from "../apps/server/src/person-profile/profiles.js";
import { PersonResearch, researchAllowance } from "../apps/server/src/person-profile/research.js";
import { createPublicSearch } from "../apps/server/src/source-adapters/search.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import { ConfigStore } from "../apps/server/src/config.js";
const configPath = process.argv[2];
if (!configPath)
  throw new Error(
    "Pass an existing configuration path; credentials are read without printing them.",
  );
const settings = new ConfigStore(configPath, false);
settings.load();
const config = settings.getForPurpose("personResearch");
const workspaceDir = mkdtempSync(join(tmpdir(), "person-dossier-canary-"));
const dossiers = new PersonDossierStore(workspaceDir);
const people = new WorkspacePersonProfiles({
  store: new PersonProfileStore(workspaceDir),
  lifecycle: [],
});
const diagnostics: { provider: string; outcome: string; results: number; ms: number }[] = [];
const search = createPublicSearch(undefined, undefined, {
  diagnostics: (event) => {
    diagnostics.push({
      provider: event.provider,
      outcome: event.outcome,
      results: event.results,
      ms: event.ms,
    });
  },
});
const complete = makeCompleteJson(
  {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.ollama.baseUrl,
  },
  join(workspaceDir, "mock.json"),
);
let modelCalls = 0;
let inputCharacters = 0;
let outputCharacters = 0;
const research = new PersonResearch({
  dossiers,
  people,
  search,
  complete: async (request) => {
    modelCalls += 1;
    inputCharacters += request.user.length + request.system.length;
    const result = await complete(request);
    outputCharacters += JSON.stringify(result).length;
    writeFileSync(join(workspaceDir, `model-${modelCalls}.json`), JSON.stringify(result, null, 2));
    return result;
  },
});
const results: unknown[] = [];
for (const [name, url] of [
  ["Simon Willison", "https://simonwillison.net/about/"],
  ["Rich Hickey", "https://clojure.org/about/rich_hickey"],
]) {
  const profile = people.create({ fullName: name!, profileUrls: [url!] });
  const before = modelCalls;
  const started = Date.now();
  const result = await research.run(
    profile,
    researchAllowance({ maxModelCalls: 8, maxMilliseconds: 120000 }),
  );
  const dossier = dossiers.get(profile.id);
  results.push({
    name,
    url,
    result,
    elapsedMilliseconds: Date.now() - started,
    modelCalls: modelCalls - before,
    claims: dossier?.claims.length ?? 0,
    works: dossier?.works.length ?? 0,
    sections: dossier?.sections.map((s) => s.key) ?? [],
    verifiedPassages: dossier?.claims.flatMap((c) => c.citations).length ?? 0,
  });
  process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
}
const report = {
  recordedAt: new Date().toISOString(),
  model: config.model,
  provider: config.provider,
  workspaceDir,
  results,
  diagnostics,
  usage: {
    modelCalls,
    inputCharacters,
    outputCharacters,
    actualTokens: "Unavailable from CompleteJson",
    estimatedCost:
      "Unavailable: no measured token usage or verified pricing; no monetary cap claimed",
  },
  limits: { canaryProfileOperations: 8, canaryMilliseconds: 120000 },
};
writeFileSync(
  resolve("docs/research/person-dossier-canary.json"),
  JSON.stringify(report, null, 2) + "\n",
);
