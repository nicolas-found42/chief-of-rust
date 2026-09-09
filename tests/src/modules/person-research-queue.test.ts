import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test("queue coalesces creation requests and counts failed calls without deferring them to another day", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      throw new Error("Unavailable");
    },
    complete: async () => ({}),
  });
  let now = new Date("2026-09-05T12:00:00Z");
  const deps = { workspaceDir: root, people, research, now: () => now, enabled: () => true };
  const first = new PersonResearchQueue(deps);
  first.configure({ paused: false });
  first.enqueue(person.id, "created");
  first.enqueue(person.id, "meeting");
  const queue = new PersonResearchQueue(deps);
  expect(queue.status().jobs).toHaveLength(1);
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
  queue.enqueue(person.id, "explicit");
  await queue.tick();
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
  expect(queue.status().usedCalls).toBe(2);
  now = new Date("2026-09-06T12:00:00Z");
  await queue.tick();
  expect(queue.status().usedCalls).toBe(1);
  expect(queue.status().jobs[0]?.state).toBe("unavailable");
});
test("one named lookup returns one Profile's queue record", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    enabled: () => true,
  });
  queue.enqueue(person.id, "created");
  const job = queue.job(person.id);
  expect(job?.profileId).toBe(person.id);
  expect(job?.state).toBe("queued");
  /* The named lookup hands back the same record the status endpoint reports
     for this Profile, so the dossier view keeps its response shape. */
  expect(job).toEqual(queue.status().jobs.find((entry) => entry.profileId === person.id));
  /* And a clone: a caller holding the record cannot mutate the queue. */
  job!.state = "researching";
  expect(queue.job(person.id)?.state).toBe("queued");
  expect(queue.job("no-such-profile")).toBeNull();
});

test.each(["archive", "correction", "merge", "privacy", "pause", "gate", "stop", "evidence"])(
  "%s during retrieval prevents late research publication",
  async (change) => {
    const root = mkdtempSync(join(tmpdir(), "research-race-"));
    roots.push(root);
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({ primaryEmail: "maya@example.com" });
    const dossiers = new PersonDossierStore(root);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const research = new PersonResearch({
      dossiers,
      search: async () => {
        entered();
        await waiting;
        return [{ title: "Maya", url: "https://example.com/maya", snippet: "maya@example.com" }];
      },
      complete: async () => {
        throw new Error("Late model dispatch");
      },
    });
    let enabled = true;
    let evidence = "before";
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      enabled: () => enabled,
      evidenceRevision: () => evidence,
    });
    queue.enqueue(person.id, "created");
    const tick = queue.tick();
    await started;
    if (change === "archive") people.archive(person.id);
    if (change === "correction")
      people.correct(person.id, { role: "Director", note: "Owner correction" });
    if (change === "merge")
      people.merge(people.create({ fullName: "Survivor" }).id, { duplicateId: person.id });
    if (change === "privacy") people.privacyDelete(person.id, { confirmation: "DELETE PROFILE" });
    if (change === "pause") queue.configure({ paused: true });
    if (change === "gate") enabled = false;
    if (change === "stop") queue.stop();
    if (change === "evidence") evidence = "after deletion";
    release();
    await tick;
    expect(dossiers.get(person.id)).toBeNull();
    expect(queue.status().usedCalls).toBe(1);
  },
);

test("repeated enqueues and absent removes do not rewrite the queue state file", () => {
  const root = mkdtempSync(join(tmpdir(), "research-queue-quiet-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  const now = new Date("2026-09-05T12:00:00Z");
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => now,
    enabled: () => true,
  });
  queue.enqueue(person.id, "created");
  const stateFile = join(root, "person-research.json");
  const persisted = readFileSync(stateFile, "utf8");
  queue.enqueue(person.id, "meeting");
  expect(readFileSync(stateFile, "utf8")).not.toBe(persisted);
  const afterReason = readFileSync(stateFile, "utf8");
  queue.enqueue(person.id, "meeting");
  queue.enqueue(person.id, "meeting");
  expect(readFileSync(stateFile, "utf8")).toBe(afterReason);
  queue.remove("person_absent");
  expect(readFileSync(stateFile, "utf8")).toBe(afterReason);
});

test("resumes the retained document after interruption during extraction without repeating search or retrieval", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-continuation-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let searches = 0,
    retrievals = 0,
    extractions = 0;
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      searches += 1;
      return [
        { url: "https://example.com/stranger", title: "Different person", snippet: "" },
        { url: "https://example.com/maya", title: "Maya", snippet: "" },
      ];
    },
    fetch: async (url) => {
      retrievals += 1;
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url.endsWith("/stranger")
          ? "An unrelated stranger."
          : "maya@example.com built Atlas.",
      };
    },
    complete: async () => {
      extractions += 1;
      if (extractions === 1) {
        entered();
        await waiting;
      }
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const deps = { workspaceDir: root, people, research, enabled: () => true };
  const first = new PersonResearchQueue(deps);
  first.enqueue(person.id, "created");
  const work = first.tick();
  await started;
  expect(first.status().jobs[0].checkpoint?.pendingSourceId).toBeTruthy();
  first.stop();
  release();
  await work;
  const restarted = new PersonResearchQueue(deps);
  await restarted.tick();
  expect(searches).toBe(1);
  expect(retrievals).toBe(2);
  expect(extractions).toBe(2);
  /* `calls` counts model calls now that requests are bounded separately:
     one extraction before the interruption and one after it. */
  expect(restarted.status().jobs[0].calls).toBe(2);
  expect(restarted.status().jobs[0].elapsedMilliseconds).toBeGreaterThanOrEqual(0);
});

test("continuous research finishes pending extraction before daily rollover", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-daily-resume-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ primaryEmail: "maya@example.com" });
  let searches = 0,
    retrievals = 0,
    extractions = 0;
  let scope = "";
  let now = new Date("2026-09-05T12:00:00Z");
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => {
      searches++;
      return [{ url: "https://example.com/maya", title: "Maya", snippet: "" }];
    },
    fetch: async (url) => {
      retrievals++;
      return {
        url,
        status: 200,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "maya@example.com built Atlas.",
      };
    },
    complete: async (request) => {
      scope = JSON.parse(request.user).researchScope;
      extractions++;
      return {
        fullName: null,
        employer: null,
        sourceClass: "primary-artifact",
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    },
  });
  const deps = { workspaceDir: root, people, research, now: () => now, enabled: () => true };
  const queue = new PersonResearchQueue(deps);
  queue.configure({ profileCalls: 3 });
  queue.enqueue(person.id, "created");
  await queue.tick();
  const completed = queue.status().jobs[0];
  expect(completed.state).toBe("empty");
  /* A completed operation leaves no traversal behind: the next run is a
     refresh of changed evidence, not the second half of this one. */
  expect(completed.checkpoint).toBeUndefined();
  expect(completed.calls).toBe(1);
  now = new Date("2026-09-06T12:00:00Z");
  const restarted = new PersonResearchQueue(deps);
  await restarted.tick();
  expect(scope).toContain("Full historical");
  expect([searches, retrievals, extractions]).toEqual([1, 1, 1]);
  expect(restarted.status().jobs[0].calls).toBe(1);
  expect(restarted.status().usedCalls).toBe(0);
});

test("SIGKILL during extraction resumes durable evidence and remaining calls in a new process owner", async () => {
  const { fork } = await import("node:child_process");
  const { once } = await import("node:events");
  const root = mkdtempSync(join(tmpdir(), "research-process-crash-"));
  roots.push(root);
  const child = fork(new URL("../fixtures/person-research-crash.mts", import.meta.url), [root], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  try {
    await once(child, "message");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    let extractions = 0;
    const research = new PersonResearch({
      dossiers: new PersonDossierStore(root),
      search: async () => {
        throw new Error("Search must not restart");
      },
      fetch: async () => {
        throw new Error("Retrieval must not restart");
      },
      complete: async () => {
        extractions++;
        return {
          fullName: null,
          employer: null,
          sourceClass: "primary-artifact",
          author: null,
          publishedAt: null,
          claims: [],
          works: [],
          expertise: [],
          connections: [],
          sections: [],
        };
      },
    });
    const queue = new PersonResearchQueue({
      workspaceDir: root,
      people,
      research,
      enabled: () => true,
    });
    /* One model call was reserved before the process died; the retained
       document and that reservation both survive into the new owner. */
    expect(queue.status().jobs[0].calls).toBe(1);
    expect(queue.status().jobs[0].checkpoint?.pendingSourceId).toBeTruthy();
    await queue.tick();
    expect(extractions).toBe(1);
    expect(queue.status().jobs[0].calls).toBe(2);
    expect(queue.status().jobs[0].elapsedMilliseconds).toBeGreaterThan(0);
  } finally {
    child.kill("SIGKILL");
  }
});

test("aged backfill wins fairly while concurrent ticks enforce configured concurrency", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-fairness-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const older = people.create({ primaryEmail: "older@example.com" });
  let now = new Date("2026-09-05T08:00:00Z");
  const dispatched: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async (query) => {
      dispatched.push(query);
      await wait;
      return [];
    },
    complete: async () => ({}),
  });
  const queue = new PersonResearchQueue({
    workspaceDir: root,
    people,
    research,
    now: () => now,
    enabled: () => true,
  });
  queue.configure({ concurrency: 1 });
  queue.enqueue(older.id, "backfill");
  now = new Date("2026-09-05T12:00:00Z");
  const meeting = people.create({ primaryEmail: "meeting@example.com" });
  queue.enqueue(meeting.id, "meeting");
  const first = queue.tick();
  await queue.tick();
  expect(dispatched).toEqual(["older@example.com"]);
  expect(queue.status().usedCalls).toBe(1);
  release();
  await first;
  expect(queue.status().jobs.find((job) => job.profileId === meeting.id)?.calls).toBe(0);
});

test("a save merges a concurrent instance's jobs", () => {
  /* One Workspace can carry several queue instances at once — the benchmark
     researches fixed-document people concurrently (#233) — and each holds the
     snapshot it loaded. A save merges with the file so neither instance drops
     the other's jobs. */
  const { root, deps, kept, dropped } = shared("merge");
  const first = new PersonResearchQueue(deps);
  const second = new PersonResearchQueue(deps);
  /* Both loaded the empty file before either wrote. */
  first.enqueue(kept.id, "explicit");
  second.enqueue(dropped.id, "explicit");
  expect(onDisk(root).sort()).toEqual([kept.id, dropped.id].sort());
});

test.each(["the instance that removed it", "an instance still holding it"])(
  "a removal survives a later save by %s",
  (saver) => {
    /* A merge must never undo a deletion, and the two directions fail
       differently. The remover must not read its own deleted job back from a
       snapshot written before the removal. A concurrent instance must not
       re-add a job it still holds but the file no longer has — that job was
       deleted by someone else, and a stale snapshot is not grounds to
       resurrect it. Privacy deletion depends on both. */
    const { root, deps, kept, dropped } = shared("removal");
    const remover = new PersonResearchQueue(deps);
    remover.enqueue(kept.id, "explicit");
    remover.enqueue(dropped.id, "explicit");
    /* Loads with both jobs, so it holds the one about to be deleted. */
    const stale = new PersonResearchQueue(deps);
    expect(onDisk(root).sort()).toEqual([kept.id, dropped.id].sort());

    remover.remove(dropped.id);
    expect(onDisk(root)).toEqual([kept.id]);

    /* Any unrelated change is enough to trigger the merge. */
    (saver === "the instance that removed it" ? remover : stale).configure({ paused: true });
    expect(onDisk(root)).toEqual([kept.id]);
  },
);

/** One Workspace, two Profiles, and the deps every queue instance shares. */
function shared(label: string) {
  const root = mkdtempSync(join(tmpdir(), `research-queue-${label}-`));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const kept = people.create({ primaryEmail: "kept@example.com" });
  const dropped = people.create({ primaryEmail: "dropped@example.com" });
  const research = new PersonResearch({
    dossiers: new PersonDossierStore(root),
    search: async () => [],
    complete: async () => ({}),
  });
  return {
    root,
    kept,
    dropped,
    deps: { workspaceDir: root, people, research, enabled: () => true },
  };
}

function onDisk(root: string): string[] {
  const state = JSON.parse(readFileSync(join(root, "person-research.json"), "utf8")) as {
    jobs: { profileId: string }[];
  };
  return state.jobs.map((job) => job.profileId);
}
