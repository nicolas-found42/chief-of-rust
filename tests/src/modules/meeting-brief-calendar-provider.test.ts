import { describe, expect, it } from "vitest";
import {
  createGoogleCalendarProvider,
  type CalendarRelayRegistry,
  type GoogleCalendarTransport,
} from "../../../apps/server/src/modules/meeting-brief-generator/google/calendar.js";
import { InvalidSyncTokenError } from "../../../apps/server/src/modules/meeting-brief-generator/calendar.js";

describe("Google Calendar Intake adapter — issues #81 and #83", () => {
  it("registers the opaque relay before opening the Google watch channel", async () => {
    const order: string[] = [];
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel(channel) {
        order.push(`relay:${channel.channelId}`);
      },
      async revokeChannel() {},
    };
    const transport: GoogleCalendarTransport = {
      async watch(args) {
        order.push(`google:${args.channelId}`);
        expect(args.address).toBe("https://relay.example/google/push");
        return { resourceId: "resource-1", expiration: "2026-09-04T10:00:00.000Z" };
      },
      async stop() {},
      async list() {
        return { events: [], nextSyncToken: null };
      },
    };
    const provider = createGoogleCalendarProvider(transport, relay);

    const result = await provider.watchChannel({
      calendarId: "primary",
      channelId: "channel-1",
      token: "secret-token",
    });

    expect(order).toEqual(["relay:channel-1", "google:channel-1", "relay:channel-1"]);
    expect(result).toEqual({
      resourceId: "resource-1",
      expiration: "2026-09-04T10:00:00.000Z",
    });
  });

  it("maps Google occurrences into Calendar events and classifies an expired sync token", async () => {
    let invalid = false;
    const transport: GoogleCalendarTransport = {
      async watch() {
        return { resourceId: null, expiration: null };
      },
      async stop() {},
      async list() {
        if (invalid) throw Object.assign(new Error("Sync token is no longer valid"), { code: 410 });
        return {
          events: [
            {
              id: "event-1",
              recurringEventId: "series-1",
              originalStartTime: { dateTime: "2026-08-28T15:00:00.000Z" },
              etag: "etag-v2",
              summary: "Customer meeting",
              start: { dateTime: "2026-08-28T15:00:00.000Z" },
              end: { dateTime: "2026-08-28T15:30:00.000Z" },
              status: "confirmed",
              attendees: [
                {
                  email: "owner@example.com",
                  responseStatus: "accepted",
                  organizer: true,
                  self: true,
                },
                { email: "guest@external.co", responseStatus: "tentative" },
              ],
            },
          ],
          nextSyncToken: "sync-2",
        };
      },
    };
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel() {},
      async revokeChannel() {},
    };
    const provider = createGoogleCalendarProvider(transport, relay);

    await expect(provider.listEvents({ calendarId: "primary" })).resolves.toMatchObject({
      nextSyncToken: "sync-2",
      events: [
        {
          calendarId: "primary",
          eventId: "series-1",
          occurrenceId: "2026-08-28T15:00:00.000Z",
          version: "etag-v2",
          summary: "Customer meeting",
          isAllDay: false,
          attendees: expect.arrayContaining([
            expect.objectContaining({ email: "owner@example.com", self: true }),
          ]),
        },
      ],
    });

    invalid = true;
    await expect(
      provider.listEvents({ calendarId: "primary", syncToken: "expired" }),
    ).rejects.toBeInstanceOf(InvalidSyncTokenError);
  });

  it("preserves cancelled recurring-occurrence tombstones that omit start and end", async () => {
    const transport: GoogleCalendarTransport = {
      async watch() {
        return { resourceId: null, expiration: null };
      },
      async stop() {},
      async list() {
        return {
          events: [
            {
              id: "cancelled-instance",
              recurringEventId: "series-1",
              originalStartTime: { dateTime: "2026-08-28T15:00:00.000Z" },
              status: "cancelled",
              etag: "cancelled-v3",
            },
          ],
          nextSyncToken: "sync-3",
        };
      },
    };
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel() {},
      async revokeChannel() {},
    };

    await expect(
      createGoogleCalendarProvider(transport, relay).listEvents({
        calendarId: "primary",
        syncToken: "sync-2",
      }),
    ).resolves.toMatchObject({
      events: [
        {
          eventId: "series-1",
          occurrenceId: "2026-08-28T15:00:00.000Z",
          startAt: "2026-08-28T15:00:00.000Z",
          endAt: "2026-08-28T15:00:00.000Z",
          status: "cancelled",
        },
      ],
    });
  });

  it("stops the Google channel and revokes the relay registration (issue #110)", async () => {
    const order: string[] = [];
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel() {},
      async revokeChannel(channelId) {
        order.push(`relay:revoke:${channelId}`);
      },
    };
    const transport: GoogleCalendarTransport = {
      async watch() {
        return { resourceId: null, expiration: null };
      },
      async stop(args) {
        order.push(`google:stop:${args.channelId}:${String(args.resourceId)}`);
      },
      async list() {
        return { events: [], nextSyncToken: null };
      },
    };

    await createGoogleCalendarProvider(transport, relay).stopChannel({
      channelId: "channel-1",
      resourceId: "resource-1",
    });

    // Google first, then the relay: the registration outlives the channel it points at.
    expect(order).toEqual(["google:stop:channel-1:resource-1", "relay:revoke:channel-1"]);
  });

  it("revokes the relay registration even when Google's stop fails, then reports the failure (issue #110)", async () => {
    // The dangling-registration case: if a failed Google stop skipped the revoke, the
    // relay would keep forwarding wake-ups for a channel nothing owns.
    const revoked: string[] = [];
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel() {},
      async revokeChannel(channelId) {
        revoked.push(channelId);
      },
    };
    const transport: GoogleCalendarTransport = {
      async watch() {
        return { resourceId: null, expiration: null };
      },
      async stop() {
        throw new Error("google stop refused");
      },
      async list() {
        return { events: [], nextSyncToken: null };
      },
    };

    await expect(
      createGoogleCalendarProvider(transport, relay).stopChannel({
        channelId: "channel-1",
        resourceId: "resource-1",
      }),
    ).rejects.toThrow(/google stop refused/);
    expect(revoked).toEqual(["channel-1"]);
  });

  it("passes a bounded full-sync window and an incremental sync token to the transport (issue #110)", async () => {
    const calls: {
      calendarId: string;
      syncToken: string | null | undefined;
      timeMin: string | null | undefined;
      timeMax: string | null | undefined;
    }[] = [];
    const relay: CalendarRelayRegistry = {
      callbackUrl: () => "https://relay.example/google/push",
      async registerChannel() {},
      async revokeChannel() {},
    };
    const transport: GoogleCalendarTransport = {
      async watch() {
        return { resourceId: null, expiration: null };
      },
      async stop() {},
      async list(args) {
        calls.push({
          calendarId: args.calendarId,
          syncToken: args.syncToken,
          timeMin: args.timeMin,
          timeMax: args.timeMax,
        });
        return { events: [], nextSyncToken: "sync-next" };
      },
    };
    const provider = createGoogleCalendarProvider(transport, relay);

    // Bounded full sync: a window, no token.
    await provider.listEvents({
      calendarId: "primary",
      syncToken: null,
      timeMin: "2026-08-28T00:00:00.000Z",
      timeMax: "2026-08-30T00:00:00.000Z",
    });
    // Incremental sync: a token, no window.
    const incremental = await provider.listEvents({
      calendarId: "primary",
      syncToken: "sync-1",
    });

    expect(calls).toEqual([
      {
        calendarId: "primary",
        syncToken: null,
        timeMin: "2026-08-28T00:00:00.000Z",
        timeMax: "2026-08-30T00:00:00.000Z",
      },
      { calendarId: "primary", syncToken: "sync-1", timeMin: undefined, timeMax: undefined },
    ]);
    expect(incremental.nextSyncToken).toBe("sync-next");
  });
});
