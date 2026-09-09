import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  ContentResearchBaseline,
  ContentResearchScheduleState,
  NamedPerson,
  PersonProfileDependentConfiguration,
  PersonSuggestion,
  SourceItem,
} from "@chief-of-staff-demo/shared";

interface ContentResearchLedgerRef {
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
}

/**
 * What a feed told us last time, so the next fetch can be conditional. Keyed by
 * the URL the validators belong to, because Source Targets are re-derived from
 * a Person's hints each Run and carry no identity across Runs.
 */
interface ContentResearchCollectionState {
  url: string;
  checkpoint: string | null;
  conditional: { etag: string | null; lastModified: string | null } | null;
  lastSuccessfulAt: string;
}

interface ContentResearchState {
  people: NamedPerson[];
  suggestions: PersonSuggestion[];
  baselines: ContentResearchBaseline[];
  schedule: ContentResearchScheduleState;
  ledger: ContentResearchLedgerRef;
  collection: ContentResearchCollectionState[];
}

const EMPTY: ContentResearchState = {
  people: [],
  suggestions: [],
  baselines: [],
  collection: [],
  schedule: {
    lastSuccessfulDailyPeriod: null,
    lastSuccessfulDiscoveryPeriod: null,
    lastDailyCheckpoint: null,
  },
  ledger: { spreadsheetId: null, spreadsheetUrl: null },
};

function identifier(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "");
  return `${prefix}_${stamp}_${randomBytes(4).toString("hex")}`;
}

/** The distinct site origins a set of URLs points at; unparseable URLs are not sites. */
function originsOf(urls: string[]): string[] {
  const origins = new Set<string>();
  for (const value of urls) {
    try {
      origins.add(`${new URL(value).origin}/`);
    } catch {
      // a supporting reference that is not a URL is not a site either
    }
  }
  return [...origins];
}

export class ContentResearchStore {
  private readonly root: string;
  private readonly stateFile: string;
  private readonly itemsDir: string;

  constructor(
    workspaceDir: string,
    private readonly now: () => Date,
  ) {
    this.root = join(workspaceDir, "content-research");
    this.stateFile = join(this.root, "people.json");
    this.itemsDir = join(this.root, "items");
  }

  private readState(): ContentResearchState {
    if (!existsSync(this.stateFile)) return structuredClone(EMPTY);
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<ContentResearchState>;
      return {
        /* Rows persisted before #134 carry neither profileId nor pausedAt;
           normalizing on read keeps an upgraded Workspace watching. */
        people: (Array.isArray(parsed.people) ? parsed.people : []).map((person) => {
          const record = person as Partial<NamedPerson>;
          return {
            ...person,
            profileId: record.profileId ?? "",
            pausedAt: record.pausedAt ?? null,
          };
        }),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        baselines: Array.isArray(parsed.baselines) ? parsed.baselines : [],
        collection: Array.isArray(parsed.collection) ? parsed.collection : [],
        schedule: parsed.schedule ?? structuredClone(EMPTY.schedule),
        ledger: parsed.ledger ?? structuredClone(EMPTY.ledger),
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private writeState(state: ContentResearchState): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.stateFile);
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  }

  // Named People

  addPerson(input: {
    profileId: string;
    name: string;
    handleHints?: NamedPerson["handleHints"];
    discoveredSourceTargets?: NamedPerson["discoveredSourceTargets"];
  }): NamedPerson {
    if (!input.profileId) throw new Error("A Named Person requires the profileId it is backed by.");
    const state = this.readState();
    /* The confirmed Profile identity is the watch's key: watching the same
       Profile twice returns the existing watch. */
    const existing = state.people.find(
      (p) => p.profileId === input.profileId && p.archivedAt === null,
    );
    if (existing) return existing;
    const person: NamedPerson = {
      id: identifier("person", this.now()),
      profileId: input.profileId,
      name: input.name,
      pausedAt: null,
      handleHints: {
        ...input.handleHints,
        blogRssHints: input.handleHints?.blogRssHints ?? [],
      },
      discoveredSourceTargets: input.discoveredSourceTargets ?? [],
      createdAt: this.now().toISOString(),
      archivedAt: null,
    };
    state.people.push(person);
    this.writeState(state);
    return person;
  }

  /** The watchlist: neither archived nor paused. Paused is lifecycle state —
      the configuration stays and the watch simply collects nothing. */
  listPeople(): NamedPerson[] {
    return this.readState().people.filter((p) => p.archivedAt === null && p.pausedAt === null);
  }

  listAllPeople(): NamedPerson[] {
    return this.readState().people;
  }

  /** The stored validators for a URL, or null when it has never been fetched. */
  getCollectionState(url: string): {
    checkpoint: string | null;
    conditional: ContentResearchCollectionState["conditional"];
  } | null {
    const found = this.readState().collection.find((entry) => entry.url === url);
    return found ? { checkpoint: found.checkpoint, conditional: found.conditional } : null;
  }

  /** Remember what a successful fetch reported, so the next one can be conditional. */
  recordCollectionSuccess(
    url: string,
    checkpoint: string | null,
    conditional: ContentResearchCollectionState["conditional"],
  ): void {
    const state = this.readState();
    const existing = state.collection.find((entry) => entry.url === url);
    const lastSuccessfulAt = this.now().toISOString();
    if (existing) {
      existing.checkpoint = checkpoint;
      existing.conditional = conditional;
      existing.lastSuccessfulAt = lastSuccessfulAt;
    } else {
      state.collection.push({ url, checkpoint, conditional, lastSuccessfulAt });
    }
    this.writeState(state);
  }

  getPerson(id: string): NamedPerson | null {
    return this.readState().people.find((p) => p.id === id) ?? null;
  }

  /** A paused watch keeps its Profile reference and configuration; the Profile
      lifecycle surfaces it as a paused dependent configuration (#134). */
  pausePerson(id: string): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    if (person.pausedAt === null) person.pausedAt = this.now().toISOString();
    this.writeState(state);
    return person;
  }

  resumePerson(id: string): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    if (person.archivedAt !== null)
      throw new Error(`Named Person ${id} is archived and cannot be resumed.`);
    person.pausedAt = null;
    this.writeState(state);
    return person;
  }

  /** The re-point action a paused watch discloses (#134): the watch attaches
      to a different confirmed Profile and stays paused until resumed. */
  repointPerson(id: string, profileId: string): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    if (person.archivedAt !== null)
      throw new Error(`Named Person ${id} is archived and cannot be re-pointed.`);
    if (person.pausedAt === null)
      throw new Error(`Named Person ${id} is active — pause it before re-pointing.`);
    person.profileId = profileId;
    this.writeState(state);
    return person;
  }

  archivePerson(id: string): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    person.archivedAt = this.now().toISOString();
    this.writeState(state);
    return person;
  }

  updatePersonSourceTargets(
    id: string,
    discovered: NamedPerson["discoveredSourceTargets"],
  ): NamedPerson {
    const state = this.readState();
    const person = state.people.find((p) => p.id === id);
    if (!person) throw new Error(`Named Person not found: ${id}`);
    person.discoveredSourceTargets = discovered;
    this.writeState(state);
    return person;
  }

  // Suggestions

  listSuggestions(): PersonSuggestion[] {
    return this.readState().suggestions;
  }

  saveSuggestions(
    proposals: Omit<
      PersonSuggestion,
      "id" | "state" | "discoveredAt" | "decidedAt" | "decisionReason"
    >[],
  ): PersonSuggestion[] {
    const state = this.readState();
    const blockedNames = new Set([
      ...state.people.map((p) => p.name.toLowerCase()),
      ...state.suggestions.filter((s) => s.state === "dismissed").map((s) => s.name.toLowerCase()),
    ]);
    const added: PersonSuggestion[] = [];
    for (const proposal of proposals) {
      /* A Person Suggestion is blocked by name: already watched, or dismissed
         and not yet restored (spec #116 story 23). Restoring clears the block
         because the suggestion returns to pending. */
      if (blockedNames.has(proposal.name.toLowerCase())) continue;
      const suggestion: PersonSuggestion = {
        ...proposal,
        id: identifier("suggestion", this.now()),
        state: "pending",
        discoveredAt: this.now().toISOString(),
        decidedAt: null,
        decisionReason: null,
      };
      state.suggestions.push(suggestion);
      added.push(suggestion);
      blockedNames.add(proposal.name.toLowerCase());
    }
    if (added.length > 0) this.writeState(state);
    return added;
  }

  decideSuggestion(
    id: string,
    decision: "approved" | "dismissed" | "pending",
    reason: string | null,
    /** Required when approving: the confirmed Profile the watch will be
        backed by. A name-only approval creates nothing (#134). */
    profileId?: string,
  ): PersonSuggestion {
    const state = this.readState();
    const suggestion = state.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error(`Person Suggestion not found: ${id}`);
    if (decision === "approved") {
      if (!profileId)
        throw new Error(
          "Approving a Person Suggestion requires a confirmed profileId before the watch is created.",
        );
      const exists = state.people.find((p) => p.profileId === profileId && p.archivedAt === null);
      if (!exists) {
        /* The sites behind the supporting URLs are what the suggestion actually
           evidenced, so the approved person starts watched on them. Their feeds
           are resolved separately, by fetching each site (spec #116 story 24). */
        const person: NamedPerson = {
          id: identifier("person", this.now()),
          profileId,
          name: suggestion.name,
          pausedAt: null,
          handleHints: { blogRssHints: [] },
          discoveredSourceTargets: originsOf(suggestion.supportingUrls).map((url) => ({
            adapterId: "website",
            url,
            label: `${suggestion.name} website`,
          })),
          createdAt: this.now().toISOString(),
          archivedAt: null,
        };
        state.people.push(person);
      }
      /* The operator's own reason stands when given; the default records the
         Profile the watch was created on. */
      suggestion.decisionReason = reason ?? `Watch created on Person Profile ${profileId}.`;
    } else {
      suggestion.decisionReason = reason;
    }
    suggestion.state = decision;
    suggestion.decidedAt = this.now().toISOString();
    this.writeState(state);
    return suggestion;
  }

  restoreSuggestion(id: string): PersonSuggestion {
    const state = this.readState();
    const suggestion = state.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error(`Person Suggestion not found: ${id}`);
    if (suggestion.state !== "dismissed")
      throw new Error(`Only dismissed suggestions can be restored`);
    suggestion.state = "pending";
    suggestion.decidedAt = null;
    suggestion.decisionReason = null;
    this.writeState(state);
    return suggestion;
  }

  /**
   * This Module's share of the Profile lifecycle registry (#134): every watch
   * that points at a Profile is a dependent configuration the operator must
   * resolve before archiving or privacy-deleting that Profile. A live watch is
   * active and can be paused; a paused one is resolved by re-pointing it at a
   * different Profile.
   */
  watchReferences(): PersonProfileDependentConfiguration[] {
    return this.readState()
      .people.filter((p) => p.archivedAt === null && p.profileId)
      .map((person) => ({
        id: `content-research-watch:${person.id}`,
        consumer: "content-research",
        label: `Content Research watch — ${person.name}`,
        profileId: person.profileId,
        state: person.pausedAt === null ? "active" : "paused",
        availableActions: person.pausedAt === null ? (["pause"] as const) : (["repoint"] as const),
      }));
  }

  /**
   * Privacy deletion's purge of this Module's share: a watch cannot exist
   * without the Profile it is backed by, so the reference is removed by
   * archiving the watch. The watch's name came from the public-safe
   * projection and stays as the archive's audit record.
   */
  removeProfileReferences(profileId: string): number {
    const state = this.readState();
    let removed = 0;
    for (const person of state.people) {
      if (person.profileId !== profileId || person.archivedAt !== null) continue;
      person.archivedAt = this.now().toISOString();
      removed += 1;
    }
    if (removed > 0) this.writeState(state);
    return removed;
  }

  // Baselines

  getBaseline(personId: string): ContentResearchBaseline | null {
    return this.readState().baselines.find((b) => b.personId === personId) ?? null;
  }

  recordBaseline(personId: string, weightedCounts: number[]): ContentResearchBaseline {
    const state = this.readState();
    let baseline = state.baselines.find((b) => b.personId === personId);
    if (!baseline) {
      baseline = {
        personId,
        history: [],
        mean: 0,
        stdDev: 0,
        updatedAt: this.now().toISOString(),
      };
      state.baselines.push(baseline);
    }
    // Keep last 90 values (daily aggregates)
    baseline.history.push(...weightedCounts);
    if (baseline.history.length > 90) {
      baseline.history = baseline.history.slice(-90);
    }
    const n = baseline.history.length;
    const mean = n === 0 ? 0 : baseline.history.reduce((a, b) => a + b, 0) / n;
    const variance =
      n <= 1 ? 0 : baseline.history.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
    baseline.mean = mean;
    baseline.stdDev = Math.sqrt(variance);
    baseline.updatedAt = this.now().toISOString();
    this.writeState(state);
    return baseline;
  }

  // Schedule / checkpoint

  scheduleState(): ContentResearchScheduleState {
    return this.readState().schedule;
  }

  recordSuccessfulPeriod(kind: "daily" | "discovery", period: string): void {
    const state = this.readState();
    if (kind === "daily") state.schedule.lastSuccessfulDailyPeriod = period;
    if (kind === "discovery") state.schedule.lastSuccessfulDiscoveryPeriod = period;
    this.writeState(state);
  }

  setDailyCheckpoint(checkpoint: string | null): void {
    const state = this.readState();
    state.schedule.lastDailyCheckpoint = checkpoint;
    this.writeState(state);
  }

  getDailyCheckpoint(): string | null {
    return this.readState().schedule.lastDailyCheckpoint;
  }

  // Items sharded store (raw SourceItems)

  storeItems(items: { canonicalUrl: string; payload: string }[]): void {
    mkdirSync(this.itemsDir, { recursive: true });
    for (const { canonicalUrl, payload } of items) {
      const hash = Buffer.from(canonicalUrl).toString("base64url").slice(0, 16);
      const path = join(this.itemsDir, `${hash}.json`);
      this.writeAtomic(path, payload);
    }
  }

  /** Collected Source Items, newest first, bounded — discovery reads receipts, not the whole corpus. */
  listItems(limit = 100): SourceItem[] {
    return this.listAllItems().slice(0, limit);
  }

  /** Every collected Source Item, newest first — the Profile lifecycle
      registry scans the whole corpus for documents naming a person. */
  listAllItems(): SourceItem[] {
    if (!existsSync(this.itemsDir)) return [];
    const items: SourceItem[] = [];
    for (const file of readdirSync(this.itemsDir)) {
      try {
        items.push(JSON.parse(readFileSync(join(this.itemsDir, file), "utf8")) as SourceItem);
      } catch {
        // a torn write is never worth failing a discovery run over
      }
    }
    items.sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1));
    return items;
  }

  // Ledger spreadsheet reference

  getLedger(): ContentResearchLedgerRef {
    return this.readState().ledger;
  }

  setLedger(ledger: ContentResearchLedgerRef): void {
    const state = this.readState();
    state.ledger = ledger;
    this.writeState(state);
  }
}
