import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  PersonDossierStore,
  synthesizeSections,
} from "../../../apps/server/src/person-profile/dossier-store.js";

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "dossier-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("retained source versions and grounded claims survive a restart without copying text into the dossier", () => {
  const root = workspace();
  const store = new PersonDossierStore(root);
  const source = store.retainSource({
    url: "https://example.com/launch",
    title: "Launch",
    author: null,
    publishedAt: "2024-02-01",
    retrievedAt: "2026-09-05T00:00:00Z",
    text: "Maya designed the scheduler. The team shipped Atlas to 200 sites.",
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "website",
  });
  store.publish("maya", 0, {
    claims: [
      {
        id: "contribution",
        section: "work",
        statement: "Maya designed the scheduler",
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: "2024-02-01",
        effectiveTo: null,
        citations: [{ sourceId: source.id, quote: "Maya designed the scheduler." }],
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
  const restarted = new PersonDossierStore(root);
  expect(restarted.get("maya")?.claims[0]?.citations[0]?.sourceId).toBe(source.id);
  expect(restarted.source("maya", source.id)?.text).toContain("200 sites");
  expect(JSON.stringify(restarted.get("maya"))).not.toContain("The team shipped Atlas");
  expect(() =>
    store.publish("maya", 1, {
      claims: [
        {
          ...restarted.get("maya")!.claims[0],
          citations: [{ sourceId: source.id, quote: "Maya led 200 people" }],
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  ).toThrow(/passage/i);
  expect(restarted.get("maya")?.revision).toBe(1);
});

test("source revisions are immutable and privacy deletion removes every person association", () => {
  const root = workspace();
  const store = new PersonDossierStore(root);
  const input = {
    url: "https://example.com/bio",
    title: "Biography",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05T00:00:00Z",
    text: "Maya works on compilers.",
    family: "example.com",
    sourceClass: "self-report" as const,
    visibility: "public" as const,
    completeness: "full" as const,
    access: "retrieved" as const,
    acquisition: "website",
  };
  const original = store.retainSource(input);
  expect(store.retainSource({ ...input, retrievedAt: "2026-09-06T00:00:00Z" }).id).toBe(
    original.id,
  );
  const changed = store.retainSource({ ...input, text: "Maya previously worked on compilers." });
  expect(changed.id).not.toBe(original.id);
  store.publish("maya", 0, {
    claims: [
      {
        id: "focus",
        section: "career",
        statement: input.text,
        status: "claimed",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: original.id, quote: input.text }],
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
  expect(store.privacyDelete("maya")).toEqual([original.id]);
  const restarted = new PersonDossierStore(root);
  expect(restarted.get("maya")).toBeNull();
  expect(restarted.source("maya", original.id)).toBeNull();
  expect(() =>
    restarted.publish("maya", 0, {
      claims: [],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  ).toThrow(/deleted/i);
});

test("removing a private source purges dependent interpretations and work while retaining independent public claims", () => {
  const store = new PersonDossierStore(workspace());
  const base = {
    title: "Record",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05T00:00:00Z",
    family: "original",
    completeness: "full" as const,
    access: "retrieved" as const,
    acquisition: "test",
  };
  const publicSource = store.retainSource({
    ...base,
    url: "https://example.com/work",
    text: "Maya built Atlas.",
    visibility: "public",
    sourceClass: "primary-artifact",
  });
  const privateSource = store.retainSource({
    ...base,
    url: "transcript:meeting1",
    text: "Maya recommended the migration.",
    visibility: "private",
    sourceClass: "workspace",
    transcriptId: "meeting1",
  });
  const claim = {
    section: "work" as const,
    status: "supported" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    supports: [],
    supersedes: [],
    changeReason: null,
  };
  store.publish("maya", 0, {
    claims: [
      {
        ...claim,
        id: "public",
        statement: "Built Atlas",
        citations: [{ sourceId: publicSource.id, quote: publicSource.text }],
      },
      {
        ...claim,
        id: "private",
        statement: "Recommended migration",
        citations: [{ sourceId: privateSource.id, quote: privateSource.text }],
      },
      {
        ...claim,
        id: "inference",
        nature: "interpretation",
        statement: "Works across systems and migration",
        supports: ["private", "public"],
        citations: [{ sourceId: publicSource.id, quote: publicSource.text }],
      },
    ],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  expect(store.project("maya", "public")?.claims.map((c) => c.id)).toEqual(["public"]);
  store.removeTranscript("meeting1");
  expect(store.get("maya")?.claims.map((c) => c.id)).toEqual(["public"]);
  expect(store.source("maya", privateSource.id)).toBeNull();
});

test("a claim cited by both a surviving public source and a purged transcript keeps its independent support", () => {
  const store = new PersonDossierStore(workspace());
  const base = {
    title: "Record",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05T00:00:00Z",
    family: "original",
    completeness: "full" as const,
    access: "retrieved" as const,
    acquisition: "test",
  };
  const publicSource = store.retainSource({
    ...base,
    url: "https://example.com/work",
    text: "Maya built Atlas.",
    visibility: "public",
    sourceClass: "primary-artifact",
  });
  const privateSource = store.retainSource({
    ...base,
    url: "transcript:meeting9",
    text: "Maya recommended the migration.",
    visibility: "private",
    sourceClass: "workspace",
    transcriptId: "meeting9",
  });
  const claim = {
    section: "work" as const,
    status: "supported" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    supports: [],
    supersedes: [],
    changeReason: null,
  };
  store.publish("maya", 0, {
    claims: [
      {
        ...claim,
        id: "mixed",
        statement: "Built Atlas and recommended the migration",
        citations: [
          { sourceId: publicSource.id, quote: publicSource.text },
          { sourceId: privateSource.id, quote: privateSource.text },
        ],
      },
    ],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  store.removeTranscript("meeting9");
  const surviving = store.get("maya")?.claims ?? [];
  expect(surviving.map((c) => c.id)).toEqual(["mixed"]);
  expect(surviving[0]?.citations.map((c) => c.sourceId)).toEqual([publicSource.id]);
  expect(store.project("maya", "public")?.claims.map((c) => c.id)).toEqual(["mixed"]);
});

test("merge retains grounded records on the survivor and removes the duplicate dossier", () => {
  const store = new PersonDossierStore(workspace());
  store.publish("duplicate", 0, {
    claims: [
      {
        id: "unknown",
        section: "context",
        statement: "Working language is unknown",
        status: "unknown",
        nature: "statement",
        matchConfidence: "low",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [],
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
  store.merge("survivor", "duplicate");
  expect(store.get("survivor")?.claims[0]?.statement).toBe("Working language is unknown");
  expect(store.get("duplicate")).toBeNull();
});

test("merge rebuilds the survivor's sections from the merged claims and keeps one copy of identical expertise", () => {
  const store = new PersonDossierStore(workspace());
  const source = store.retainSource({
    url: "https://example.com/work",
    title: "Work",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05",
    text: "Maya built Atlas.",
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "website",
  });
  const claim = (id: string) => ({
    id,
    section: "work" as const,
    statement: `${id}: Maya built Atlas.`,
    status: "supported" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    citations: [{ sourceId: source.id, quote: source.text }],
    supports: [],
    supersedes: [],
    changeReason: null,
  });
  const expertise = {
    category: "rust",
    originalWording: "systems programming",
    support: "claimed" as const,
    workIds: [],
    claimIds: ["d"],
  };
  store.publish("survivor", 0, {
    claims: [claim("s")],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  store.publish("duplicate", 0, {
    claims: [claim("d")],
    works: [],
    expertise: [expertise],
    connections: [],
    sections: [],
  });
  store.merge("survivor", "duplicate");
  const survivor = store.get("survivor")!;
  expect(survivor.sections.map((s) => s.key)).toHaveLength(8);
  const work = survivor.sections.find((s) => s.key === "work")!;
  expect(work.claimIds).toHaveLength(2);
  expect(work.state).toBe("incomplete");
  expect(work.claimIds).toEqual(expect.arrayContaining(["s", "d"]));
  expect(survivor.expertise).toEqual([expertise]);
  expect(store.get("duplicate")).toBeNull();
});

test("detaching a wrongly attributed source rejects future publication from that source", () => {
  const store = new PersonDossierStore(workspace());
  const source = store.retainSource({
    url: "https://example.com/wrong-maya",
    title: "Maya",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05",
    text: "Maya built a compiler.",
    family: "example.com",
    sourceClass: "self-report",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "website",
  });
  const content = {
    claims: [
      {
        id: "c",
        section: "work" as const,
        statement: source.text,
        status: "claimed" as const,
        nature: "statement" as const,
        matchConfidence: "high" as const,
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: source.id, quote: source.text }],
        supports: [],
        supersedes: [],
        changeReason: null,
      },
    ],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  };
  store.publish("maya", 0, content);
  store.detach("maya", source.id);
  expect(store.get("maya")?.claims).toEqual([]);
  expect(() => store.publish("maya", 2, content)).toThrow(/rejected attribution/i);
});

test("detaching a source removes same-text mirrors instead of failing the detach", () => {
  const store = new PersonDossierStore(workspace());
  const input = {
    url: "https://original.example/work",
    title: "Work",
    author: "Maya",
    publishedAt: "2024-01-01",
    retrievedAt: "2026-09-05",
    text: "Maya wrote the Atlas compiler.",
    family: "original.example",
    sourceClass: "primary-artifact" as const,
    visibility: "public" as const,
    completeness: "full" as const,
    access: "retrieved" as const,
    acquisition: "website",
  };
  const original = store.retainSource(input);
  const mirror = store.retainSource({
    ...input,
    url: "https://mirror.example/work",
    family: "mirror.example",
  });
  const claim = (id: string, source: { id: string }) => ({
    id,
    section: "work" as const,
    statement: input.text,
    status: "supported" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    citations: [{ sourceId: source.id, quote: input.text }],
    supports: [],
    supersedes: [],
    changeReason: null,
  });
  store.publish("maya", 0, {
    claims: [claim("original", original), claim("mirror", mirror)],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  store.detach("maya", original.id);
  expect(store.get("maya")?.claims).toEqual([]);
  expect(() =>
    store.publish("maya", 2, {
      claims: [claim("again", mirror)],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  ).toThrow(/rejected attribution/i);
});

test("identical mirrored source text is one independent source family", () => {
  const store = new PersonDossierStore(workspace());
  const input = {
    url: "https://original.example/work",
    title: "Work",
    author: "Maya",
    publishedAt: "2024-01-01",
    retrievedAt: "2026-09-05",
    text: "Maya wrote the Atlas compiler.",
    family: "original.example",
    sourceClass: "primary-artifact" as const,
    visibility: "public" as const,
    completeness: "full" as const,
    access: "retrieved" as const,
    acquisition: "website",
  };
  const original = store.retainSource(input);
  const mirror = store.retainSource({
    ...input,
    url: "https://mirror.example/work",
    family: "mirror.example",
  });
  expect(mirror.family).toBe(original.family);
});

test("exact dossier revisions remain readable until a source is detached or the person is deleted", () => {
  const store = new PersonDossierStore(workspace());
  const source = store.retainSource({
    url: "https://example.com/history",
    title: "History",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-05",
    text: "Maya built Atlas.",
    family: "example.com",
    sourceClass: "primary-artifact",
    visibility: "public",
    completeness: "full",
    access: "retrieved",
    acquisition: "website",
  });
  const claim = {
    id: "c",
    section: "work" as const,
    statement: source.text,
    status: "supported" as const,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    citations: [{ sourceId: source.id, quote: source.text }],
    supports: [],
    supersedes: [],
    changeReason: null,
  };
  store.publish("maya", 0, {
    claims: [claim],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  store.publish("maya", 1, {
    claims: [{ ...claim, status: "contested" }],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  });
  expect(store.getRevision("maya", 1)?.claims[0]?.status).toBe("supported");
  store.detach("maya", source.id);
  expect(store.getRevision("maya", 1)?.claims).toEqual([]);
  store.privacyDelete("maya");
  expect(store.getRevision("maya", 2)).toBeNull();
});

test("unrelated current evidence does not refresh an unchanged historical section", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const store = new PersonDossierStore(workspace());
    const source = store.retainSource({
      url: "https://example.com/history",
      title: "History",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-01",
      text: "Maya was an engineer. Maya is preparing a launch.",
      family: "example.com",
      sourceClass: "primary-artifact",
      visibility: "public",
      completeness: "full",
      access: "retrieved",
      acquisition: "website",
    });
    const claim = {
      id: "career",
      section: "career" as const,
      statement: "Maya was an engineer.",
      status: "supported" as const,
      nature: "statement" as const,
      matchConfidence: "high" as const,
      effectiveFrom: "2024",
      effectiveTo: "2025",
      citations: [{ sourceId: source.id, quote: "Maya was an engineer." }],
      supports: [],
      supersedes: [],
      changeReason: null,
    };
    const first = store.publish("maya", 0, {
      claims: [claim],
      works: [],
      expertise: [],
      connections: [],
      sections: synthesizeSections([claim]),
    });
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const current = {
      ...claim,
      id: "current",
      section: "context" as const,
      statement: "Maya is preparing a launch.",
      effectiveFrom: null,
      effectiveTo: null,
      citations: [{ sourceId: source.id, quote: "Maya is preparing a launch." }],
    };
    const next = store.publish("maya", 1, {
      ...first,
      claims: [claim, current],
      sections: synthesizeSections([claim, current]),
    });
    expect(next.sections.find((section) => section.key === "career")?.updatedAt).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(next.sections.find((section) => section.key === "context")?.updatedAt).toBe(
      "2026-09-05T00:00:00.000Z",
    );
    expect(next.sections.find((section) => section.key === "ideas")?.updatedAt).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
