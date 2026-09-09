import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierQueries } from "../../../apps/server/src/person-profile/dossier-queries.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("the comprehensive corpus supplies dossier depth through research, persistence and grounded projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-coverage-"));
  try {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../fixtures/person-dossiers/comprehensive.json", import.meta.url),
        "utf8",
      ),
    ) as { url: string; text: string; extraction: unknown };
    const dossiers = new PersonDossierStore(root);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" });
    people.create({ fullName: "An unresearched person" });
    const research = new PersonResearch({
      dossiers,
      search: async () => [{ url: fixture.url, title: "Fictional source", snippet: "" }],
      /* Only the fixture's own URL exists: research follows the work URLs a
         matched source names, and a mock that served the same body at every
         URL would extract this corpus several times over. */
      fetch: async (url) => ({
        url,
        status: url === fixture.url ? 200 : 404,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url === fixture.url ? fixture.text : "",
      }),
      complete: async () => fixture.extraction,
    });
    await research.run(person, researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }));
    const dossier = new PersonDossierStore(root).get(person.id)!;
    const atlas = dossier.works.find((work) => work.title === "Atlas")!;
    expect(atlas.contribution?.text).toBe("Designed the scheduler");
    expect(atlas.teamContribution?.text).toContain("user interface");
    expect(atlas.scale.map((scale) => [scale.value, scale.unit])).toEqual([
      [200, "sites"],
      [8, "people"],
    ]);
    expect(atlas.authority.map((authority) => authority.role)).toEqual(["recommended", "executed"]);
    expect(atlas.constraints[0]?.text).toContain("256 MB");
    expect(atlas.outcomes.some((outcome) => outcome.afterDeparture)).toBe(true);
    expect(atlas.outcomes.some((outcome) => outcome.unsuccessful)).toBe(true);
    expect(dossier.expertise.find((expertise) => expertise.category === "rust")?.support).toBe(
      "claimed",
    );
    expect(dossier.works.find((work) => work.title === "Nova")?.kind).toBe("paper");
    expect(dossier.claims.some((claim) => claim.status === "contested")).toBe(true);
    for (const phrase of [
      "2021",
      "Audit Board",
      "acknowledgment",
      "advisory seat",
      "university research",
      "IP terms",
    ])
      expect(dossier.claims.some((claim) => claim.statement.includes(phrase))).toBe(true);
    const queries = new PersonDossierQueries({ people, dossiers });
    expect(queries.analyse(person.id, "public")?.collaborations[0]?.distinctWorks).toBe(2);
    expect(queries.analyse(person.id, "public")?.activity).toHaveLength(2);
    expect(queries.analyse(person.id, "public")?.quality.singleSourceClaims).toBe(18);
    expect(
      queries.search({
        categories: ["distributed scheduling", "safety regulation"],
        visibility: "public",
      }).coverage,
    ).toEqual({ activeProfiles: 2, researchedProfiles: 1, demonstrated: 1, claimedOnly: 0 });
    expect(dossier.sections).toHaveLength(8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
