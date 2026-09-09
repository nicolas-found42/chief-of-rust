import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store";
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import {
  PersonDossierPanel,
  type DossierClient,
} from "../../../apps/web/src/pages/PersonDossierPanel";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
test("a public-only person has a separate empty Relationship history tab while research is queued", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = makeClient();

  try {
    await act(async () => {
      root.render(createElement(PersonDossierPanel, { profileId: "maya", client }));
    });
    expect(container.textContent).toContain("Queued");
    const history = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Relationship history",
    )!;
    await act(async () => {
      history.click();
    });
    expect(container.textContent).toContain("No confirmed Workspace history yet");
    expect(container.textContent).not.toContain("What has this person actually built");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function makeClient(): DossierClient {
  return {
    read: async () => ({
      dossier: null,
      research: {
        profileId: "maya",
        state: "queued",
        reasons: ["created"],
        queuedAt: "2026-09-05",
        updatedAt: "2026-09-05",
        nextAt: "2026-09-05",
        calls: 0,
        sources: 0,
        attempts: 0,
        detail: "Waiting for automatic research.",
      },
    }),
    source: async () => {
      throw new Error("No source requested");
    },
    history: async () => [],
    analysis: async () => null,
    research: async () => {},
    detach: async () => {},
    settings: async () => ({
      schemaVersion: 1,
      day: "2026-09-05",
      usedCalls: 0,
      jobs: [],
      settings: {
        paused: false,
        concurrency: 1,
        profileCalls: 18,
        profileMilliseconds: 900000,
        readConcurrency: 4,
        requestTimeoutMilliseconds: 20000,
        quietRounds: 2,
        refreshHours: 168,
      },
    }),
    configure: async () => {},
  };
}

test.each(["supported", "contested"] as const)(
  "private-only %s evidence stays inspectable without inventing public history",
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), "dossier-ui-"));
    const store = new PersonDossierStore(directory);
    const document = store.retainSource({
      url: "transcript:private",
      title: "Private conversation",
      author: null,
      publishedAt: null,
      retrievedAt: "2026-09-05",
      text: "Maya built the scheduler.",
      family: "workspace",
      sourceClass: "workspace",
      visibility: "private",
      completeness: "full",
      extractionCoverage: "full",
      access: "retrieved",
      acquisition: "workspace",
    });
    const dossier = store.publish("maya", 0, {
      sourceIds: [document.id],
      claims: [
        {
          id: "claim",
          section: "work",
          statement: document.text,
          status,
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: null,
          effectiveTo: null,
          citations: [{ sourceId: document.id, quote: document.text }],
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
    const client = makeClient();
    client.read = async () => ({ dossier, research: null });
    client.source = async () => document;
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(PersonDossierPanel, { profileId: "maya", client })),
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Sources")!
          .click(),
      );
      expect(container.textContent).toContain(document.text);
      if (status === "contested")
        expect(container.textContent.toLowerCase()).toContain("contested");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Inspect retained source 1")!
          .click(),
      );
      expect(container.querySelector('[aria-label="Retained source"]')?.textContent).toContain(
        "private",
      );
      expect(container.querySelector('[aria-label="Retained source"]')?.textContent).toContain(
        document.text,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a claim grounded in an archived capture shows the capture date and its bounded period", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dossier-capture-ui-"));
  const store = new PersonDossierStore(directory);
  const source = store.retainSource({
    url: "https://web.archive.org/web/20240523200341/https://bank.example/past/shafik",
    title: "Past people biography",
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-07",
    capturedAt: "2024-05-23T20:03:41.000Z",
    text: "Deputy Governor, Markets and Banking between 2014 and 2017.",
    family: "bank.example",
    sourceClass: "self-report",
    visibility: "public",
    completeness: "full",
    extractionCoverage: "full",
    access: "retrieved",
    acquisition: "wayback-capture",
  });
  const dossier = store.publish("shafik", 0, {
    sourceIds: [source.id],
    claims: [
      {
        id: "tenure",
        section: "career",
        statement: source.text,
        fact: { field: "role", value: "Deputy Governor, Markets and Banking" },
        status: "stale",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: "2014-08-01",
        effectiveTo: "2024-05-23",
        citations: [{ sourceId: source.id, quote: source.text, capturedAt: source.capturedAt }],
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
  const client = makeClient();
  client.read = async () => ({ dossier, research: null });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(PersonDossierPanel, { profileId: "shafik", client })),
    );
    /* The reader sees a former role as former, dated by the capture, without
       having to open the retained source behind it. */
    expect(container.textContent).toContain("archived capture 2024-05-23");
    expect(container.textContent).toContain("2014-08-01 to 2024-05-23");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    rmSync(directory, { recursive: true, force: true });
  }
});
