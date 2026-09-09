import { google } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import {
  GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS,
  type GoogleEnrichmentArtifact,
  googleEnrichmentKey,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import type { MeetingBriefEnrichmentSection } from "@chief-of-staff-demo/shared";
import {
  readErrorCode,
  readErrorStatus,
  sanitizeArtifactVersion,
  sanitizeEvidence,
} from "../enrichment/helpers.js";
import { runArtifactLifecycle } from "./artifactLifecycle.js";

export interface DriveDoc {
  id: string;
  name: string;
  webViewLink: string;
}

export interface DriveProvider {
  searchDocs(query: string, maxResults: number): Promise<DriveDoc[]>;
}

export function createDriveProvider(auth: GoogleAuth): DriveProvider {
  return {
    async searchDocs(query: string, maxResults: number): Promise<DriveDoc[]> {
      const drive = google.drive({ version: "v3", auth });
      const res = await drive.files.list({
        q: query,
        pageSize: maxResults,
        fields: "files(id, name, webViewLink)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const files = res.data.files ?? [];
      return files
        .filter((file): file is typeof file & { id: string } => Boolean(file.id))
        .slice(0, maxResults)
        .map((f) => ({
          id: f.id,
          name: f.name ?? "",
          webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
        }));
    },
  };
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

export type FakeDriveMode = "normal" | "unavailable";

export interface FakeDriveOptions {
  mode?: FakeDriveMode;
  failFirstFor?: Set<string>;
  unavailableError?: unknown;
  docs?: Map<string, DriveDoc[]>;
}

export class FakeDriveProvider implements DriveProvider {
  private mode: FakeDriveMode;
  private failFirstFor: Set<string>;
  private unavailableError: unknown;
  private docs: Map<string, DriveDoc[]>;
  private callCounts = new Map<string, number>();
  private failCounts = new Map<string, number>();
  constructor(opts: FakeDriveOptions = {}) {
    this.mode = opts.mode ?? "normal";
    this.failFirstFor = new Set([...(opts.failFirstFor ?? [])].map((s) => s.toLowerCase()));
    this.unavailableError =
      opts.unavailableError ??
      Object.assign(new Error("Drive unavailable"), { status: 503, code: 503 });
    this.docs = opts.docs ?? new Map<string, DriveDoc[]>();
  }

  setDocs(queryKey: string, docs: DriveDoc[]): void {
    this.docs.set(queryKey.toLowerCase(), docs);
  }

  setMode(mode: FakeDriveMode): void {
    this.mode = mode;
  }

  addFailFirstFor(queryKey: string): void {
    this.failFirstFor.add(queryKey.toLowerCase());
  }

  getCallCount(queryKey: string): number {
    return this.callCounts.get(queryKey.toLowerCase()) ?? 0;
  }

  async searchDocs(query: string, maxResults: number): Promise<DriveDoc[]> {
    void maxResults;
    const key = query.toLowerCase();
    this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    if (this.mode === "unavailable") throw this.unavailableError;
    const count = this.failCounts.get(key) ?? 0;
    if (this.failFirstFor.has(key) && count === 0) {
      this.failCounts.set(key, count + 1);
      throw Object.assign(new Error("transient drive failure"), { status: 500 });
    }
    const all = this.docs.get(key) ?? [];
    const seen = new Set<string>();
    const deduped: DriveDoc[] = [];
    for (const d of all) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        deduped.push(d);
      }
    }
    return deduped;
  }
}

export async function enrichDriveDocs(
  provider: DriveProvider,
  eventVersion: string,
  guestEmail: string,
  companyDomain: string | null,
  ctx: Pick<RunContext, "writeFile" | "event" | "readFile">,
): Promise<{
  artifact: GoogleEnrichmentArtifact;
  section: MeetingBriefEnrichmentSection;
  filename: string;
}> {
  const normalizedGuest = guestEmail.toLowerCase();
  const normalizedDomain = companyDomain ? companyDomain.toLowerCase() : null;
  // Drive artifact keyed by guest + company presence; if companyDomain present, include it
  const source = "drive-docs" as const;
  const key = googleEnrichmentKey(eventVersion, normalizedGuest, source, normalizedDomain);
  const stableRef = key;
  const maxResults = GOOGLE_ENRICHMENT_MAX_DRIVE_DOCS;
  const sanitizedGuest = normalizedGuest.replace(/[^a-z0-9]/g, "_");
  const sanitizedDomain = normalizedDomain ? normalizedDomain.replace(/[^a-z0-9]/g, "_") : "person";
  const filename = `drive-${sanitizedGuest}-${sanitizedDomain}-${sanitizeArtifactVersion(eventVersion)}.json`;

  // Build bounded query: for company domain, search for Drive docs containing company domain or guest email
  // For consumer domains, only guest-specific query
  const queryParts: string[] = [];
  if (normalizedDomain) {
    queryParts.push(`fullText contains '${normalizedDomain}'`);
    queryParts.push(`fullText contains '${normalizedGuest}'`);
  } else {
    queryParts.push(`fullText contains '${normalizedGuest}'`);
  }
  const query = queryParts.join(" or ");

  const settled = await runArtifactLifecycle({
    ctx,
    filename,
    eventVersion,
    async lookup(attempts) {
      const docs = await provider.searchDocs(query, maxResults);
      if (docs.length === 0) {
        return {
          key,
          eventVersion,
          guestEmail: normalizedGuest,
          companyDomain: normalizedDomain,
          source,
          status: "empty",
          evidence: [],
          references: [],
          diagnostics: { bounded: true, maxResults, stableRef, untrusted: true, attempts },
          stableRef,
        };
      }
      const limited = docs.slice(0, maxResults);
      const truncated = docs.length > maxResults;
      const evidence = limited.map((d) => sanitizeEvidence(d.name || `Doc ${d.id}`));
      const references = limited.map((d) => d.webViewLink);
      return {
        key,
        eventVersion,
        guestEmail: normalizedGuest,
        companyDomain: normalizedDomain,
        source,
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
        source,
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
      ctx.event("drive_retry", { guest: normalizedGuest, attempt });
    },
    onSettled(artifact) {
      if (artifact.status === "empty") {
        ctx.event("drive_empty", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          attempts: artifact.diagnostics.attempts,
        });
      } else if (artifact.status === "completed") {
        ctx.event("drive_completed", {
          guest: normalizedGuest,
          domain: normalizedDomain,
          count: artifact.evidence.length,
        });
      } else {
        ctx.event("drive_failed", {
          guest: normalizedGuest,
          error: artifact.diagnostics.reason?.slice(0, 200) ?? "unknown error",
        });
      }
    },
  });
  return { ...settled, filename };
}
