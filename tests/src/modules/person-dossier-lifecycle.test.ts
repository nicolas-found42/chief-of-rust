import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { personDossierRegistry } from "../../../apps/server/src/person-profile/lifecycle.js";

const retain = (dossiers: PersonDossierStore, url: string, text: string) =>
  dossiers.retainSource({
    url,
    title: url,
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05",
    text,
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "website",
  });

const profile = (id: string) => ({ id }) as unknown as PersonProfile;

test("deletion disclosure lists every retained source, including sources no claim cites", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-lifecycle-"));
  try {
    const dossiers = new PersonDossierStore(root);
    const cited = retain(
      dossiers,
      "https://example.com/cited",
      "Maya designed the Atlas scheduler.",
    );
    const orphan = retain(dossiers, "https://example.com/orphan", "Maya attended the summit.");
    dossiers.publish("p1", 0, {
      sourceIds: [cited.id, orphan.id],
      claims: [
        {
          id: "c",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: cited.id, quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    });
    const registry = personDossierRegistry(dossiers, () => {});
    const inspection = registry.inspect(profile("p1"));
    expect(inspection.dependentConfigurations).toEqual([]);
    expect(inspection.residualSourceArtifacts.map((artifact) => artifact.artifactId)).toEqual([
      cited.id,
      orphan.id,
    ]);
    expect(inspection.residualSourceArtifacts[0]).toMatchObject({
      kind: "public-source",
      separateDeleteSupported: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy deletion purges the dossier and reports one snapshot when one existed", () => {
  const root = mkdtempSync(join(tmpdir(), "dossier-lifecycle-delete-"));
  try {
    const dossiers = new PersonDossierStore(root);
    const source = retain(
      dossiers,
      "https://example.com/maya",
      "Maya designed the Atlas scheduler.",
    );
    dossiers.publish("p1", 0, {
      claims: [
        {
          id: "c",
          section: "work",
          statement: "Maya designed the Atlas scheduler.",
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: source.id, quote: "Maya designed the Atlas scheduler." }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    });
    const removed: string[] = [];
    const registry = personDossierRegistry(dossiers, (profileId) => removed.push(profileId));
    expect(registry.privacyDelete("p1")).toMatchObject({ personSnapshots: 1 });
    expect(dossiers.get("p1")).toBeNull();
    expect(removed).toEqual(["p1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
