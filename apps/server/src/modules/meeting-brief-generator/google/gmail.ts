import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";
import {
  GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY,
  GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
} from "@chief-of-staff-demo/shared";
import {
  readErrorCode,
  readErrorStatus,
  sanitizeArtifactVersion,
  sanitizeEvidence,
} from "../enrichment/helpers.js";
import { runArtifactLifecycle } from "./artifactLifecycle.js";

export interface GmailThread {
  id: string;
  snippet: string;
  messages?: Array<{ id: string; snippet: string }>;
}

export interface GmailProvider {
  listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]>;
  listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]>;
}

export function createGmailProvider(auth: GoogleAuth): GmailProvider {
  const listThreads = async (q: string, maxResults: number): Promise<GmailThread[]> => {
    const gmail = google.gmail({ version: "v1", auth });
    const response = await gmail.users.threads.list({ userId: "me", q, maxResults });
    const ids = (response.data.threads ?? [])
      .flatMap((thread) => (thread.id ? [thread.id] : []))
      .slice(0, maxResults);
    return Promise.all(
      ids.map(async (id) => {
        const detail = await gmail.users.threads.get({ userId: "me", id, format: "full" });
        const messages = (detail.data.messages ?? []).flatMap((message) =>
          message.id ? [{ id: message.id, snippet: message.snippet ?? "" }] : [],
        );
        return {
          id,
          snippet: detail.data.snippet ?? "",
          ...(messages.length > 0 ? { messages } : {}),
        };
      }),
    );
  };
  return {
    async listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]> {
      // Exact-address query: from:email OR to:email (bounded)
      const q = `{from:${guestEmail} to:${guestEmail}}`;
      return listThreads(q, maxResults);
    },
    async listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]> {
      const q = `{from:*@${companyDomain} to:*@${companyDomain}}`;
      return listThreads(q, maxResults);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Gmail provider for host-seam tests (issue://85)
// ---------------------------------------------------------------------------

export type FakeGmailMode = "normal" | "unavailable";

export interface FakeGmailOptions {
  mode?: FakeGmailMode;
  // For individual failure simulation: map guestEmail lowercased to failure behavior
  failFirstFor?: Set<string>;
  // For unavailable global: throw for all
  unavailableError?: unknown;
  // Custom threads per guestEmail or company domain
  exactThreads?: Map<string, GmailThread[]>;
  companyThreads?: Map<string, GmailThread[]>;
  // Global delay or count
  callCounts?: Map<string, number>;
}

export class FakeGmailProvider implements GmailProvider {
  private mode: FakeGmailMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private exactThreads: Map<string, GmailThread[]>;
  private companyThreads: Map<string, GmailThread[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();

  constructor(opts: FakeGmailOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError =
      opts.unavailableError ??
      Object.assign(new Error("Gmail unavailable"), { status: 503, code: 503 });
    this.exactThreads = opts.exactThreads ?? new Map<string, GmailThread[]>();
    this.companyThreads = opts.companyThreads ?? new Map<string, GmailThread[]>();
  }

  setExactThreads(guestEmail: string, threads: GmailThread[]): void {
    this.exactThreads.set(guestEmail.toLowerCase(), threads);
  }

  setCompanyThreads(domain: string, threads: GmailThread[]): void {
    this.companyThreads.set(domain.toLowerCase(), threads);
  }

  setMode(mode: FakeGmailMode): void {
    this.mode = mode;
  }

  addFailFirstFor(guestEmail: string): void {
    this.failFirstFor.add(guestEmail.toLowerCase());
  }

  getCallCount(key: string): number {
    return this.callCounts.get(key) ?? 0;
  }

  async listExactThreads(guestEmail: string, maxResults: number): Promise<GmailThread[]> {
    void maxResults;
    const key = `exact:${guestEmail.toLowerCase()}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(guestEmail.toLowerCase()) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient gmail exact failure"), { status: 500 });
    }
    const all = this.exactThreads.get(guestEmail.toLowerCase()) ?? [];
    // Deduplicate by id preserving order, then bound
    const seen = new Set<string>();
    const deduped: GmailThread[] = [];
    for (const t of all) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        deduped.push(t);
      }
    }
    return deduped;
  }

  async listCompanyThreads(companyDomain: string, maxResults: number): Promise<GmailThread[]> {
    void maxResults;
    const key = `company:${companyDomain.toLowerCase()}`;
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(companyDomain.toLowerCase()) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient gmail company failure"), { status: 500 });
    }
    const all = this.companyThreads.get(companyDomain.toLowerCase()) ?? [];
    const seen = new Set<string>();
    const deduped: GmailThread[] = [];
    for (const t of all) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        deduped.push(t);
      }
    }
    return deduped;
  }
}

export async function enrichGmailExact(
  provider: GmailProvider,
  eventVersion: string,
  guestEmail: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifact: GoogleEnrichmentArtifact;
  section: MeetingBriefEnrichmentSection;
  filename: string;
}> {
  const normalized = guestEmail.toLowerCase();
  const key = googleEnrichmentKey(eventVersion, normalized, "gmail-exact");
  const stableRef = key;
  const maxResults = GOOGLE_ENRICHMENT_MAX_GMAIL_EXACT;
  const filename = `gmail-exact-${normalized.replace(/[^a-z0-9]/g, "_")}-${sanitizeArtifactVersion(eventVersion)}.json`;
  const settled = await runArtifactLifecycle({
    ctx,
    filename,
    eventVersion,
    async lookup(attempts) {
      const threads = await provider.listExactThreads(normalized, maxResults);
      if (threads.length === 0) {
        return {
          key,
          eventVersion,
          guestEmail: normalized,
          source: "gmail-exact",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
      }
      // Deduplicate already done by provider, but double-check
      const seen = new Set<string>();
      const deduped: GmailThread[] = [];
      for (const t of threads) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          deduped.push(t);
        }
      }
      const limited = deduped.slice(0, maxResults);
      const truncated = deduped.length > maxResults || threads.length > maxResults;
      const evidence = limited.map((t) =>
        sanitizeEvidence(t.snippet || `Gmail thread ${t.id} with ${normalized}`),
      );
      const references = limited.map((t) => `https://mail.google.com/mail/u/0/#inbox/${t.id}`);
      return {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "gmail-exact",
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          untrusted: true,
          ...(truncated ? { truncated: true } : {}),
          attempts,
        },
        stableRef,
      };
    },
    failure(error, attempts) {
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        key,
        eventVersion,
        guestEmail: normalized,
        source: "gmail-exact",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          untrusted: true,
          attempts,
        },
        stableRef,
      };
    },
    onRetry(error, attempt) {
      ctx.event("gmail_exact_retry", {
        guest: normalized,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onSettled(artifact) {
      if (artifact.status === "empty") {
        ctx.event("gmail_exact_empty", {
          guest: normalized,
          eventVersion,
          attempts: artifact.diagnostics.attempts,
        });
      } else if (artifact.status === "completed") {
        ctx.event("gmail_exact_completed", {
          guest: normalized,
          count: artifact.evidence.length,
          truncated: Boolean(artifact.diagnostics.truncated),
        });
      } else {
        ctx.event("gmail_exact_failed", {
          guest: normalized,
          error: artifact.diagnostics.reason?.slice(0, 200) ?? "unknown error",
          attempts: artifact.diagnostics.attempts,
        });
      }
    },
  });
  return { ...settled, filename };
}

export async function enrichGmailCompanyDomain(
  provider: GmailProvider,
  eventVersion: string,
  guestEmail: string,
  companyDomain: string,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifact: GoogleEnrichmentArtifact;
  section: MeetingBriefEnrichmentSection;
  filename: string;
}> {
  const normalizedGuest = guestEmail.toLowerCase();
  const normalizedDomain = companyDomain.toLowerCase();
  const key = googleEnrichmentKey(
    eventVersion,
    normalizedGuest,
    "gmail-company-domain",
    normalizedDomain,
  );
  const stableRef = key;
  const maxResults = GOOGLE_ENRICHMENT_MAX_GMAIL_COMPANY;

  const sanitizedGuest = normalizedGuest.replace(/[^a-z0-9]/g, "_");
  const sanitizedDomain = normalizedDomain.replace(/[^a-z0-9]/g, "_");
  const filename = `gmail-company-${sanitizedGuest}-${sanitizedDomain}-${sanitizeArtifactVersion(eventVersion)}.json`;
  const settled = await runArtifactLifecycle({
    ctx,
    filename,
    eventVersion,
    async lookup(attempts) {
      const threads = await provider.listCompanyThreads(normalizedDomain, maxResults);
      if (threads.length === 0) {
        return {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyDomain: normalizedDomain,
          source: "gmail-company-domain",
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
      }
      const seen = new Set<string>();
      const deduped: GmailThread[] = [];
      for (const t of threads) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          deduped.push(t);
        }
      }
      const limited = deduped.slice(0, maxResults);
      const truncated = deduped.length > maxResults;
      const evidence = limited.map((t) =>
        sanitizeEvidence(t.snippet || `Company Gmail thread ${t.id} @${normalizedDomain}`),
      );
      const references = limited.map((t) => `https://mail.google.com/mail/u/0/#inbox/${t.id}`);
      return {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source: "gmail-company-domain",
        status: "completed",
        evidence,
        references,
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          untrusted: true,
          ...(truncated ? { truncated: true } : {}),
          attempts,
        },
        stableRef,
      };
    },
    failure(error, attempts) {
      const httpStatus = readErrorStatus(error);
      const errorCode = readErrorCode(error);
      const reason = error instanceof Error ? error.message : String(error);
      return {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source: "gmail-company-domain",
        status: "failed",
        evidence: [],
        references: [],
        diagnostics: {
          bounded: true,
          maxResults,
          stableRef,
          httpStatus,
          errorCode,
          reason: reason.slice(0, 500),
          untrusted: true,
          attempts,
        },
        stableRef,
      };
    },
    onRetry(_error, attempt) {
      ctx.event("gmail_company_retry", {
        guest: normalizedGuest,
        domain: normalizedDomain,
        attempt,
      });
    },
    onSettled(artifact) {
      if (artifact.status === "empty") {
        ctx.event("gmail_company_empty", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          attempts: artifact.diagnostics.attempts,
        });
      } else if (artifact.status === "completed") {
        ctx.event("gmail_company_completed", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          count: artifact.evidence.length,
        });
      } else {
        ctx.event("gmail_company_failed", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          error: artifact.diagnostics.reason?.slice(0, 200) ?? "unknown error",
        });
      }
    },
  });
  return { ...settled, filename };
}
