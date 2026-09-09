import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAuth } from "../../../apps/server/src/google/oauth";
import { clearSpreadsheetDataRows } from "../../../apps/server/src/google/sheets";

/**
 * The Sheets half of the generated-data clear: rows go, the header row and the
 * tabs themselves stay — emptying a destination must not orphan the
 * spreadsheet the config pointer names.
 */

const sdk = vi.hoisted(() => {
  const sheets = {
    spreadsheets: {
      get: vi.fn(),
      batchUpdate: vi.fn(),
    },
  };
  return { sheets, sheetsFactory: vi.fn(() => sheets) };
});

vi.mock("googleapis", () => ({ google: { sheets: sdk.sheetsFactory } }));

const auth = {} as GoogleAuth;

describe("clearSpreadsheetDataRows", () => {
  beforeEach(() => {
    sdk.sheets.spreadsheets.get.mockReset();
    sdk.sheets.spreadsheets.batchUpdate.mockReset();
  });

  it("deletes every data row per tab, keeps headers, and skips single-row tabs", async () => {
    sdk.sheets.spreadsheets.get.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: "Trends", sheetId: 7, gridProperties: { rowCount: 4 } } },
          { properties: { title: "Fresh", sheetId: 8, gridProperties: { rowCount: 1 } } },
        ],
      },
    });

    const cleared = await clearSpreadsheetDataRows(auth, "sheet-1");

    expect(cleared).toEqual([
      { tab: "Trends", rowsRemoved: 3 },
      { tab: "Fresh", rowsRemoved: 0 },
    ]);
    expect(sdk.sheets.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    expect(sdk.sheets.spreadsheets.batchUpdate).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: { sheetId: 7, dimension: "ROWS", startIndex: 1, endIndex: 4 },
            },
          },
        ],
      },
    });
  });

  it("skips tabs without usable properties instead of guessing", async () => {
    sdk.sheets.spreadsheets.get.mockResolvedValue({
      data: { sheets: [{ properties: undefined }] },
    });

    const cleared = await clearSpreadsheetDataRows(auth, "sheet-1");

    expect(cleared).toEqual([]);
    expect(sdk.sheets.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it("propagates transport failures so the route can classify them", async () => {
    sdk.sheets.spreadsheets.get.mockRejectedValue({ code: 404 });

    await expect(clearSpreadsheetDataRows(auth, "gone")).rejects.toMatchObject({ code: 404 });
  });
});
