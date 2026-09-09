import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPeopleApi } from "../../../apps/server/src/api/people";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { PersonProfileResolver } from "../../../apps/server/src/person-profile/resolver";
import { createPublicWebPersonProfileSource } from "../../../apps/server/src/person-profile/sources";
import {
  PersonIdentifierError,
  parsePersonIdentifier,
} from "../../../apps/server/src/person-profile/identifier";

/**
 * The typed-identifier lookup (an email or a profile URL starts the public-web
 * search): the preview writes nothing, accept is what mints the Profile, and a
 * LinkedIn address is a search term rather than a page anyone fetches.
 */
let app: FastifyInstance;
let store: PersonProfileStore;
let queries: string[];
let fetchedSites: string[];

const LINKEDIN_RESULT = {
  title: "Ada Lovelace — Analyst at Analytical Engines",
  url: "https://www.linkedin.com/in/ada-lovelace",
  snippet: "Ada Lovelace works on the Analytical Engine.",
};

/* Evidence only matches when the page actually names the identity searched
   for, so the email has to appear in what the result says. */
const EMAIL_RESULT = {
  title: "Analytical Engines — the team",
  url: "https://analytical-engines.example/team",
  snippet: "Reach Ada Lovelace at ada@example.com.",
};

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-people-lookup-"));
  store = new PersonProfileStore(workspaceDir);
  queries = [];
  fetchedSites = [];
  const profiles = new WorkspacePersonProfiles({ store, lifecycle: [] });
  const resolver = new PersonProfileResolver({
    store,
    sources: [
      createPublicWebPersonProfileSource({
        search: async (query) => {
          queries.push(query);
          if (query.includes("ada@example.com")) return [EMAIL_RESULT];
          return query.includes("ada-lovelace") ? [LINKEDIN_RESULT] : [];
        },
        discoverFeeds: async (siteUrl) => {
          fetchedSites.push(siteUrl);
          return [];
        },
      }),
    ],
  });
  app = fastify();
  registerPeopleApi(app, { people: profiles, resolver });
  return app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("parsePersonIdentifier", () => {
  it("reads an email address as an email signal", () => {
    expect(parsePersonIdentifier(" Ada@Example.com ")).toMatchObject({
      emails: ["ada@example.com"],
      profileUrls: [],
    });
  });

  it("reads a schemeless LinkedIn address as a profile URL and a handle", () => {
    const signals = parsePersonIdentifier("linkedin.com/in/ada-lovelace");
    expect(signals.profileUrls).toEqual(["https://linkedin.com/in/ada-lovelace"]);
    expect(signals.handles).toEqual({ linkedin: ["ada-lovelace"] });
  });

  it("refuses input that is neither an email nor an address", () => {
    expect(() => parsePersonIdentifier("Ada Lovelace")).toThrow(PersonIdentifierError);
    expect(() => parsePersonIdentifier("")).toThrow(PersonIdentifierError);
  });
});

describe("POST /api/people/lookup", () => {
  it("proposes a Profile from a LinkedIn address without saving anything", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/people/lookup",
      payload: { identifier: "linkedin.com/in/ada-lovelace" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      profile: { id: string; evidence: unknown[] };
      existing: boolean;
    }>();
    expect(body.profile.evidence.length).toBeGreaterThan(0);
    expect(body.existing).toBe(false);
    /* The proposal is a suggestion, never a confirmation: nothing is durable
       until the operator accepts it. */
    expect(store.list()).toEqual([]);
  });

  it("searches the typed address itself and never fetches the LinkedIn page", async () => {
    await app.inject({
      method: "POST",
      url: "/api/people/lookup",
      payload: { identifier: "linkedin.com/in/ada-lovelace" },
    });
    expect(queries).toContain('"https://linkedin.com/in/ada-lovelace"');
    expect(fetchedSites.some((site) => site.includes("linkedin.com"))).toBe(false);
  });

  it("classifies an identifier that is neither an email nor an address", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/people/lookup",
      payload: { identifier: "Ada Lovelace" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("unrecognized-identifier");
  });
});

describe("POST /api/people/lookup/accept", () => {
  it("creates the stable identity immediately without waiting for public research", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/people/lookup/accept",
      payload: { identifier: "ada@example.com" },
    });
    expect(response.statusCode).toBe(200);
    const { profile } = response.json<{ profile: { id: string } }>();
    const saved = store.get(profile.id);
    expect(saved?.emails).toContain("ada@example.com");
    expect(saved?.evidence).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("reports a second accept against the same identity as existing", async () => {
    await app.inject({
      method: "POST",
      url: "/api/people/lookup/accept",
      payload: { identifier: "ada@example.com" },
    });
    const again = await app.inject({
      method: "POST",
      url: "/api/people/lookup",
      payload: { identifier: "ada@example.com" },
    });
    expect(again.json<{ existing: boolean }>().existing).toBe(true);
  });
});

describe("POST /api/people/:profileId/enrich", () => {
  it("re-runs the search from the identity an existing Profile already holds", async () => {
    /* The shell case: a Module minted a Profile from an email and nothing
       else, so there is no identifier left to retype into the lookup. */
    const profiles = new WorkspacePersonProfiles({ store, lifecycle: [] });
    const shell = profiles.create({ primaryEmail: "ada@example.com" });
    expect(shell.evidence).toEqual([]);

    const response = await app.inject({
      method: "POST",
      url: `/api/people/${encodeURIComponent(shell.id)}/enrich`,
    });

    expect(response.statusCode).toBe(200);
    expect(queries).toContain('"ada@example.com"');
    const saved = store.get(shell.id);
    expect(saved?.evidence.length).toBeGreaterThan(0);
    expect(saved?.revision).toBeGreaterThan(shell.revision);
  });

  it("refuses an unknown Profile", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/people/person_nothing/enrich",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("profile-not-found");
  });

  it("refuses an archived Profile rather than reviving it by search", async () => {
    const profiles = new WorkspacePersonProfiles({ store, lifecycle: [] });
    const shell = profiles.create({ primaryEmail: "ada@example.com" });
    profiles.archive(shell.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/people/${encodeURIComponent(shell.id)}/enrich`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("profile-archived");
  });
});
