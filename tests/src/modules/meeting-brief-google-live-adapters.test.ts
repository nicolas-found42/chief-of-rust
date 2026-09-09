import { beforeEach, describe, expect, it, vi } from "vitest";

const googleApi = vi.hoisted(() => ({
  threadsList: vi.fn(),
  threadsGet: vi.fn(),
  calendarList: vi.fn(),
  driveList: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: { threads: { list: googleApi.threadsList, get: googleApi.threadsGet } },
    }),
    calendar: () => ({ events: { list: googleApi.calendarList } }),
    drive: () => ({ files: { list: googleApi.driveList } }),
  },
}));

import { createGmailProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/gmail.js";
import { createCalendarHistoryProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendarHistory.js";
import { createDriveProvider } from "../../../apps/server/src/modules/meeting-brief-generator/google/drive.js";
import { googleCalendarTransport } from "../../../apps/server/src/modules/meeting-brief-generator/google/calendar.js";
import type { GoogleAuth } from "../../../apps/server/src/google/oauth.js";

describe("live Google enrichment adapters — issue #85", () => {
  beforeEach(() => {
    for (const mock of Object.values(googleApi)) mock.mockReset();
  });

  it("hydrates bounded Gmail thread summaries and drops entries without stable IDs", async () => {
    googleApi.threadsList.mockResolvedValue({
      data: { threads: [{ id: "thread-1" }, { historyId: "missing-id" }] },
    });
    googleApi.threadsGet.mockResolvedValue({
      data: {
        id: "thread-1",
        snippet: "Recent conversation with Alice",
        messages: [{ id: "message-1", snippet: "Planning follow-up" }],
      },
    });

    await expect(
      createGmailProvider({} as GoogleAuth).listExactThreads("alice@external.co", 10),
    ).resolves.toEqual([
      {
        id: "thread-1",
        snippet: "Recent conversation with Alice",
        messages: [{ id: "message-1", snippet: "Planning follow-up" }],
      },
    ]);
    expect(googleApi.threadsGet).toHaveBeenCalledTimes(1);
  });

  it("drops Calendar and Drive records that lack provider-stable IDs", async () => {
    googleApi.calendarList.mockResolvedValue({
      data: {
        items: [
          {
            summary: "No stable ID",
            start: { dateTime: "2026-08-01T10:00:00.000Z" },
            attendees: [{ email: "alice@external.co" }],
          },
        ],
      },
    });
    googleApi.driveList.mockResolvedValue({
      data: { files: [{ name: "No stable ID" }, { id: "doc-1", name: "Acme plan" }] },
    });

    await expect(
      createCalendarHistoryProvider({} as GoogleAuth).listPastMeetings(
        "alice@external.co",
        10,
        "2026-08-28T10:00:00.000Z",
      ),
    ).resolves.toEqual([]);
    await expect(createDriveProvider({} as GoogleAuth).searchDocs("Acme", 10)).resolves.toEqual([
      {
        id: "doc-1",
        name: "Acme plan",
        webViewLink: "https://drive.google.com/file/d/doc-1/view",
      },
    ]);
  });

  it("follows every Calendar page and returns the final sync token", async () => {
    googleApi.calendarList
      .mockResolvedValueOnce({
        data: { items: [{ id: "event-1" }], nextPageToken: "page-2" },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "event-2" }], nextSyncToken: "sync-final" },
      });

    await expect(
      googleCalendarTransport(() => ({}) as GoogleAuth).list({ calendarId: "primary" }),
    ).resolves.toEqual({
      events: [{ id: "event-1" }, { id: "event-2" }],
      nextSyncToken: "sync-final",
    });
    expect(googleApi.calendarList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "page-2" }),
    );
  });
});
