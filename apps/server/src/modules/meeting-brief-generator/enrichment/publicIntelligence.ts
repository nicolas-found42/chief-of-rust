import { JSDOM } from "jsdom";
import {
  PUBLIC_INTELLIGENCE_MAX_RESULTS,
  type PublicIntelligenceArtifact,
  publicIntelligenceKey,
  type PublicIntelligenceSource,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";
import {
  isProviderWideError,
  readErrorCode,
  readErrorStatus,
  sanitizeEvidence,
  sanitizeArtifactVersion,
} from "./helpers.js";
// ---------------------------------------------------------------------------
// Public search result — normalized evidence, source ownership preserved
// ---------------------------------------------------------------------------
export interface PublicSearchResult {
  snippet: string;
  url: string;
  org?: string;
  publishedAt?: string;
  title?: string;
}

export interface PublicIntelligenceProvider {
  /** Bounded search within window, maxResults 10, snippet+target counted once via org dedup. */
  search(
    query: string,
    window: { from: string; to: string },
    maxResults: number,
  ): Promise<PublicSearchResult[]>;
}

type PublicSearchFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Bounded public-search adapter; returned page text remains untrusted evidence. */
export class DuckDuckGoPublicIntelligenceProvider implements PublicIntelligenceProvider {
  constructor(private readonly fetchPage: PublicSearchFetch = fetch) {}

  async search(
    query: string,
    window: { from: string; to: string },
    maxResults: number,
  ): Promise<PublicSearchResult[]> {
    const from = window.from.slice(0, 10);
    const to = window.to.slice(0, 10);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} after:${from} before:${to}`)}`;
    let response: Response;
    try {
      response = await this.fetchPage(url, {
        method: "GET",
        headers: { accept: "text/html", "user-agent": "chief-of-staff-demo/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      // Network and timeout failures are provider-wide outages (ADR-0030 `unavailable` category).
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`unavailable: public search failed (${message})`), {
        status: 503,
      });
    }
    if (!response.ok)
      throw Object.assign(new Error(`unavailable: public search failed (${response.status})`), {
        status: response.status,
      });
    const document = new JSDOM(await response.text(), { url }).window.document;
    const results: PublicSearchResult[] = [];
    for (const node of document.querySelectorAll<HTMLElement>(".result")) {
      if (results.length >= maxResults) break;
      const link = node.querySelector<HTMLAnchorElement>(".result__a");
      const snippet = node.querySelector<HTMLElement>(".result__snippet");
      const href = duckDuckGoTarget(link?.href ?? "");
      if (!link || !snippet || !href) continue;
      const target = new URL(href);
      results.push({
        title: sanitizeEvidence(link.textContent),
        snippet: sanitizeEvidence(snippet.textContent),
        url: target.toString(),
        org: target.hostname.toLowerCase().replace(/^www\./, ""),
      });
    }
    return results;
  }
}

function duckDuckGoTarget(value: string): string | null {
  try {
    const url = new URL(value, "https://html.duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? new URL(redirected).toString() : url.toString();
  } catch {
    return null;
  }
}

// Helpers re-exported via helpers.ts: sanitizeEvidence, readErrorStatus, readErrorCode, isProviderWideError
// (org/sippet helpers remain local)

function extractOrg(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return (
      url
        .toLowerCase()
        .split("/")[0]
        ?.replace(/^www\./, "") ?? url.toLowerCase()
    );
  }
}

function normalizeOrg(org: string): string {
  return org
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function normalizeSnippet(snippet: string): string {
  return snippet.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function previousMonthWindow(eventStartAt: string): { from: string; to: string } {
  const start = new Date(eventStartAt);
  const from = new Date(start);
  from.setMonth(from.getMonth() - 1);
  return { from: from.toISOString(), to: start.toISOString() };
}

function deduplicateByOrgAndSnippet(results: PublicSearchResult[]): PublicSearchResult[] {
  // Map org -> Set<snippetKey> to handle snippet+target count once per org
  // Then keep only first result per org (multiple pages from one org count once)
  const orgSnippetMap = new Map<string, Set<string>>();
  const seenOrgs = new Set<string>();
  const deduped: PublicSearchResult[] = [];
  for (const r of results) {
    const org = normalizeOrg(r.org ?? extractOrg(r.url));
    const snippetKey = normalizeSnippet(r.snippet);
    let set = orgSnippetMap.get(org);
    if (!set) {
      set = new Set<string>();
      orgSnippetMap.set(org, set);
    }
    // snippet plus target count once: same snippet for same org is duplicate
    if (set.has(snippetKey)) continue;
    set.add(snippetKey);
    if (seenOrgs.has(org)) {
      // multiple pages from one organization count once
      continue;
    }
    seenOrgs.add(org);
    deduped.push({ ...r, org });
  }
  return deduped;
}

export function fileNameFor(
  source: PublicIntelligenceSource,
  guestEmail: string,
  companyName: string | null | undefined,
  eventVersion: string,
): string {
  const sanitizedGuest = guestEmail.replace(/[^a-zA-Z0-9]/g, "_");
  const sanitizedCompany = companyName
    ? `-${companyName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}`
    : "";
  // map source to file prefix
  const prefix =
    source === "company-news"
      ? "public-company-news"
      : source === "industry-news"
        ? "public-industry-news"
        : "public-employer-verification";
  return `${prefix}-${sanitizedGuest}${sanitizedCompany}-${sanitizeArtifactVersion(eventVersion)}.json`;
}

// ---------------------------------------------------------------------------
// Core enrich helpers — bounded, retry, preservation, provider-wide handling
// ---------------------------------------------------------------------------

async function enrichWithPublicSearch(
  provider: PublicIntelligenceProvider,
  eventVersion: string,
  guestEmail: string,
  companyName: string | null,
  companyDomain: string | null,
  source: PublicIntelligenceSource,
  query: string,
  window: { from: string; to: string },
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: PublicIntelligenceArtifact; section: MeetingBriefEnrichmentSection }> {
  const normalizedGuest = guestEmail.toLowerCase();
  const key = publicIntelligenceKey(eventVersion, normalizedGuest, source, companyName);
  const stableRef = key;
  const maxResults = PUBLIC_INTELLIGENCE_MAX_RESULTS;
  const filename = fileNameFor(source, normalizedGuest, companyName, eventVersion);

  // Same-version retry preservation: if artifact exists and is completed/empty, reuse without calling provider.
  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as PublicIntelligenceArtifact;
      if (
        existing.eventVersion === eventVersion &&
        (existing.status === "completed" || existing.status === "empty")
      ) {
        const section: MeetingBriefEnrichmentSection = {
          source,
          guest: normalizedGuest,
          ...(companyName ? { company: companyName } : {}),
          status: existing.status,
          evidence: existing.evidence,
          references: existing.references,
        };
        return { artifact: existing, section };
      }
    } catch {
      // ignore parse failure, re-enrich
    }
  }

  const maxAttempts = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attempts = attempt;
    try {
      const rawResults = await provider.search(query, window, maxResults * 2); // fetch more to allow dedup
      // Filter by window if publishedAt present
      const windowFrom = Date.parse(window.from);
      const windowTo = Date.parse(window.to);
      const filtered = rawResults.filter((r) => {
        if (!r.publishedAt) return true; // if no date, keep (search already bounded)
        const t = Date.parse(r.publishedAt);
        if (Number.isNaN(t)) return true;
        return t >= windowFrom && t < windowTo;
      });
      const deduped = deduplicateByOrgAndSnippet(filtered);
      const limited = deduped.slice(0, maxResults);
      const truncated = deduped.length > maxResults;

      if (limited.length === 0) {
        const artifact: PublicIntelligenceArtifact = {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          ...(companyName ? { companyName } : { companyName: null }),
          ...(companyDomain ? { companyDomain } : { companyDomain: null }),
          source,
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: {
            bounded: true,
            maxResults,
            stableRef,
            window,
            attempts,
            orgs: [],
            untrusted: true,
          },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event(`${source}_empty`, { guest: normalizedGuest, company: companyName, attempts });
        const section: MeetingBriefEnrichmentSection = {
          source,
          guest: normalizedGuest,
          ...(companyName ? { company: companyName } : {}),
          status: "empty",
          evidence: [],
          references: [],
        };
        return { artifact, section };
      }

      const evidence = limited.map((r) =>
        sanitizeEvidence(r.snippet || r.title || `Public ${source} for ${companyName}`),
      );
      const references = limited.map((r) => r.url);
      const orgs = limited.map((r) => r.org ?? extractOrg(r.url));

      const artifact: PublicIntelligenceArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        ...(companyName ? { companyName } : { companyName: null }),
        ...(companyDomain ? { companyDomain } : { companyDomain: null }),
        source,
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          window,
          ...(truncated ? { truncated: true } : {}),
          attempts,
          orgs,
          untrusted: true,
        },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event(`${source}_completed`, {
        guest: normalizedGuest,
        company: companyName,
        count: evidence.length,
        truncated: !!truncated,
      });
      const section: MeetingBriefEnrichmentSection = {
        source,
        guest: normalizedGuest,
        ...(companyName ? { company: companyName } : {}),
        status: "completed",
        evidence,
        references,
      };
      return { artifact, section };
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) {
        throw error;
      }
      if (attempts < maxAttempts) {
        ctx.event(`${source}_retry`, {
          guest: normalizedGuest,
          company: companyName,
          attempt: attempts,
        });
        continue;
      }
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      const artifact: PublicIntelligenceArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        ...(companyName ? { companyName } : { companyName: null }),
        ...(companyDomain ? { companyDomain } : { companyDomain: null }),
        source,
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          window,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          attempts,
          untrusted: true,
        },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event(`${source}_failed`, {
        guest: normalizedGuest,
        company: companyName,
        error: reason.slice(0, 200),
        attempts,
      });
      const section: MeetingBriefEnrichmentSection = {
        source,
        guest: normalizedGuest,
        ...(companyName ? { company: companyName } : {}),
        status: "failed",
        evidence: [],
        references: [],
      };
      return { artifact, section };
    }
  }
  throw lastError;
}

export async function enrichCompanyNews(
  provider: PublicIntelligenceProvider,
  eventVersion: string,
  guestEmail: string,
  companyName: string,
  companyDomain: string | null,
  eventStartAt: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: PublicIntelligenceArtifact; section: MeetingBriefEnrichmentSection }> {
  const window = previousMonthWindow(eventStartAt);
  const query = `${companyName} news`;
  return enrichWithPublicSearch(
    provider,
    eventVersion,
    guestEmail,
    companyName,
    companyDomain,
    "company-news",
    query,
    window,
    ctx,
  );
}

export async function enrichIndustryNews(
  provider: PublicIntelligenceProvider,
  eventVersion: string,
  guestEmail: string,
  companyName: string,
  companyDomain: string | null,
  eventStartAt: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{ artifact: PublicIntelligenceArtifact; section: MeetingBriefEnrichmentSection }> {
  const window = previousMonthWindow(eventStartAt);
  const query = `${companyName} industry news`;
  return enrichWithPublicSearch(
    provider,
    eventVersion,
    guestEmail,
    companyName,
    companyDomain,
    "industry-news",
    query,
    window,
    ctx,
  );
}

// Employer verification: two different orgs must each directly state same guest-company relationship
export async function enrichEmployerVerification(
  provider: PublicIntelligenceProvider,
  eventVersion: string,
  guestEmail: string,
  guestName: string | null,
  companyName: string,
  companyDomain: string | null,
  eventStartAt: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifact: PublicIntelligenceArtifact;
  section: MeetingBriefEnrichmentSection;
  verified: boolean;
}> {
  const window = previousMonthWindow(eventStartAt);
  // Query combines guest and company; model proposal drives research but verification requires two orgs
  const query = `${guestEmail} ${guestName ?? ""} ${companyName}`.trim();
  const normalizedGuest = guestEmail.toLowerCase();
  const key = publicIntelligenceKey(
    eventVersion,
    normalizedGuest,
    "employer-verification",
    companyName,
  );
  const stableRef = key;
  const maxResults = PUBLIC_INTELLIGENCE_MAX_RESULTS;
  const filename = fileNameFor("employer-verification", normalizedGuest, companyName, eventVersion);

  // Preservation check
  const existingRaw = ctx.readFile(filename);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as PublicIntelligenceArtifact;
      if (
        existing.eventVersion === eventVersion &&
        (existing.status === "completed" || existing.status === "empty")
      ) {
        const verified = existing.status === "completed";
        const section: MeetingBriefEnrichmentSection = {
          source: "employer-verification",
          guest: normalizedGuest,
          company: companyName,
          status: existing.status,
          evidence: existing.evidence,
          references: existing.references,
        };
        return { artifact: existing, section, verified };
      }
    } catch {
      // ignore
    }
  }

  const maxAttempts = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attempts = attempt;
    try {
      const rawResults = await provider.search(query, window, maxResults * 2);
      // For verification, we need to assess whether each result directly states guest-company relationship.
      // For our implementation, any result that contains both guest and company in snippet or title is considered stating relationship.
      // Filter to those that actually mention both.
      const lowerGuest = normalizedGuest.toLowerCase();
      const lowerCompany = companyName.toLowerCase();
      const guestLocal = lowerGuest.split("@")[0] ?? lowerGuest;
      const relevant = rawResults.filter((r) => {
        const text = `${r.snippet} ${r.title ?? ""}`.toLowerCase();
        const hasGuest =
          text.includes(lowerGuest) ||
          (guestName && text.includes(guestName.toLowerCase())) ||
          text.includes(guestLocal);
        const hasCompany = text.includes(lowerCompany);
        return hasGuest && hasCompany;
      });
      // Now deduplicate by org and snippet
      const deduped = deduplicateByOrgAndSnippet(relevant);
      const orgCount = deduped.length;

      if (orgCount >= 2) {
        const limited = deduped.slice(0, maxResults);
        const truncated = deduped.length > maxResults;
        const evidence = limited.map((r) => sanitizeEvidence(r.snippet));
        const references = limited.map((r) => r.url);
        const orgs = limited.map((r) => r.org ?? extractOrg(r.url));
        const artifact: PublicIntelligenceArtifact = {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyName,
          companyDomain: companyDomain ?? null,
          source: "employer-verification",
          status: "completed",
          evidence,
          references,
          diagnostics: {
            bounded: true,
            maxResults,
            stableRef,
            window,
            ...(truncated ? { truncated: true } : {}),
            attempts,
            orgs,
            untrusted: true,
          },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("employer_verification_completed", {
          guest: normalizedGuest,
          company: companyName,
          orgs,
        });
        const section: MeetingBriefEnrichmentSection = {
          source: "employer-verification",
          guest: normalizedGuest,
          company: companyName,
          status: "completed",
          evidence,
          references,
        };
        return { artifact, section, verified: true };
      } else {
        // Unresolved employers receive no attributed company evidence — empty is not error but not verified
        const artifact: PublicIntelligenceArtifact = {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyName,
          companyDomain: companyDomain ?? null,
          source: "employer-verification",
          status: "empty",
          evidence: [],
          references: deduped.map((r) => r.url),
          diagnostics: {
            bounded: true,
            maxResults,
            stableRef,
            window,
            attempts,
            orgs: deduped.map((r) => r.org ?? extractOrg(r.url)),
            reason: "insufficient_organizations",
            untrusted: true,
          },
          stableRef,
        };
        ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
        ctx.event("employer_verification_empty", {
          guest: normalizedGuest,
          company: companyName,
          orgs: orgCount,
        });
        const section: MeetingBriefEnrichmentSection = {
          source: "employer-verification",
          guest: normalizedGuest,
          company: companyName,
          status: "empty",
          evidence: [],
          references: [],
        };
        return { artifact, section, verified: false };
      }
    } catch (error) {
      lastError = error;
      if (isProviderWideError(error)) throw error;
      if (attempts < maxAttempts) {
        ctx.event("employer_verification_retry", {
          guest: normalizedGuest,
          company: companyName,
          attempt: attempts,
        });
        continue;
      }
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      const artifact: PublicIntelligenceArtifact = {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyName,
        companyDomain: companyDomain ?? null,
        source: "employer-verification",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          window,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          attempts,
          untrusted: true,
        },
        stableRef,
      };
      ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
      ctx.event("employer_verification_failed", {
        guest: normalizedGuest,
        company: companyName,
        error: reason.slice(0, 200),
        attempts,
      });
      const section: MeetingBriefEnrichmentSection = {
        source: "employer-verification",
        guest: normalizedGuest,
        company: companyName,
        status: "failed",
        evidence: [],
        references: [],
      };
      return { artifact, section, verified: false };
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Fake public intelligence provider for host-seam tests
// ---------------------------------------------------------------------------
export interface FakePublicIntelligenceOptions {
  mode?: "normal" | "unavailable";
  unavailableError?: unknown;
}

export class FakePublicIntelligenceProvider implements PublicIntelligenceProvider {
  private mode: "normal" | "unavailable";
  private unavailableError: unknown;
  private companyNews = new Map<string, PublicSearchResult[]>();
  private industryNews = new Map<string, PublicSearchResult[]>();
  private verifications = new Map<string, PublicSearchResult[]>();
  private customResults = new Map<string, PublicSearchResult[]>();
  private callCounts = new Map<string, number>();

  constructor(opts: FakePublicIntelligenceOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.unavailableError =
      opts.unavailableError ??
      Object.assign(new Error("Public intelligence API unavailable"), { status: 503 });
  }

  setMode(mode: "normal" | "unavailable"): void {
    this.mode = mode;
  }

  setCompanyNews(companyName: string, results: PublicSearchResult[]): void {
    this.companyNews.set(companyName.toLowerCase(), results);
  }

  setIndustryNews(companyName: string, results: PublicSearchResult[]): void {
    this.industryNews.set(companyName.toLowerCase(), results);
  }

  setEmployerVerification(
    guestEmail: string,
    companyName: string,
    results: PublicSearchResult[],
  ): void {
    this.verifications.set(`${guestEmail.toLowerCase()}::${companyName.toLowerCase()}`, results);
  }

  setResultsForQuery(queryPart: string, results: PublicSearchResult[]): void {
    this.customResults.set(queryPart.toLowerCase(), results);
  }

  getCallCount(queryPart?: string): number {
    if (!queryPart) {
      let total = 0;
      for (const v of this.callCounts.values()) total += v;
      return total;
    }
    return this.callCounts.get(queryPart.toLowerCase()) ?? 0;
  }

  async search(
    query: string,
    window: { from: string; to: string },
    maxResults: number,
  ): Promise<PublicSearchResult[]> {
    void window;
    const lower = query.toLowerCase();
    this.callCounts.set(lower, (this.callCounts.get(lower) ?? 0) + 1);
    // also track per key
    for (const key of this.customResults.keys()) {
      if (lower.includes(key)) {
        this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
      }
    }
    if (this.mode === "unavailable") throw this.unavailableError;

    // Custom query match first
    for (const [key, val] of this.customResults) {
      if (lower.includes(key)) return val.slice(0, maxResults);
    }

    // Verification: guest + company
    for (const [key, val] of this.verifications) {
      const parts = key.split("::");
      const guest = parts[0] ?? "";
      const comp = parts[1] ?? "";
      if (lower.includes(guest) && lower.includes(comp)) return val.slice(0, maxResults);
    }

    // Company news
    for (const [comp, val] of this.companyNews) {
      if (lower.includes(comp) && lower.includes("news") && !lower.includes("industry")) {
        return val.slice(0, maxResults);
      }
    }

    // Industry news
    for (const [comp, val] of this.industryNews) {
      if (lower.includes(comp) && lower.includes("industry")) {
        return val.slice(0, maxResults);
      }
    }

    return [];
  }
}
