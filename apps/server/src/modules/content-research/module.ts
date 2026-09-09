import type {
  ContentResearchProfilePin,
  ContentResearchRunResult,
  NamedPerson,
  PersonProfileProjection,
  ResonanceReport,
  SourceItem,
} from "@chief-of-staff-demo/shared";
import {
  CONTENT_RESEARCH_MODULE_ID,
  CONTENT_RESEARCH_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import {
  StageFailure,
  type RetryPlan,
  type RunContext,
  type ShellModule,
} from "../../engine/module.js";
import type { RunOutcome } from "../../runs.js";
import type { Runs } from "../../runs.js";
import type { ContentResearchStore } from "./store.js";
import type { HookExtractor, PeopleDiscoverer, SheetsAccess, GmailAccess } from "./ports.js";
import { coMentionQueries } from "./search.js";
import type { PublicSearch, PublicSearchResult } from "../../source-adapters/search.js";
import type { SourceAdapter } from "../../source-adapters/source-adapter.js";
import { toScoredItem } from "./scoring.js";
import { personSourceTargets } from "./targets.js";
import { modelDiagnosticEventDetail } from "../../llm/failure.js";
import { errorMessage } from "../../engine/failure.js";
import { collectContentResearch, type CollectedPersonTarget } from "./collection.js";

export const CONTENT_RESEARCH_INTAKE = "content-research-daily";
export const CONTENT_RESEARCH_BACKFILL_INTAKE = "content-research-backfill";
export const CONTENT_RESEARCH_DISCOVERY_INTAKE = "people-discovery";

export type ContentResearchInput = { kind: "intake"; invocation: "manual" | "scheduled" };
export interface ContentResearchModuleDeps {
  store: ContentResearchStore;
  adapters: SourceAdapter[];
  /** The public-safe Profile projection seam (spec #134): every Run resolves
      the watch's Profile through it and pins what it used. */
  profileProjection: (profileId: string) => PersonProfileProjection | null;
  hookExtractor: HookExtractor;
  sheets: () => SheetsAccess;
  gmail: () => GmailAccess;
  getOwnerEmail: () => string | null;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  runs: Runs;
  log?: (message: string) => void;
}

export interface ContentResearchBackfillDeps {
  store: ContentResearchStore;
  adapters: SourceAdapter[];
  profileProjection: (profileId: string) => PersonProfileProjection | null;
  hookExtractor: HookExtractor;
  sheets: () => SheetsAccess;
  gmail: () => GmailAccess;
  getOwnerEmail: () => string | null;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  runs: Runs;
}

export interface PeopleDiscoveryDeps {
  store: ContentResearchStore;
  brandProfile: () => { markdown: string } | null;
  discoverer: PeopleDiscoverer;
  searchPublic: PublicSearch;
  now: () => Date;
}

/** Sign-aware score: a z-score below the person's baseline must not read "+-1.2". */
function formatScore(score: number): string {
  const rounded = Math.round(score * 100) / 100;
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * The Resonance Report as the owner reads it in mail. The same reports the tab
 * renders and the ledger records — one report, three renderings (spec #116).
 */
function renderResonanceReportEmail(reports: ResonanceReport[]): string {
  const lines: string[] = [];
  lines.push("Content Research — Resonance Report");
  lines.push("");
  for (const report of reports) {
    const top = report.items[0];
    lines.push(
      `${report.personName}: ${report.items.length} items, top score ${top ? formatScore(top.resonanceScore) : "—"}`,
    );
    for (const item of report.items) {
      lines.push(
        `- ${item.title ?? item.canonicalUrl} [${item.platform}] score ${formatScore(item.resonanceScore)} — ${item.canonicalUrl}`,
      );
      if (item.hook) lines.push(`  hook: ${item.hook}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const LEDGER_TAB = "Resonance Ledger";

const LEDGER_HEADER = [
  "person",
  "personId",
  "canonicalUrl",
  "publishedAt",
  "platform",
  "title",
  "url",
  "views",
  "likes",
  "hnPoints",
  "redditScore",
  "resonanceScore",
  "evidenceUrl",
];

interface PublishDeps {
  store: ContentResearchStore;
  sheets: () => SheetsAccess;
  gmail: () => GmailAccess;
  getOwnerEmail: () => string | null;
}

function ledgerRowFor(
  report: ResonanceReport,
  item: ResonanceReport["items"][number],
): ContentResearchRunResult["ledgerRows"][number] {
  return {
    person: report.personName,
    personId: report.personId,
    canonicalUrl: item.canonicalUrl,
    publishedAt: item.publishedAt,
    platform: item.platform,
    title: item.title,
    url: item.canonicalUrl,
    views: item.counts.views ?? null,
    likes: item.counts.likes ?? null,
    hnPoints: item.counts.hnPoints ?? null,
    redditScore: item.counts.redditScore ?? null,
    resonanceScore: item.resonanceScore,
    evidenceUrl: item.evidenceUrl,
  };
}

function sheetRowFor(row: ContentResearchRunResult["ledgerRows"][number]): (string | number)[] {
  return [
    row.person,
    row.personId,
    row.canonicalUrl,
    row.publishedAt ?? "",
    row.platform,
    row.title ?? "",
    row.url,
    row.views ?? "",
    row.likes ?? "",
    row.hnPoints ?? "",
    row.redditScore ?? "",
    row.resonanceScore,
    row.evidenceUrl ?? "",
  ];
}

/**
 * The Output Adapters, in order: local report first, then the Resonance Ledger
 * Sheet as a read-then-write upsert keyed (person, canonicalUrl) — a row that
 * exists is updated only when its score moved; a row that does not is appended —
 * then one draft to the owner only, then the Home notification. Because the
 * Sheet itself is queried before writing, a retry creates only what is missing,
 * never duplicates (spec #116 stories 18 and 27).
 */
async function publishReports(
  ctx: RunContext,
  deps: PublishDeps,
  reports: ResonanceReport[],
  adapters: ContentResearchRunResult["adapters"],
  subject: string,
  profilePins: ContentResearchProfilePin[],
): Promise<ContentResearchRunResult> {
  const ledgerRows = reports.flatMap((report) =>
    report.items.map((item) => ledgerRowFor(report, item)),
  );
  const result: ContentResearchRunResult = { reports, adapters, ledgerRows, profilePins };

  ctx.writeFile("result.json", `${JSON.stringify(result, null, 2)}\n`);
  ctx.event("local_persisted", { reports: reports.length, ledgerRows: ledgerRows.length });

  const sheetsAccess = deps.sheets();
  if (sheetsAccess.ok && ledgerRows.length > 0) {
    try {
      let spreadsheetId = sheetsAccess.spreadsheet?.id ?? deps.store.getLedger().spreadsheetId;
      if (!spreadsheetId) {
        const created = await sheetsAccess.client.createSpreadsheet(LEDGER_TAB);
        deps.store.setLedger({ spreadsheetId: created.id, spreadsheetUrl: created.url });
        spreadsheetId = created.id;
        ctx.event("ledger_spreadsheet_created", { spreadsheetId: created.id });
      }
      await sheetsAccess.client.ensureTab(spreadsheetId, LEDGER_TAB, LEDGER_HEADER);
      const existing = await sheetsAccess.client.readRows(spreadsheetId, LEDGER_TAB);
      /* personId and canonicalUrl live in columns B and C; +1 turns the 0-based
         read index into the Sheet's 1-based row number (header is row 1). */
      const rowNumberByKey = new Map<string, number>();
      (existing ?? []).forEach((values, index) => {
        const key = `${values[1]}::${values[2]}`;
        if (values[1] !== "personId") rowNumberByKey.set(String(key), index + 1);
      });
      const missing = ledgerRows.filter(
        (row) => !rowNumberByKey.has(`${row.personId}::${row.canonicalUrl}`),
      );
      if (missing.length > 0) {
        await sheetsAccess.client.appendRows(
          spreadsheetId,
          LEDGER_TAB,
          missing.map((row) => sheetRowFor(row)),
        );
      }
      for (const row of ledgerRows) {
        const rowNumber = rowNumberByKey.get(`${row.personId}::${row.canonicalUrl}`);
        if (
          rowNumber !== undefined &&
          Number(existing?.[rowNumber - 1]?.[11]) !== row.resonanceScore
        ) {
          await sheetsAccess.client.updateRow(
            spreadsheetId,
            LEDGER_TAB,
            rowNumber,
            sheetRowFor(row),
          );
        }
      }
      ctx.event("sheets_upserted", {
        appended: missing.length,
        updated: ledgerRows.length - missing.length,
      });
    } catch (error) {
      ctx.event("sheets_error", { error: errorMessage(error) });
      throw new StageFailure("sheets_failed", "Resonance Ledger could not be updated.");
    }
  } else if (sheetsAccess.ok) {
    ctx.event("sheets_skipped", { reason: "no_rows" });
  } else {
    ctx.event("sheets_unavailable", { state: sheetsAccess.state });
  }

  const gmailAccess = deps.gmail();
  if (gmailAccess.ok) {
    const owner = deps.getOwnerEmail();
    if (owner) {
      try {
        await gmailAccess.client.createDraft({
          to: owner,
          subject,
          body: renderResonanceReportEmail(reports),
        });
        ctx.event("gmail_draft_created", { subject, to: owner });
      } catch (error) {
        ctx.event("gmail_error", { error: errorMessage(error) });
        throw new StageFailure("gmail_failed", "Resonance report draft could not be created.");
      }
    } else {
      ctx.event("gmail_skipped", { reason: "owner_missing" });
    }
  } else {
    ctx.event("gmail_unavailable", { state: gmailAccess.state });
  }

  return result;
}

/** One Named Person and the Source Items attributed to them for this Run. */
type PersonItems = Map<
  string,
  { person: NamedPerson; items: { item: SourceItem; adapterId: string }[] }
>;

/**
 * Global dedup on `canonicalUrl`, per-Person attribution (spec #116 story 11).
 * A post collected for two people is stored once and appears in both people's
 * buckets, so each scores it against their own baseline while the item store
 * holds a single copy.
 */
/**
 * Carry each Target's validators and checkpoint forward, so tomorrow's fetch is
 * conditional. Only completed collections are remembered: a failure has nothing
 * trustworthy to say about what the resource looks like now.
 */
function rememberCollectionState(
  collected: CollectedPersonTarget[],
  store: ContentResearchStore,
): void {
  for (const entry of collected) {
    if (entry.result.kind !== "completed") continue;
    store.recordCollectionSuccess(
      entry.target.url,
      entry.result.checkpoint,
      entry.result.conditional ?? null,
    );
  }
}

/** Write the empty Run result — with whatever Profile pins were resolved. */
function writeEmptyResult(ctx: RunContext, profilePins: ContentResearchProfilePin[]): void {
  const emptyResult: ContentResearchRunResult = {
    reports: [],
    adapters: [],
    ledgerRows: [],
    profilePins,
  };
  ctx.writeFile("result.json", `${JSON.stringify(emptyResult, null, 2)}\n`);
}

/**
 * Resolve every watch's Profile through the public-safe projection seam before
 * anything is collected (spec #134): the Run pins the exact revision and
 * projection it used, and a person whose Profile is no longer projectable —
 * archived, merged away, privacy-deleted — is skipped for this Run rather than
 * collected against a guess. One unavailable Profile never fails the Run.
 */
function pinProfilesFor(
  people: NamedPerson[],
  profileProjection: (profileId: string) => PersonProfileProjection | null,
  ctx: RunContext,
): { people: NamedPerson[]; pins: ContentResearchProfilePin[] } {
  const runnable: NamedPerson[] = [];
  const pins: ContentResearchProfilePin[] = [];
  for (const person of people) {
    const projection = person.profileId ? profileProjection(person.profileId) : null;
    if (projection?.purpose !== "public-safe") {
      ctx.event("profile_projection_unavailable", {
        personId: person.id,
        profileId: person.profileId,
      });
      continue;
    }
    runnable.push(person);
    pins.push({
      personId: person.id,
      profileId: projection.profileId,
      profileRevision: projection.profileRevision,
      projection,
    });
  }
  return { people: runnable, pins };
}

function attributeItemsPerPerson(
  collected: CollectedPersonTarget[],
  people: NamedPerson[],
): { perPerson: PersonItems; uniqueItems: SourceItem[] } {
  /* Dedup is global on canonicalUrl, but attribution is per Person: the same
     post reaches two people through different adapters, and each must keep the
     adapter that actually found it or the second is labelled with the first
     Person's platform (spec #116 story 11's co-authored post). */
  const global = new Map<string, { item: SourceItem; adapterByPerson: Map<string, string> }>();
  for (const entry of collected) {
    for (const item of entry.result.items) {
      const existing = global.get(item.canonicalUrl);
      if (existing) {
        if (!existing.adapterByPerson.has(entry.personId))
          existing.adapterByPerson.set(entry.personId, entry.adapter.id);
      } else {
        global.set(item.canonicalUrl, {
          item,
          adapterByPerson: new Map([[entry.personId, entry.adapter.id]]),
        });
      }
    }
  }
  const perPerson: PersonItems = new Map();
  for (const person of people) perPerson.set(person.id, { person, items: [] });
  for (const value of global.values()) {
    for (const [personId, adapterId] of value.adapterByPerson) {
      perPerson.get(personId)?.items.push({ item: value.item, adapterId });
    }
  }
  return { perPerson, uniqueItems: [...global.values()].map((value) => value.item) };
}

/**
 * The Resonance Report per Person: every attributed item scored as a velocity
 * z-score against that person's own 90-day baseline, then the top 3 kept.
 */
function scoreReportsFor(
  perPerson: PersonItems,
  store: ContentResearchStore,
  now: () => Date,
  onPerson?: (personId: string, considered: number, kept: number) => void,
): ResonanceReport[] {
  const reports: ResonanceReport[] = [];
  for (const [personId, bucket] of perPerson) {
    const baseline = store.getBaseline(personId);
    const scored = bucket.items.map(({ item, adapterId }) =>
      toScoredItem({
        item,
        adapterId,
        hook: null,
        baseline: baseline
          ? { mean: baseline.mean, stdDev: baseline.stdDev, historyLength: baseline.history.length }
          : null,
      }),
    );
    scored.sort((a, b) => b.resonanceScore - a.resonanceScore);
    const top = scored.slice(0, 3);
    reports.push({
      personId,
      personName: bucket.person.name,
      generatedAt: now().toISOString(),
      items: top,
      topEvidence: top.map((item) => ({ canonicalUrl: item.canonicalUrl, title: item.title })),
    });
    onPerson?.(personId, bucket.items.length, top.length);
  }
  return reports;
}

/**
 * One LLM call per Person over that Person's top 3 only — title, excerpt, and
 * transcript when present. A Person's call never carries another Person's items
 * (no sibling visibility), and a model-boundary failure is recorded as a
 * classified fact with no payload text (ADR-0030) that leaves the hook null
 * rather than failing the Run (spec #116 stories 14 and 15).
 */
async function extractHooksFor(
  ctx: RunContext,
  hookExtractor: HookExtractor,
  reports: ResonanceReport[],
  perPerson: PersonItems,
): Promise<void> {
  for (const report of reports) {
    if (report.items.length === 0) continue;
    const bucket = perPerson.get(report.personId);
    const items = report.items.map((item) => {
      const full =
        bucket?.items.find((entry) => entry.item.canonicalUrl === item.canonicalUrl)?.item ?? null;
      return {
        title: item.title,
        excerpt: (full?.body ?? full?.description ?? item.title ?? "").slice(0, 500),
        transcript: full?.transcript ? full.transcript.slice(0, 2000) : null,
      };
    });
    try {
      const hookResult = await hookExtractor.extract({ personName: report.personName, items });
      for (const item of report.items) {
        item.hook = hookResult.hook;
        if (hookResult.evidenceQuote) item.evidenceQuote = hookResult.evidenceQuote;
      }
      ctx.event("hook_extracted", { personId: report.personId });
    } catch (error) {
      ctx.event("hook_failed", {
        personId: report.personId,
        error: errorMessage(error),
        ...modelDiagnosticEventDetail(error),
      });
      for (const item of report.items) item.hook = null;
    }
  }
}

export function contentResearchModule(
  deps: ContentResearchModuleDeps,
): ShellModule<ContentResearchInput> {
  const now = deps.now;
  return {
    id: CONTENT_RESEARCH_MODULE_ID,
    version: CONTENT_RESEARCH_MODULE_VERSION,
    failureHint(stage: string, reason: string): string {
      if (stage === "collect") return "Content Research collection failed.";
      if (stage === "normalize") return "Content Research normalization failed.";
      if (stage === "scoreResonance") return "Resonance scoring failed.";
      if (stage === "extractHook") return "Hook extraction failed.";
      if (stage === "publish") return "Content Research publish failed.";
      return reason;
    },
    planRetry(meta): RetryPlan<ContentResearchInput> | null {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      /* retryRun asks each Runner in turn and the three Content Research
         Runners share this Module id, so answering for another Intake would
         re-run a backfill or a discovery Run as a daily Run. */
      if (meta.intake !== CONTENT_RESEARCH_INTAKE) return null;
      const fromStage = meta.failedStage;
      if (!["collect", "normalize", "scoreResonance", "extractHook", "publish"].includes(fromStage))
        return null;
      return {
        fromStage,
        reason: "failed_stage_is_safe_to_repeat",
        input: { kind: "intake", invocation: "manual" },
        resetAttempts: false,
      };
    },
    planRecovery(state): RetryPlan<ContentResearchInput> | null {
      if (state.module !== CONTENT_RESEARCH_MODULE_ID) return null;
      /* The daily, backfill and discovery Runners share this Module id, so the
         Runner's module-scoped scan sees every Content Research Run. Only the
         daily Intake's Runs are this Module's to recover — without the Intake
         check the daily Run adopts an in-flight backfill or People Discovery
         Run and re-collects every adapter under it. */
      if (state.intake !== CONTENT_RESEARCH_INTAKE) return null;
      if (state.status !== "pending" && state.status !== "running") return null;
      const files = new Set(state.files);
      if (!files.has("result.json")) {
        return {
          fromStage: "collect",
          reason: "durable_progress_first_incomplete",
          input: { kind: "intake", invocation: "scheduled" },
        };
      }
      return {
        fromStage: "publish",
        reason: "durable_progress_first_incomplete",
        input: { kind: "intake", invocation: "scheduled" },
      };
    },
    async run(ctx: RunContext): Promise<RunOutcome> {
      const watched = deps.store.listPeople();
      let people: NamedPerson[] = watched;
      let profilePins: ContentResearchProfilePin[] = [];
      if (watched.length === 0) {
        await ctx.stage("collect", async () => {
          ctx.event("no_people", {});
          writeEmptyResult(ctx, []);
        });
        return { status: "done", summary: "No Named People — nothing to research" };
      }

      const nowDate = now();
      const checkpointRaw = deps.store.getDailyCheckpoint();
      const sinceDate = checkpointRaw
        ? new Date(new Date(checkpointRaw).getTime() - 48 * 60 * 60 * 1000)
        : new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      const sinceIso = sinceDate.toISOString();
      const untilIso = nowDate.toISOString();

      let collected: Awaited<ReturnType<typeof collectContentResearch>> = [];
      const adapterSummaries: ContentResearchRunResult["adapters"] = [];
      await ctx.stage("collect", async () => {
        /* Pin every watch's Profile before anything is collected (spec #134);
           a person whose Profile is no longer projectable is skipped here. */
        const pinned = pinProfilesFor(watched, deps.profileProjection, ctx);
        people = pinned.people;
        profilePins = pinned.pins;
        if (people.length === 0) {
          writeEmptyResult(ctx, profilePins);
          return;
        }
        const personsTargets = people.map((person) => ({
          id: person.id,
          name: person.name,
          targets: deps.adapters.flatMap((adapter) =>
            personSourceTargets(person, adapter, (url) => deps.store.getCollectionState(url)),
          ),
        }));
        // If adapters empty, still collect nothing but record.
        if (deps.adapters.length === 0) {
          ctx.event("collect_empty_adapters", { persons: people.length });
          return;
        }
        collected = await collectContentResearch({
          persons: personsTargets,
          adapters: deps.adapters,
          now,
          sleep: deps.sleep,
          since: sinceIso,
          until: untilIso,
        });
        for (const entry of collected) {
          const success = entry.result.kind === "completed";
          adapterSummaries.push({
            adapterId: entry.adapter.id,
            state: entry.adapter.state,
            outcome: entry.result.outcome,
            itemsFound: entry.result.items.length,
            errorClassifications: success ? [] : [entry.result.outcome],
          });
          ctx.event(success ? "adapter_collect_ok" : "adapter_collect_failed", {
            adapterId: entry.adapter.id,
            personId: entry.personId,
            outcome: entry.result.outcome,
            items: entry.result.items.length,
          });
        }
        rememberCollectionState(collected, deps.store);
        ctx.event("collect_done", { collected: collected.length });
      });
      if (people.length === 0) {
        return { status: "done", summary: "No watchable Profiles — nothing to research" };
      }

      let perPersonItems: PersonItems = new Map();
      await ctx.stage("normalize", async () => {
        const attributed = attributeItemsPerPerson(collected, people);
        perPersonItems = attributed.perPerson;
        if (attributed.uniqueItems.length > 0) {
          deps.store.storeItems(
            attributed.uniqueItems.map((item) => ({
              canonicalUrl: item.canonicalUrl,
              payload: JSON.stringify(item, null, 2),
            })),
          );
        }
        ctx.event("normalize_done", {
          uniqueUrls: attributed.uniqueItems.length,
          persons: perPersonItems.size,
        });
      });

      let reports: ResonanceReport[] = [];
      await ctx.stage("scoreResonance", async () => {
        reports = scoreReportsFor(perPersonItems, deps.store, now, (personId, considered, kept) => {
          ctx.event("scored_person", { personId, items: considered, top: kept });
        });
      });

      await ctx.stage("extractHook", async () => {
        await extractHooksFor(ctx, deps.hookExtractor, reports, perPersonItems);
      });

      // Publish: local first, then the ledger upsert, then the owner draft, then
      // the Home notification — and only a successful publish advances the
      // checkpoint and the 90-day baselines.
      const dailyLevels = new Map<string, number[]>();
      for (const [personId, bucket] of perPersonItems) {
        dailyLevels.set(
          personId,
          bucket.items.map(
            ({ item }) =>
              toScoredItem({ item, adapterId: "", hook: null, baseline: null }).weightedCount,
          ),
        );
      }
      await ctx.stage("publish", async () => {
        await publishReports(
          ctx,
          deps,
          reports,
          adapterSummaries,
          `Content Research — ${now().toISOString().slice(0, 10)} — ${reports.length} people resonating`,
          profilePins,
        );

        if (reports.some((r) => r.items.length > 0)) {
          const topNames = reports
            .filter((r) => r.items.length > 0)
            .map((r) => r.personName)
            .slice(0, 3)
            .join(", ");
          ctx.event("home_notification", {
            message: `${reports.length} people resonating — ${topNames}`,
          });
        }

        deps.store.setDailyCheckpoint(untilIso);
        deps.store.recordSuccessfulPeriod("daily", untilIso.slice(0, 10));
        for (const [personId, levels] of dailyLevels) {
          if (levels.length === 0) continue;
          /* One value per Run: the person's cross-platform level for the day, so
             a 90-value history really spans 90 days (spec story 12). */
          const average = levels.reduce((sum, value) => sum + value, 0) / levels.length;
          deps.store.recordBaseline(personId, [average]);
        }
      });

      const summaryParts = reports
        .filter((r) => r.items.length > 0)
        .map((r) => `${r.personName} ${r.items[0] ? formatScore(r.items[0].resonanceScore) : ""}`)
        .join(", ");
      const summary =
        reports.length === 0
          ? "No resonance — no people"
          : `${reports.length} people — ${summaryParts || "no items"}`;
      return { status: "done", summary };
    },
  };
}

export function contentResearchBackfillModule(
  deps: ContentResearchBackfillDeps,
): ShellModule<{ windowDays: 7 | 30 | 90 }> {
  const now = deps.now;
  return {
    id: CONTENT_RESEARCH_MODULE_ID,
    version: CONTENT_RESEARCH_MODULE_VERSION,
    failureHint(stage: string, reason: string): string {
      if (stage === "collect") return "Backfill collection failed.";
      if (stage === "publish") return "Backfill publish failed.";
      return reason;
    },
    planRetry(meta): RetryPlan<{ windowDays: 7 | 30 | 90 }> | null {
      if (meta.status !== "failed") return null;
      if (meta.intake !== CONTENT_RESEARCH_BACKFILL_INTAKE) return null;
      const external = meta.externalId ?? "";
      const windowDays = (external.split(":")[1] as "7" | "30" | "90" | undefined) ?? "7";
      const parsed = Number(windowDays) as 7 | 30 | 90;
      return {
        fromStage: meta.failedStage ?? "collect",
        reason: "failed_stage_is_safe_to_repeat",
        input: { windowDays: [7, 30, 90].includes(parsed) ? parsed : 7 },
        resetAttempts: false,
      };
    },
    async run(ctx: RunContext, input: { windowDays: 7 | 30 | 90 }): Promise<RunOutcome> {
      const watched = deps.store.listPeople();
      let people: NamedPerson[] = watched;
      let profilePins: ContentResearchProfilePin[] = [];
      if (watched.length === 0) {
        await ctx.stage("collect", async () => {
          writeEmptyResult(ctx, []);
        });
        return { status: "done", summary: "No Named People — nothing to backfill" };
      }
      const windowDays = input.windowDays;
      const nowDate = now();
      const sinceIso = new Date(nowDate.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      const untilIso = nowDate.toISOString();

      let collected: Awaited<ReturnType<typeof collectContentResearch>> = [];
      await ctx.stage("collect", async () => {
        /* Pin every watch's Profile before anything is collected (spec #134);
           a person whose Profile is no longer projectable is skipped here. */
        const pinned = pinProfilesFor(watched, deps.profileProjection, ctx);
        people = pinned.people;
        profilePins = pinned.pins;
        if (people.length === 0) {
          writeEmptyResult(ctx, profilePins);
          return;
        }
        /* Per-target isolation, not a Run-fatal pre-check: adapters that honor
           the window collect, and collection.ts records each target an adapter
           cannot honestly backfill as unsupported_capability. */
        const personsTargets = people.map((person) => ({
          id: person.id,
          name: person.name,
          targets: deps.adapters.flatMap((adapter) =>
            personSourceTargets(person, adapter, (url) => deps.store.getCollectionState(url)),
          ),
        }));
        collected = await collectContentResearch({
          persons: personsTargets,
          adapters: deps.adapters,
          now,
          sleep: deps.sleep,
          since: sinceIso,
          until: untilIso,
          backfillWindowDays: windowDays,
        });
        /* Story 7: an unsupported window fails explicitly rather than pretending
           to succeed empty — but only when nothing at all could honor it. */
        const collectedCount = collected.length;
        const unsupportedCount = collected.filter(
          (c) => c.result.outcome === "unsupported_capability",
        ).length;
        if (collectedCount > 0 && unsupportedCount === collectedCount) {
          throw new StageFailure(
            "unsupported_capability",
            `No Source Adapter honors a ${windowDays}-day backfill for this watchlist.`,
          );
        }
        rememberCollectionState(collected, deps.store);
        ctx.event("backfill_collect_done", {
          windowDays,
          collected: collectedCount,
          unsupported: unsupportedCount,
        });
      });
      if (people.length === 0) {
        return { status: "done", summary: "No watchable Profiles — nothing to backfill" };
      }

      /* The backfill runs the same Stages the daily Run does, over the same
         helpers: attributing globally-deduped items per Person, scoring each
         against that Person's own baseline, one hook call per Person, and the
         same read-then-write ledger upsert — so a backfill can never duplicate
         rows a daily Run already wrote (spec #116 story 27). Only the window
         differs, and a backfill never advances the daily checkpoint or the
         90-day baselines: it is history, not today's level. */
      let perPersonItems: PersonItems = new Map();
      await ctx.stage("normalize", async () => {
        const attributed = attributeItemsPerPerson(collected, people);
        perPersonItems = attributed.perPerson;
        if (attributed.uniqueItems.length > 0) {
          deps.store.storeItems(
            attributed.uniqueItems.map((item) => ({
              canonicalUrl: item.canonicalUrl,
              payload: JSON.stringify(item, null, 2),
            })),
          );
        }
        ctx.event("normalize_done", {
          uniqueUrls: attributed.uniqueItems.length,
          persons: perPersonItems.size,
        });
      });

      let reports: ResonanceReport[] = [];
      await ctx.stage("scoreResonance", async () => {
        reports = scoreReportsFor(perPersonItems, deps.store, now);
      });

      await ctx.stage("extractHook", async () => {
        await extractHooksFor(ctx, deps.hookExtractor, reports, perPersonItems);
      });

      await ctx.stage("publish", async () => {
        await publishReports(
          ctx,
          deps,
          reports,
          collected.map((entry) => ({
            adapterId: entry.adapter.id,
            state: entry.adapter.state,
            outcome: entry.result.outcome,
            itemsFound: entry.result.items.length,
            errorClassifications: entry.result.kind === "failed" ? [entry.result.outcome] : [],
          })),
          `Content Research backfill ${windowDays}d — ${reports.length} people`,
          profilePins,
        );
      });

      return { status: "done", summary: `Backfill ${windowDays}d — ${reports.length} people` };
    },
  };
}

export function peopleDiscoveryModule(
  deps: PeopleDiscoveryDeps,
): ShellModule<{ invocation: "manual" | "scheduled" }> {
  return {
    id: CONTENT_RESEARCH_MODULE_ID,
    version: CONTENT_RESEARCH_MODULE_VERSION,
    failureHint: () => "People Discovery could not produce suggestions.",
    planRetry(meta): RetryPlan<{ invocation: "manual" | "scheduled" }> | null {
      return meta.intake === CONTENT_RESEARCH_DISCOVERY_INTAKE && meta.status === "failed"
        ? {
            fromStage: meta.failedStage ?? "discover",
            reason: "failed_discovery_stage",
            input: { invocation: "manual" },
          }
        : null;
    },
    async run(ctx: RunContext): Promise<RunOutcome> {
      let count = 0;
      await ctx.stage("discover", async () => {
        const approvedPeople = deps.store.listPeople();
        /* Co-mentions come from public search, so the proposal is grounded in
           who is actually being named alongside the watchlist rather than in
           what the model recalls (spec #116 story 21). A sick search route
           narrows the evidence; it does not fail the Run. */
        const searchResults: PublicSearchResult[] = [];
        for (const query of coMentionQueries(approvedPeople)) {
          try {
            searchResults.push(...(await deps.searchPublic(query)));
          } catch {
            ctx.event("discovery_search_failed", { queries: 1 });
          }
        }
        ctx.event("discovery_search_done", { results: searchResults.length });
        const proposals = await deps.discoverer.discover({
          brandProfile: deps.brandProfile(),
          approvedPeople: approvedPeople.map((p) => ({ name: p.name })),
          recentItems: deps.store.listItems(50),
          searchResults,
        });
        const saved = deps.store.saveSuggestions(
          proposals.map((p) => ({
            name: p.name,
            reason: p.reason,
            supportingUrls: p.supportingUrls,
            relationshipToBrand: p.relationshipToBrand,
            source: p.source,
          })),
        );
        count = saved.length;
        ctx.writeFile("discovery-suggestions.json", `${JSON.stringify(saved, null, 2)}\n`);
        ctx.writeFile("result.json", `${JSON.stringify({ suggestions: saved }, null, 2)}\n`);
        ctx.event("people_suggestions_created", { count });
      });
      return { status: "done", summary: `${count} new Person Suggestion${count === 1 ? "" : "s"}` };
    },
  };
}
