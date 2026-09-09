import { google } from "googleapis";
import type { GoogleAuth } from "./oauth.js";

/**
 * The Sheets Output Adapter: a set of functions over one Google surface, beside
 * Tasks and Gmail, not a class anybody implements. Append only — this app adds
 * a day's rows and never rewrites yesterday's, so the row-update step the Relay
 * original had does not survive into this design at all.
 *
 * The writes need no new scope: the full Drive scope this app already holds
 * after ADR-0021 authorizes creating a spreadsheet and writing values, so the
 * only consent this Module costs is the YouTube one.
 */
export interface CreatedSpreadsheet {
  id: string;
  /** Google's own link to the file, returned by the create call. */
  url: string;
}

export async function createSpreadsheet(
  auth: GoogleAuth,
  title: string,
): Promise<CreatedSpreadsheet> {
  const sheets = google.sheets({ version: "v4", auth });
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
    fields: "spreadsheetId,spreadsheetUrl",
  });
  const id = created.data.spreadsheetId;
  if (!id) {
    throw new Error("Google created no spreadsheet");
  }
  /* The file lands in the root of the operator's Drive: a parent folder cannot
     be named on this call, and moving it afterwards is not worth a second
     round trip for a file they can drag wherever they like. */
  return { id, url: created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${id}` };
}

/** The tabs a spreadsheet has, by title. Throws if the spreadsheet is gone. */
async function tabTitles(auth: GoogleAuth, spreadsheetId: string): Promise<string[]> {
  const sheets = google.sheets({ version: "v4", auth });
  const found = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  return (found.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => typeof title === "string");
}

/** Add a tab with its header row. Does nothing if a tab of that name is there. */
export async function ensureTab(
  auth: GoogleAuth,
  spreadsheetId: string,
  title: string,
  header: string[],
): Promise<void> {
  if ((await tabTitles(auth, spreadsheetId)).includes(title)) {
    return;
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  await appendRows(auth, spreadsheetId, title, [header]);
}

/**
 * Append rows to the bottom of one tab. One call per tab rather than a batched
 * multi-range write: Google documents no maximum number of ranges for the
 * batched form, and an undocumented limit is not a limit to build on.
 */
export async function appendRows(
  auth: GoogleAuth,
  spreadsheetId: string,
  tab: string,
  rows: (string | number)[][],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    /* Quoted, because a tab named for a channel may contain spaces. */
    range: `'${tab.replace(/'/g, "''")}'!A:D`,
    valueInputOption: "RAW",
    /* INSERT_ROWS, not OVERWRITE: appending must never land on a row somebody
       added by hand underneath. */
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/**
 * Google's answer when the spreadsheet is not there any more. Named so a Run can
 * fail loudly and point at the action that creates one, instead of quietly
 * creating a second: two spreadsheets and no way to tell which is live is a
 * worse failure than a red Run.
 */
export function isSpreadsheetMissing(error: unknown): boolean {
  const raw = error as { code?: number; status?: number; response?: { status?: number } };
  const status = raw.code ?? raw.status ?? raw.response?.status;
  if (status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Requested entity was not found|notFound/i.test(message);
}

/**
 * Read every row of one tab, or null when the tab has no values yet. Exists for
 * the read-then-write ledger upsert (spec #116): whether a (person, canonicalUrl)
 * row already exists is a fact about the Sheet, not about the Run asking.
 */
export async function readRows(
  auth: GoogleAuth,
  spreadsheetId: string,
  tab: string,
): Promise<(string | number)[][] | null> {
  const sheets = google.sheets({ version: "v4", auth });
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab.replace(/'/g, "''")}'`,
  });
  const values = read.data.values;
  return Array.isArray(values) ? (values as (string | number)[][]) : null;
}

/**
 * Rewrite one row in place (1-indexed including the header). Reserved for the
 * ledger upsert's update branch: an existing (person, canonicalUrl) row whose
 * resonanceScore moved. Everything else stays append-only.
 */
export async function updateRow(
  auth: GoogleAuth,
  spreadsheetId: string,
  tab: string,
  rowNumber: number,
  values: (string | number)[],
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tab.replace(/'/g, "''")}'!A${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

/** One tab's cleared tail: how many data rows the delete removed, header excluded. */
export interface ClearedTab {
  tab: string;
  rowsRemoved: number;
}

/**
 * Physically delete every row below the header row, in every tab, keeping
 * row 1. Deleting — not blanking — is the point: the grid shrinks back to the
 * header, so the next append lands on row 2 instead of under a thousand
 * emptied cells. Every tab is cleared, not only the tabs the configuration
 * still names: a channel removed from tracking leaves its tab behind, and its
 * rows are generated data all the same.
 */
export async function clearSpreadsheetDataRows(
  auth: GoogleAuth,
  spreadsheetId: string,
): Promise<ClearedTab[]> {
  const sheets = google.sheets({ version: "v4", auth });
  const found = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,sheetId,gridProperties.rowCount)",
  });
  const cleared: ClearedTab[] = [];
  for (const sheet of found.data.sheets ?? []) {
    const properties = sheet.properties;
    const sheetId = properties?.sheetId;
    const title = properties?.title;
    if (!properties || typeof sheetId !== "number" || typeof title !== "string") continue;
    const rowCount = properties.gridProperties?.rowCount ?? 0;
    if (rowCount <= 1) {
      cleared.push({ tab: title, rowsRemoved: 0 });
      continue;
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: rowCount },
            },
          },
        ],
      },
    });
    cleared.push({ tab: title, rowsRemoved: rowCount - 1 });
  }
  return cleared;
}
