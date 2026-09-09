import type { ResonanceHookShape, SourceItem } from "@chief-of-staff-demo/shared";
import type { PublicSearchResult } from "../../source-adapters/search.js";

type ResonanceHookInput = {
  personName: string;
  items: { title: string | null; excerpt: string; transcript: string | null }[];
};

export interface HookExtractor {
  extract(input: ResonanceHookInput): Promise<ResonanceHookShape>;
}

export interface PeopleDiscoveryInput {
  brandProfile: { markdown: string } | null;
  approvedPeople: { name: string }[];
  recentItems: SourceItem[];
  /** What public search returned for the watchlist's co-mention queries. */
  searchResults: PublicSearchResult[];
}

export interface PeopleDiscoverer {
  discover(input: PeopleDiscoveryInput): Promise<
    {
      name: string;
      reason: string;
      supportingUrls: string[];
      relationshipToBrand: string;
      source: string;
    }[]
  >;
}

export type SheetsAccess =
  | { ok: true; client: SheetsClient; spreadsheet: { id: string; url: string } | null }
  | { ok: false; state: string };

interface SheetsClient {
  createSpreadsheet(title: string): Promise<{ id: string; url: string }>;
  ensureTab(spreadsheetId: string, title: string, header: string[]): Promise<void>;
  /** Every row of the tab, oldest first, or null when the tab has no values. */
  readRows(spreadsheetId: string, tab: string): Promise<(string | number)[][] | null>;
  appendRows(spreadsheetId: string, tab: string, rows: (string | number)[][]): Promise<void>;
  /** Rewrite one row in place (1-indexed including the header). */
  updateRow(
    spreadsheetId: string,
    tab: string,
    rowNumber: number,
    values: (string | number)[],
  ): Promise<void>;
  isMissing(error: unknown): boolean;
}

export type GmailAccess = { ok: true; client: GmailClient } | { ok: false; state: string };

interface GmailClient {
  createDraft(draft: { to: string; subject: string; body: string }): Promise<string>;
}
