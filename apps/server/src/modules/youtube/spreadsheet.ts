import type { GoogleConnectionState } from "@chief-of-staff-demo/shared";

/**
 * The Module's view of the Sheets Output Adapter: the three calls it makes, and
 * the spreadsheet it makes them against. A seam shaped like the YouTube client's,
 * for the same reason — the tests drive the Module, not Google.
 */
export interface SheetsClient {
  createSpreadsheet(title: string): Promise<{ id: string; url: string }>;
  /** Idempotent: a tab that is already there is left alone. */
  ensureTab(spreadsheetId: string, title: string, header: string[]): Promise<void>;
  appendRows(spreadsheetId: string, tab: string, rows: (string | number)[][]): Promise<void>;
  /** Whether an error means the spreadsheet itself is gone. */
  isMissing(error: unknown): boolean;
}

export type SheetsAccess =
  | { ok: true; client: SheetsClient; spreadsheet: { id: string; url: string } | null }
  | { ok: false; state: GoogleConnectionState };

/** The name the Module gives the spreadsheet it creates for itself. */
export const SPREADSHEET_TITLE = "YouTube Trends";

/**
 * Long, not wide: one row per video per day. Long appends in one call with no
 * read-modify-write, has no column ceiling, and is the shape every spreadsheet
 * chart and pivot expects — where a dated column per day would reach three
 * hundred and sixty-five columns a year and be unreadable long before it broke.
 */
export const SPREADSHEET_HEADER = ["Date", "Video", "Title", "Views"];

/* Sheets refuses these in a tab name, and caps the name at a hundred characters. */
const FORBIDDEN = /[[\]*?/\\:]/g;

/**
 * One tab per channel, named for the channel as it was when it was added — so
 * the tab a person is charting does not rename itself under them because
 * YouTube's title changed.
 */
export function tabNameFor(channel: { title: string; id: string }): string {
  const cleaned = channel.title.replace(FORBIDDEN, " ").trim().slice(0, 90);
  return cleaned === "" ? channel.id : cleaned;
}
