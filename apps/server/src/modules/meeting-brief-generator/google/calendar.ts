import { google, type calendar_v3 } from "googleapis";
import type { GoogleAuth } from "../../../google/oauth.js";
import { relayAccess } from "../../../relay/client.js";
import type { RelayStateStore } from "../../../relay/state.js";
import { readErrorStatus } from "../enrichment/helpers.js";
import {
  InvalidSyncTokenError,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarProvider,
  type CalendarWatchResult,
} from "../calendar.js";

export interface GoogleCalendarTransport {
  watch(args: {
    calendarId: string;
    channelId: string;
    token: string;
    address: string;
    expiration?: string | null;
  }): Promise<CalendarWatchResult>;
  stop(args: { channelId: string; resourceId: string | null }): Promise<void>;
  list(args: {
    calendarId: string;
    syncToken?: string | null;
    timeMin?: string | null;
    timeMax?: string | null;
  }): Promise<{ events: calendar_v3.Schema$Event[]; nextSyncToken: string | null }>;
}

export interface CalendarRelayRegistry {
  callbackUrl(): string;
  registerChannel(channel: {
    channelId: string;
    token: string;
    resourceId: string | null;
    expiration: string | null;
  }): Promise<void>;
  revokeChannel(channelId: string): Promise<void>;
}

export function createGoogleCalendarProvider(
  transport: GoogleCalendarTransport,
  relay: CalendarRelayRegistry,
): CalendarProvider {
  return {
    async watchChannel(args): Promise<CalendarWatchResult> {
      const pendingChannel = {
        channelId: args.channelId,
        token: args.token,
        resourceId: null,
        expiration: args.expiration ?? null,
      };
      await relay.registerChannel(pendingChannel);
      try {
        const result = await transport.watch({
          ...args,
          address: relay.callbackUrl(),
        });
        await relay.registerChannel({ ...pendingChannel, ...result });
        return result;
      } catch (error) {
        await relay.revokeChannel(args.channelId).catch(() => undefined);
        throw error;
      }
    },

    async stopChannel(args): Promise<void> {
      let googleError: unknown = null;
      try {
        await transport.stop(args);
      } catch (error) {
        googleError = error;
      }
      await relay.revokeChannel(args.channelId);
      if (googleError) {
        throw googleError instanceof Error
          ? googleError
          : new Error("Google Calendar channel stop failed", { cause: googleError });
      }
    },

    async listEvents(args) {
      try {
        const result = await transport.list(args);
        return {
          events: result.events
            .map((event) => mapGoogleEvent(args.calendarId, event))
            .filter((event): event is CalendarEvent => event !== null),
          nextSyncToken: result.nextSyncToken,
        };
      } catch (error) {
        if (readErrorStatus(error) === 410) throw new InvalidSyncTokenError();
        throw error;
      }
    },
  };
}

export function googleCalendarTransport(getAuth: () => GoogleAuth): GoogleCalendarTransport {
  return {
    async watch(args) {
      const calendar = google.calendar({ version: "v3", auth: getAuth() });
      const response = await calendar.events.watch({
        calendarId: args.calendarId,
        requestBody: {
          id: args.channelId,
          type: "web_hook",
          address: args.address,
          token: args.token,
          ...(args.expiration ? { expiration: String(Date.parse(args.expiration)) } : {}),
        },
      });
      return {
        resourceId: response.data.resourceId ?? null,
        expiration: normalizeExpiration(response.data.expiration),
      };
    },

    async stop(args) {
      if (!args.resourceId) return;
      const calendar = google.calendar({ version: "v3", auth: getAuth() });
      await calendar.channels.stop({
        requestBody: { id: args.channelId, resourceId: args.resourceId },
      });
    },

    async list(args) {
      const calendar = google.calendar({ version: "v3", auth: getAuth() });
      const events: calendar_v3.Schema$Event[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;
      do {
        const response = await calendar.events.list({
          calendarId: args.calendarId,
          showDeleted: true,
          singleEvents: true,
          maxResults: 2_500,
          ...(pageToken ? { pageToken } : {}),
          ...(args.syncToken
            ? { syncToken: args.syncToken }
            : {
                ...(args.timeMin ? { timeMin: args.timeMin } : {}),
                ...(args.timeMax ? { timeMax: args.timeMax } : {}),
              }),
        });
        events.push(...(response.data.items ?? []));
        pageToken = response.data.nextPageToken ?? undefined;
        nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
      } while (pageToken);
      return {
        events,
        nextSyncToken,
      };
    },
  };
}

export function workspaceCalendarRelayRegistry(store: RelayStateStore): CalendarRelayRegistry {
  const access = () => {
    const result = relayAccess(store, { ensureInstallation: true });
    if (!result.ok) throw new Error(`missing_configuration: Calendar relay ${result.error}`);
    return result.client;
  };
  return {
    callbackUrl() {
      const state = store.load();
      if (!state.relayBaseUrl) throw new Error("missing_configuration: Calendar relay URL");
      return `${state.relayBaseUrl.replace(/\/+$/, "")}/google/push`;
    },
    async registerChannel(channel) {
      const client = access();
      await client.registerInstallation();
      await client.registerChannel(channel);
      store.addChannel(channel);
    },
    async revokeChannel(channelId) {
      const client = access();
      await client.revokeChannel(channelId);
      store.removeChannel(channelId);
    },
  };
}

function mapGoogleEvent(calendarId: string, event: calendar_v3.Schema$Event): CalendarEvent | null {
  const originalStart =
    event.originalStartTime?.dateTime ?? dateAtMidnight(event.originalStartTime?.date);
  const start = event.start?.dateTime ?? dateAtMidnight(event.start?.date) ?? originalStart;
  const end = event.end?.dateTime ?? dateAtMidnight(event.end?.date) ?? start;
  const eventId = event.recurringEventId ?? event.id;
  const status =
    event.status === "cancelled"
      ? "cancelled"
      : event.status === "tentative"
        ? "tentative"
        : "confirmed";
  const isCancelled = status === "cancelled";
  // Preserve sparse cancelled non-recurring tombstones without start/end (issue://83 sparse cancellation)
  if (isCancelled) {
    const occurrenceId = originalStart ?? start ?? eventId ?? "";
    const startAt = start ?? originalStart ?? "";
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- sparse tombstone fallback handles nullable end
    const endAt = end ?? startAt ?? "";
    if (!eventId || !occurrenceId) return null;
    // For sparse tombstones, startAt/endAt may be empty; reconciliation will remove by eventId
    return {
      calendarId,
      eventId,
      occurrenceId,
      version: event.etag ?? event.updated ?? String(event.sequence ?? event.id ?? occurrenceId),
      summary: event.summary ?? "Untitled meeting",
      ...(event.description !== null && event.description !== undefined
        ? { description: event.description }
        : {}),
      startAt,
      endAt,
      location: event.location ?? null,
      conferenceLink:
        event.hangoutLink ??
        event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri ??
        null,
      ...(event.organizer?.email
        ? {
            organizer: {
              email: event.organizer.email,
              ...(event.organizer.displayName ? { displayName: event.organizer.displayName } : {}),
            },
          }
        : {}),
      attendees: (event.attendees ?? [])
        .map(mapAttendee)
        .filter((attendee): attendee is CalendarAttendee => attendee !== null),
      status,
      isAllDay: Boolean(event.start?.date && !event.start.dateTime),
      ...(event.attachments
        ? { attachments: event.attachments.flatMap((attachment) => attachment.fileUrl ?? []) }
        : {}),
      etag: event.etag ?? null,
      visibility: event.visibility ?? null,
      transparency: event.transparency ?? null,
      created: event.created ?? null,
      updated: event.updated ?? null,
    };
  }
  const occurrenceId = originalStart ?? start;
  if (!eventId || !start || !end || !occurrenceId) return null;
  return {
    calendarId,
    eventId,
    occurrenceId,
    version: event.etag ?? event.updated ?? String(event.sequence ?? event.id ?? occurrenceId),
    summary: event.summary ?? "Untitled meeting",
    ...(event.description !== null && event.description !== undefined
      ? { description: event.description }
      : {}),
    startAt: start,
    endAt: end,
    location: event.location ?? null,
    conferenceLink:
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri ??
      null,
    ...(event.organizer?.email
      ? {
          organizer: {
            email: event.organizer.email,
            ...(event.organizer.displayName ? { displayName: event.organizer.displayName } : {}),
          },
        }
      : {}),
    attendees: (event.attendees ?? [])
      .map(mapAttendee)
      .filter((attendee): attendee is CalendarAttendee => attendee !== null),
    status,
    isAllDay: Boolean(event.start?.date && !event.start.dateTime),
    ...(event.attachments
      ? { attachments: event.attachments.flatMap((attachment) => attachment.fileUrl ?? []) }
      : {}),
    etag: event.etag ?? null,
    visibility: event.visibility ?? null,
    transparency: event.transparency ?? null,
    created: event.created ?? null,
    updated: event.updated ?? null,
  };
}

function mapAttendee(attendee: calendar_v3.Schema$EventAttendee): CalendarAttendee | null {
  if (!attendee.email) return null;
  const responseStatus =
    attendee.responseStatus === "accepted" ||
    attendee.responseStatus === "declined" ||
    attendee.responseStatus === "tentative"
      ? attendee.responseStatus
      : "needsAction";
  return {
    email: attendee.email,
    ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
    responseStatus,
    ...(attendee.organizer !== null && attendee.organizer !== undefined
      ? { organizer: attendee.organizer }
      : {}),
    ...(attendee.resource !== null && attendee.resource !== undefined
      ? { resource: attendee.resource }
      : {}),
    ...(attendee.self !== null && attendee.self !== undefined ? { self: attendee.self } : {}),
  };
}

function dateAtMidnight(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function normalizeExpiration(value: string | null | undefined): string | null {
  if (!value) return null;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}
