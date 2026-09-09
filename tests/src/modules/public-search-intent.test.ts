import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicSearch } from "../../../apps/server/src/source-adapters/search.js";

it("resolves an exact organization alias from a versioned local ROR dump without a request", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-ror-"));
  try {
    const path = join(root, "ror.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "https://ror.org/123",
          names: [{ value: "Université Exemple" }, { value: "Example University" }],
        },
      ]),
    );
    const search = createPublicSearch(
      async () => {
        throw new Error("Network must not run");
      },
      undefined,
      {
        providerFilter: (name) => name === "ror",
        rorDataPath: path,
      },
    );
    const results = await search("biography", { organizations: ["Example University"] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: "https://ror.org/123",
      entityType: "organization",
      sourceVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("coalesces native identity queries across different discovery prose and preserves entity types", async () => {
  const calls: URL[] = [];
  const search = createPublicSearch(
    async (value) => {
      const url = new URL(value);
      calls.push(url);
      const body =
        url.hostname === "pub.orcid.org"
          ? {
              "expanded-result": [
                {
                  "orcid-id": "0000-0002-1825-0097",
                  "given-names": "Ana",
                  "family-names": "Botín",
                },
              ],
            }
          : { items: [{ id: "https://ror.org/123", name: "Known University" }] };
      return {
        url: value,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
        etag: null,
        lastModified: null,
        retryAfter: null,
      };
    },
    undefined,
    { providerFilter: (name) => ["orcid", "ror"].includes(name) },
  );
  const intent = { fullName: "Ana Botín", organizations: ["Known University"] };
  const results = await Promise.all([
    search("biography role career", intent),
    search("registry filing licence", intent),
  ]);
  expect(calls).toHaveLength(2);
  expect(calls.find((url) => url.hostname === "pub.orcid.org")?.searchParams.get("q")).toBe(
    '(given-names:"Ana" AND family-name:"Botín") OR credit-name:"Ana Botín"',
  );
  expect(calls.find((url) => url.hostname === "api.ror.org")?.searchParams.get("query")).toBe(
    "Known University",
  );
  expect(results[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ upstreamIndex: "orcid", entityType: "person" }),
      expect.objectContaining({ upstreamIndex: "ror", entityType: "organization" }),
    ]),
  );
  await search("more prose", intent);
  expect(calls).toHaveLength(2);
  await search("another person", { fullName: "Josiah Carberry" });
  expect(calls).toHaveLength(3);
});
