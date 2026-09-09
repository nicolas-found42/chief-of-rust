import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

test("stable URL addition creates once without web access and deleted identities cannot be recreated", () => {
  const root = mkdtempSync(join(tmpdir(), "person-entry-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const created = people.ensureIdentifier("https://github.com/maya");
    expect(created.profileUrls).toEqual(["https://github.com/maya"]);
    expect(people.ensureIdentifier("https://github.com/maya").id).toBe(created.id);
    people.privacyDelete(created.id, { confirmation: "DELETE PROFILE" });
    expect(() => people.ensureIdentifier("https://github.com/maya")).toThrow(/deleted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dated primary evidence can supersede a manual role correction while retaining its revision", () => {
  const root = mkdtempSync(join(tmpdir(), "person-authority-"));
  try {
    let now = new Date("2026-09-05T00:00:00Z");
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
      now: () => now,
    });
    const person = people.create({
      fullName: "Maya",
      primaryEmail: "maya@example.com",
      role: "Engineer",
    });
    people.correct(person.id, { role: "Director", note: "My correction" });
    now = new Date("2026-09-07T00:00:00Z");
    expect(
      people.acceptResearchFacts(person.id, 2, [
        {
          field: "role",
          value: "CTO",
          sourceIds: ["official-appointment"],
          effectiveFrom: "2026-09-06",
          authority: "primary-artifact",
          reason: "The official appointment documents the new role effective 6 September.",
        },
      ])?.role,
    ).toBe("CTO");
    expect(people.getRevision(person.id, 2)?.role).toBe("Director");
    expect(people.invalidations(person.id).at(-1)?.detail).toContain("official-appointment");
    expect(
      people.acceptResearchFacts(person.id, 3, [
        {
          field: "role",
          value: "CEO",
          sourceIds: ["bio"],
          effectiveFrom: null,
          authority: "self-report",
          reason: "Retrieved today",
        },
      ])?.role,
    ).toBe("CTO");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dated primary-artifact fact can supersede a manual correction that was wrong when recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "person-authority-"));
  try {
    const now = new Date("2026-09-05T00:00:00Z");
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
      now: () => now,
    });
    const person = people.create({
      fullName: "Maya",
      primaryEmail: "maya@example.com",
      role: "Engineer",
    });
    people.correct(person.id, { role: "Director", note: "A mistaken correction" });
    expect(people.get(person.id)?.role).toBe("Director");
    expect(
      people.acceptResearchFacts(person.id, 2, [
        {
          field: "role",
          value: "Engineer",
          sourceIds: ["official-record"],
          effectiveFrom: "2025-01-01",
          authority: "primary-artifact",
          reason: "The official appointment record shows the role never changed.",
        },
      ])?.role,
    ).toBe("Engineer");
    expect(people.getRevision(person.id, 2)?.role).toBe("Director");
    expect(people.invalidations(person.id).at(-1)?.detail).toContain("official-record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy deletion prevents recreation through a secondary profile URL", () => {
  const root = mkdtempSync(join(tmpdir(), "person-alias-delete-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({
      primaryEmail: "maya@example.com",
      profileUrls: ["https://example.com/maya"],
    });
    people.privacyDelete(person.id, { confirmation: "DELETE PROFILE" });
    expect(() => people.ensureIdentifier("https://example.com/maya")).toThrow(/deleted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
