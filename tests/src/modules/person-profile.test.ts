import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PersonProfileResolver,
  type PersonProfileSource,
} from "../../../apps/server/src/person-profile/resolver";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import {
  createHubSpotPersonProfileSource,
  createPublicWebPersonProfileSource,
} from "../../../apps/server/src/person-profile/sources";
import type { HubSpotApi } from "../../../apps/server/src/modules/meeting-brief-generator/hubspot/client";

describe("Person Profile", () => {
  it("merges matched evidence from independent sources into one durable profile revision", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "person-profile-"));
    const store = new PersonProfileStore(workspaceDir);
    const sources: PersonProfileSource[] = [
      {
        id: "hubspot",
        async collect() {
          return {
            candidates: [
              {
                source: "hubspot",
                kind: "employment",
                title: "HubSpot contact and company",
                summary: "Nicolas Grenie is Founder at found42.",
                url: "https://app.hubspot.com/contacts/123",
                identitySignals: {
                  emails: ["nicolas@found42.com"],
                  fullNames: ["Nicolas Grenie"],
                  handles: {},
                  profileUrls: [],
                  employerHints: ["found42"],
                },
                claims: {
                  fullName: "Nicolas Grenie",
                  role: "Founder",
                  currentEmployer: "found42",
                },
              },
            ],
            diagnostic: { status: "completed", detail: "one exact contact" },
          };
        },
      },
      {
        id: "public-web",
        async collect() {
          return {
            candidates: [
              {
                source: "public-web",
                kind: "social-profile",
                title: "Nicolas Grenie on GitHub",
                summary: "Projects and public activity by @picsoung.",
                url: "https://github.com/picsoung",
                identitySignals: {
                  emails: [],
                  fullNames: ["Nicolas Grenie"],
                  handles: { github: ["picsoung"] },
                  profileUrls: ["https://github.com/picsoung"],
                  employerHints: [],
                },
                claims: {},
              },
              {
                source: "public-web",
                kind: "mention",
                title: "A different Nicolas Grenie",
                summary: "An unrelated person with the same name.",
                url: "https://example.net/unrelated",
                identitySignals: {
                  emails: ["someone-else@example.net"],
                  fullNames: ["Nicolas Grenie"],
                  handles: { github: ["not-picsoung"] },
                  profileUrls: [],
                  employerHints: ["Unrelated Corp"],
                },
                claims: {},
              },
            ],
            diagnostic: { status: "completed", detail: "two public results" },
          };
        },
      },
    ];
    const resolver = new PersonProfileResolver({
      store,
      sources,
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });

    const profile = await resolver.resolve({
      emails: ["Nicolas@Found42.com"],
      fullNames: ["Nicolas Grenie"],
      handles: { github: ["@picsoung"] },
      profileUrls: [],
      employerHints: ["found42"],
    });

    expect(profile.revision).toBe(1);
    expect(profile.fullName).toBe("Nicolas Grenie");
    expect(profile.primaryEmail).toBe("nicolas@found42.com");
    expect(profile.role).toBe("Founder");
    expect(profile.currentEmployer).toBe("found42");
    expect(profile.evidence).toHaveLength(2);
    expect(profile.evidence.map((item) => item.matchConfidence)).toEqual(["high", "high"]);
    expect(profile.socialProfiles).toEqual([
      { platform: "github", handle: "picsoung", url: "https://github.com/picsoung" },
    ]);
    expect(profile.sourceDiagnostics).toEqual([
      { source: "hubspot", status: "completed", detail: "one exact contact" },
      { source: "public-web", status: "completed", detail: "two public results" },
    ]);
    expect(store.get(profile.id)).toEqual(profile);

    const refreshed = await resolver.resolve({
      emails: ["nicolas@found42.com"],
      fullNames: ["Nicolas Grenie"],
      handles: {},
      profileUrls: [],
      employerHints: [],
    });

    expect(refreshed.id).toBe(profile.id);
    expect(refreshed.revision).toBe(2);
    expect(refreshed.evidence).toHaveLength(2);
    expect(store.getRevision(profile.id, 1)).toEqual(profile);
  });

  it("keeps name-only evidence tentative and rejects candidates contradicted by exact identifiers", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "person-profile-match-"));
    const source: PersonProfileSource = {
      id: "public-web",
      async collect() {
        return {
          candidates: [
            {
              source: "public-web",
              kind: "mention",
              title: "Alex Morgan speaks at an event",
              summary: "Alex Morgan spoke about developer tools.",
              url: "https://events.example/alex-morgan",
              identitySignals: {
                emails: [],
                fullNames: ["Alex Morgan"],
                handles: {},
                profileUrls: [],
                employerHints: [],
              },
              claims: {},
            },
            {
              source: "public-web",
              kind: "social-profile",
              title: "Alex Morgan",
              summary: "A contradictory profile.",
              url: "https://github.com/different-alex",
              identitySignals: {
                emails: ["different@example.com"],
                fullNames: ["Alex Morgan"],
                handles: { github: ["different-alex"] },
                profileUrls: [],
                employerHints: [],
              },
              claims: {},
            },
          ],
          diagnostic: { status: "completed", detail: "bounded search" },
        };
      },
    };
    const resolver = new PersonProfileResolver({
      store: new PersonProfileStore(workspaceDir),
      sources: [source],
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });

    const profile = await resolver.resolve({
      emails: ["alex@example.com"],
      fullNames: ["Alex Morgan"],
      handles: { github: ["known-alex"] },
      profileUrls: [],
      employerHints: [],
    });

    expect(profile.evidence).toHaveLength(1);
    expect(profile.evidence[0]?.matchConfidence).toBe("medium");
    expect(profile.evidence[0]?.matchedSignals).toEqual(["fullName:alex morgan"]);
    expect(profile.mentions).toHaveLength(1);
    expect(profile.publications).toEqual([]);
  });

  it("turns an exact HubSpot contact and one associated company into high-confidence person evidence", async () => {
    const api: HubSpotApi = {
      async listContacts() {
        return { results: [] };
      },
      async searchContactByEmail(email) {
        return {
          id: "contact-42",
          email,
          properties: {
            firstname: "Nicolas",
            lastname: "Grenie",
            jobtitle: "Founder",
            twitterhandle: "picsoung",
            hs_linkedin_url: "https://www.linkedin.com/in/nicolas-grenie",
          },
          associatedCompanyIds: [],
          associatedDealIds: [],
        };
      },
      async getAssociatedCompanyIds() {
        return ["company-42"];
      },
      async getCompany() {
        return {
          id: "company-42",
          name: "found42",
          domain: "found42.com",
          properties: {},
        };
      },
      async getAssociatedDealIds() {
        return [];
      },
      async getDeal() {
        return null;
      },
      async getAssociatedDealIdsForCompany() {
        return [];
      },
    };
    const source = createHubSpotPersonProfileSource(() => api);

    const result = await source.collect({
      emails: ["nicolas@found42.com"],
      fullNames: ["Nicolas Grenie"],
      handles: { x: ["picsoung"] },
      profileUrls: [],
      employerHints: [],
    });

    expect(result.diagnostic).toEqual({ status: "completed", detail: "1 contact matched" });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source: "hubspot",
        kind: "employment",
        claims: {
          fullName: "Nicolas Grenie",
          role: "Founder",
          currentEmployer: "found42",
        },
        identitySignals: expect.objectContaining({
          emails: ["nicolas@found42.com"],
          fullNames: ["Nicolas Grenie"],
          handles: { x: ["picsoung"] },
          profileUrls: ["https://www.linkedin.com/in/nicolas-grenie"],
          employerHints: ["found42", "found42.com"],
        }),
      }),
    ]);
  });

  it("clears a resolved fact when high-confidence sources disagree", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "person-profile-conflict-"));
    let employer = "Acme";
    const source: PersonProfileSource = {
      id: "crm",
      async collect(signals) {
        return {
          candidates: [
            {
              source: "crm",
              kind: "employment",
              title: `${employer} employment record`,
              summary: `Taylor works at ${employer}.`,
              url: `https://crm.example/${employer.toLowerCase()}`,
              identitySignals: {
                emails: signals.emails,
                fullNames: ["Taylor Morgan"],
                handles: {},
                profileUrls: [],
                employerHints: [employer],
              },
              claims: { currentEmployer: employer },
            },
          ],
          diagnostic: { status: "completed", detail: "one employment record" },
        };
      },
    };
    const resolver = new PersonProfileResolver({
      store: new PersonProfileStore(workspaceDir),
      sources: [source],
      now: () => new Date("2026-08-31T16:00:00.000Z"),
    });
    const signals = {
      emails: ["taylor@example.com"],
      fullNames: ["Taylor Morgan"],
      handles: {},
      profileUrls: [],
      employerHints: [],
    };

    expect((await resolver.resolve(signals)).currentEmployer).toBe("Acme");
    employer = "Beta";
    expect((await resolver.resolve(signals)).currentEmployer).toBeNull();
  });

  it("searches public identity signals, treats LinkedIn as indexed evidence, and discovers declared feeds", async () => {
    const queries: string[] = [];
    const feedSites: string[] = [];
    const source = createPublicWebPersonProfileSource({
      search: async (query) => {
        queries.push(query);
        if (query.includes("site:linkedin.com")) {
          return [
            {
              title: "Nicolas Grenie - Founder at found42",
              url: "https://www.linkedin.com/in/nicolas-grenie",
              snippet: "Nicolas Grenie is the founder of found42.",
            },
          ];
        }
        if (query.includes("picsoung")) {
          return [
            {
              title: "picsoung (Nicolas Grenie)",
              url: "https://github.com/picsoung",
              snippet: "Public projects from Nicolas Grenie at found42.",
            },
          ];
        }
        if (query.includes("blog OR newsletter OR podcast")) {
          return [
            {
              title: "Nicolas Grenie",
              url: "https://nicolas.example/about",
              snippet: "Nicolas Grenie, founder at found42.",
            },
          ];
        }
        if (query.includes("interview OR article OR profile OR mention")) {
          return [
            {
              title: "Nicolas Grenie shares a product update",
              url: "https://x.com/picsoung/status/123456789",
              snippet: "Nicolas Grenie of found42 on building better research tools.",
            },
          ];
        }
        return [];
      },
      discoverFeeds: async (siteUrl) => {
        feedSites.push(siteUrl);
        return siteUrl.startsWith("https://nicolas.example")
          ? [{ url: "https://nicolas.example/feed.xml", title: "Nicolas Grenie's blog" }]
          : [];
      },
    });

    const result = await source.collect({
      emails: ["nicolas@found42.com"],
      fullNames: ["Nicolas Grenie"],
      handles: { github: ["picsoung"] },
      profileUrls: [],
      employerHints: ["found42"],
    });

    expect(queries).toContain('"nicolas@found42.com"');
    expect(queries).toContain('"Nicolas Grenie" site:linkedin.com');
    expect(queries).toContain('"picsoung"');
    expect(queries).toContain('"Nicolas Grenie" blog OR newsletter OR podcast');
    expect(feedSites).toContain("https://nicolas.example/about");
    expect(feedSites).not.toContain("https://www.linkedin.com/in/nicolas-grenie");
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "social-profile",
          url: "https://www.linkedin.com/in/nicolas-grenie",
        }),
        expect.objectContaining({
          kind: "social-profile",
          url: "https://github.com/picsoung",
        }),
        expect.objectContaining({
          kind: "feed",
          url: "https://nicolas.example/feed.xml",
        }),
        expect.objectContaining({
          kind: "publication",
          url: "https://x.com/picsoung/status/123456789",
        }),
      ]),
    );
    expect(result.diagnostic.status).toBe("completed");
  });
});
