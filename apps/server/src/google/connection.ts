import { google } from "googleapis";
import type {
  AppConfig,
  GoogleConnectionState,
  GoogleStatus,
  SetupCheck,
} from "@chief-of-staff-demo/shared";
import { GOOGLE_TESTING_TOKEN_DAYS } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import {
  type GoogleAuth,
  buildGoogleAuth,
  exchangeGoogleCode,
  googleAuthUrl,
  googleScopes,
  mintAccessToken,
  redirectUriForPort,
} from "./oauth.js";
import { googleOutputs, type GoogleOutputs } from "./outputs.js";

/**
 * Google's documented answer for a refresh token it will not honour again:
 * revoked by the user, expired because the consent screen is still in Testing,
 * or invalidated by a password change (which any Gmail scope triggers). It is
 * the one failure that means "sign in again" — a DNS failure, an offline
 * machine, or a 5xx says nothing about the token, so those must not be reported
 * as a lost connection.
 */
export function isRejectedGrant(error: unknown): boolean {
  const reported = (error as { response?: { data?: { error?: string } } } | null | undefined)
    ?.response?.data?.error;
  if (typeof reported === "string") {
    return reported === "invalid_grant";
  }
  return /invalid_grant/.test(error instanceof Error ? error.message : String(error));
}

/**
 * The Google surfaces this app needs, in the order the setup steps introduce
 * them. Checking each is the whole of "did the console work land?": every other
 * part of the flow either succeeds visibly or is a credential the app holds.
 *
 * YouTube joins them under ADR-0016 — it rides this connection rather than an
 * API key — and unlike the Picker it has a server-side surface, so **Check my
 * setup** probes it exactly as it probes the others.
 */
const GOOGLE_SURFACES = [
  "gmail",
  "gmail-read",
  "gmail-send",
  "calendar",
  "drive",
  "youtube",
  /* Last, and only when enabled: an optional surface must not decide whether
     the required ones report healthy. */
  "tasks",
] as const;
export type GoogleSurface = (typeof GOOGLE_SURFACES)[number];

const SURFACE: Record<GoogleSurface, { label: string; api: string; scope: string }> = {
  tasks: { label: "Google Tasks", api: "Tasks API", scope: "tasks" },
  gmail: { label: "Gmail drafts", api: "Gmail API", scope: "gmail.compose" },
  "gmail-read": { label: "Gmail history", api: "Gmail API", scope: "gmail.readonly" },
  "gmail-send": { label: "Gmail delivery", api: "Gmail API", scope: "gmail.send" },
  calendar: { label: "Google Calendar", api: "Calendar API", scope: "calendar.readonly" },
  drive: { label: "Google Drive", api: "Drive API", scope: "drive" },
  youtube: { label: "YouTube view counts", api: "YouTube Data API v3", scope: "youtube.readonly" },
};

const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/tasks": "Google Tasks",
  "https://www.googleapis.com/auth/gmail.compose": "Gmail drafts",
  "https://www.googleapis.com/auth/gmail.readonly": "Gmail history",
  "https://www.googleapis.com/auth/gmail.send": "Gmail delivery",
  "https://www.googleapis.com/auth/calendar.readonly": "Google Calendar",
  "https://www.googleapis.com/auth/drive": "Google Drive",
  "https://www.googleapis.com/auth/youtube.readonly": "YouTube view counts",
};

/**
 * Pure predicate: which required scopes Google did not grant. An empty or
 * absent echo is treated as a full grant rather than a failure — some Google
 * responses omit the list entirely and rejecting that would lock the operator
 * out on an unusual but valid answer.
 */
function findMissingScopes(
  grantedScopes: string[] | null | undefined,
  required: string[],
): string[] {
  if (!grantedScopes || grantedScopes.length === 0) {
    return [];
  }
  const granted = new Set(grantedScopes);
  return required.filter((scope) => !granted.has(scope));
}

export class IncompleteGrantError extends Error {
  public readonly missingScopes: string[];
  public readonly missingLabels: string[];
  constructor(missingScopes: string[]) {
    const labels = missingScopes.map((s) => SCOPE_LABELS[s] ?? s);
    const labelText = labels.join(", ");
    super(
      `Google did not grant ${labelText}. Sign in again and leave every permission ticked — the missing ${labels.length === 1 ? "permission is" : "permissions are"} ${labelText}.`,
    );
    this.name = "IncompleteGrantError";
    this.missingScopes = missingScopes;
    this.missingLabels = labels;
  }
}

/**
 * The token endpoint refused the exchange because the redirect URI registered
 * on the OAuth client does not match the one this app sent (D13). Named so the
 * UI can answer with the correct value instead of a generic failure.
 */
export class RedirectUriMismatchError extends Error {
  constructor() {
    super("The redirect URI registered in Google does not match this app's.");
    this.name = "RedirectUriMismatchError";
  }
}

/** Shape-tolerant: googleapis nests the reason at different depths per call. */
function isRedirectUriMismatch(error: unknown): boolean {
  return /redirect_uri_mismatch/.test(
    typeof error === "object" && error !== null ? JSON.stringify(error) : String(error),
  );
}

/**
 * The reason and message Google attaches to an API error. Distinct from
 * `isRejectedGrant`, which reads the bare string the *token* endpoint returns:
 * an API 403 carries an object instead, and the two shapes do not overlap.
 */
function apiError(error: unknown): { reason: string; message: string } {
  const reported = (error as { response?: { data?: { error?: unknown } } } | null | undefined)
    ?.response?.data?.error;
  if (reported && typeof reported === "object") {
    const shaped = reported as { message?: string; errors?: { reason?: string }[] };
    return { reason: shaped.errors?.[0]?.reason ?? "", message: shaped.message ?? "" };
  }
  return { reason: "", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Turn what a surface threw into the console step that fixes it. Google's 403
 * already names the cause precisely — an API that was never enabled reads
 * differently from a scope that was never granted — so this classifies rather
 * than guesses, and a cause it does not recognise passes through verbatim
 * instead of being flattened into "something went wrong".
 *
 * Exported because a Module makes its own Google calls with the connection's
 * credentials (ADR-0018) and must not invent a second explanation of the same
 * refusal: the wording a Run shows is the wording **Check my setup** shows.
 */
export function googleSurfaceHint(surface: GoogleSurface, error: unknown): string {
  if (isRejectedGrant(error)) {
    return "Google rejected the saved sign-in. Sign in again.";
  }
  const { reason, message } = apiError(error);
  if (
    reason === "accessNotConfigured" ||
    /has not been used in project|is disabled/i.test(message)
  ) {
    /* Google names the project in its own message, and naming it back is the
       only way someone catches that they configured a different one — the
       console does not switch to a project it has just created. */
    const project = message.match(/in project (\d+)/)?.[1];
    const where = project
      ? `in project ${project} — is that the project you configured?`
      : "for this Google Cloud project.";
    return `The ${SURFACE[surface].api} is not enabled ${where} If you enabled it just now, Google can take a few minutes to catch up; wait and check again.`;
  }
  if (
    reason === "insufficientPermissions" ||
    /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)
  ) {
    return `The saved Google sign-in does not have the ${SURFACE[surface].scope} scope. Sign in again first. If that does not fix it, add the scope under Data Access, then sign in again.`;
  }
  if (surface === "drive") {
    const raw = error as {
      code?: number;
      status?: number;
      response?: { status?: number };
    };
    const status = raw.code ?? raw.status ?? raw.response?.status;
    if (
      status === 404 ||
      /notFound|File not found|not_found|notAccessible/i.test(message) ||
      reason === "notFound"
    ) {
      return "Drive folder not found or not accessible — pick the folder again in Settings.";
    }
    if (status === 403 && /notFound|File not found|not_found/i.test(message)) {
      return "Drive folder not found or not accessible — pick the folder again in Settings.";
    }
  }
  return message || "Google refused the call and gave no reason.";
}

/**
 * One deliberate, read-only call per surface. Read-only matters: a check the
 * user can press at will must not leave Tasks or drafts behind.
 */
export type SurfaceProbe = (
  config: AppConfig,
  port: number,
  surface: GoogleSurface,
) => Promise<void>;

const callSurface: SurfaceProbe = async (config, port, surface) => {
  const auth = buildGoogleAuth(config, port);
  if (surface === "tasks") {
    await google.tasks({ version: "v1", auth }).tasklists.list({ maxResults: 1 });
    return;
  }
  if (surface === "gmail") {
    /* drafts.list, not users.getProfile: the app only ever asks for
       gmail.compose, and getProfile is not reachable with that scope alone — it
       would report a correctly configured Gmail as broken. */
    await google.gmail({ version: "v1", auth }).users.drafts.list({ userId: "me", maxResults: 1 });
    return;
  }
  if (surface === "gmail-read") {
    // Bounded read-only probe: at most one thread, no side effects, validates gmail.readonly scope + Gmail API enabled.
    await google.gmail({ version: "v1", auth }).users.threads.list({ userId: "me", maxResults: 1 });
    return;
  }
  if (surface === "gmail-send") {
    // Token metadata is the only read-only way to distinguish gmail.send from
    // gmail.readonly: listing Sent succeeds with either scope and would report a false healthy.
    const access = await auth.getAccessToken();
    const token = access.token ?? auth.credentials.access_token;
    if (!token) throw new Error("Google did not return an access token for Gmail delivery check");
    const info = await google.oauth2({ version: "v2", auth }).tokeninfo({ access_token: token });
    const scopes = new Set((info.data.scope ?? "").split(/\s+/).filter(Boolean));
    if (!scopes.has("https://www.googleapis.com/auth/gmail.send")) {
      throw Object.assign(new Error("Gmail delivery scope is missing"), {
        response: {
          status: 403,
          data: {
            error: {
              message: "Request had insufficient authentication scopes",
              errors: [{ reason: "insufficientPermissions" }],
            },
          },
        },
      });
    }
    return;
  }
  if (surface === "calendar") {
    // Bounded read-only probe: list one calendar event, validates calendar.readonly scope + Calendar API enabled.
    await google
      .calendar({ version: "v3", auth })
      .events.list({ calendarId: "primary", maxResults: 1, singleEvents: true });
    return;
  }
  if (surface === "youtube") {
    /* `videos.list`, which is the method the Module actually depends on, over
       public data. Not `mine=true`: this app reads other people's channels as
       readily as the operator's, and an account that has never created a
       channel of its own would fail a check about ownership while every call
       the Module makes would have worked. */
    await google
      .youtube({ version: "v3", auth })
      .videos.list({ part: ["id"], chart: "mostPopular", maxResults: 1 });
    return;
  }
  if (config.drive.folderId) {
    await google.drive({ version: "v3", auth }).files.get({
      fileId: config.drive.folderId,
      fields: "id, name",
      supportsAllDrives: true,
    });
    return;
  }
  await google.drive({ version: "v3", auth }).files.list({ pageSize: 1, fields: "files(id)" });
};

/** The hint a Run shows when the connection is why it could not finish. */
export function googleFailureHint(state: GoogleConnectionState): string {
  switch (state) {
    case "unconfigured":
      return "Google is not set up. Add your OAuth client in Settings, then retry.";
    case "disconnected":
      return "Google is not connected. Sign in from Settings, then retry.";
    case "expired":
      return "Google sign-in expired. Reconnect in Settings, then retry.";
    case "connected":
      return "Output creation failed. Retry, or check the events below.";
  }
}

/** Spending the refresh token, and asking who it belongs to. Throws when Google rejects it. */
export type GoogleProbe = (config: AppConfig, port: number) => Promise<{ email: string | null }>;

const spendRefreshToken: GoogleProbe = async (config, port) => {
  const auth = buildGoogleAuth(config, port);
  await auth.getAccessToken();
  /* Display only. The token has already proven itself by this point, so a Gmail
     call that fails here costs a name in the UI and nothing else. */
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return { email: profile.data.emailAddress ?? null };
  } catch {
    return { email: null };
  }
};

type OutputsAccess =
  { ok: true; outputs: GoogleOutputs } | { ok: false; state: GoogleConnectionState };

/**
 * Credentials for a Module that makes its own Google calls (ADR-0018): the
 * Shell holds the authorization, the Module does the calling.
 */
type AuthAccess = { ok: true; auth: GoogleAuth } | { ok: false; state: GoogleConnectionState };

type AuthUrlAccess = { ok: true; url: string } | { ok: false; state: GoogleConnectionState };

type PickerTokenAccess =
  | { ok: true; token: string; expiresAt: string | null }
  | { ok: false; state: GoogleConnectionState };

type ExchangeCode = (
  config: AppConfig,
  port: number,
  code: string,
) => Promise<{ refreshToken: string; grantedScopes: string[] }>;

type MintAccessTokenFn = (
  config: AppConfig,
  port: number,
) => Promise<{ token: string; expiresAt: string | null }>;

/**
 * The Google connection: the app's authorization to act on one person's Google
 * account, as the four states of ADR-0007 and as the only route to a Google
 * surface. Nothing outside this module reasons about client credentials or
 * refresh tokens.
 *
 * Nothing proves the token ahead of a Run, and nothing proves it on a schedule
 * (ADR-0008): `outputs()` answers from what is already known, and `observe()`
 * turns the error a real Google call threw into the state that explains it. A
 * person may ask — `state()` for the Settings page, `verifySetup()` for the
 * setup check — because that is a question asked once, not a cost paid per Run.
 */
export interface GoogleConnection {
  /** The four states, and who is signed in. Proves a stored token by spending it. */
  state(): Promise<GoogleStatus>;
  /** A Google surface, or the state that says why not. Never touches the network. */
  outputs(): OutputsAccess;
  /**
   * An authorized client for a Module to make its own calls with, or the state
   * that says why not. Never touches the network — the same cheap check
   * `outputs()` makes, for the same reason (ADR-0008).
   */
  auth(): AuthAccess;
  /**
   * Classify an error a Google call threw, and record what it proves about the
   * connection. Returns the state it establishes, or null when the error says
   * nothing about the connection.
   */
  observe(error: unknown): GoogleConnectionState | null;
  /**
   * Ask Google whether the console work is done, and name what is missing. Only
   * ever in answer to a person pressing the button: nothing verifies on a
   * schedule (ADR-0008).
   */
  verifySetup(): Promise<SetupCheck>;
  /** Google's consent screen, or the state that says why there isn't one yet. */
  authUrl(): AuthUrlAccess;
  completeSignIn(code: string): Promise<void>;
  disconnect(): void;
  /** Drop the remembered state; the next `state()` asks Google again. */
  invalidate(): void;
  /**
   * A short-lived OAuth access token for the Picker, minted from the stored
   * refresh token. Available only when `connected`; every other state returns
   * that state instead. The token carries all three scopes — Workspace APIs
   * offer no down-scoping — and is minted fresh on every call for the life of
   * one pick.
   */
  pickerToken(): Promise<PickerTokenAccess>;
}

export interface GoogleConnectionOptions {
  /** Test seam: the default spends the real refresh token. */
  probe?: GoogleProbe;
  /** Test seam: the default makes one real read-only call per surface. */
  surfaceProbe?: SurfaceProbe;
  /** Test seam: exchange a code for a refresh token and granted scopes. */
  exchangeCode?: ExchangeCode;
  /** Test seam: mint a short-lived access token for the Picker. */
  mintAccessToken?: MintAccessTokenFn;
}

export function openGoogleConnection(
  configStore: ConfigStore,
  port: number,
  options: GoogleConnectionOptions = {},
): GoogleConnection {
  const probe = options.probe ?? spendRefreshToken;
  const surfaceProbe = options.surfaceProbe ?? callSurface;
  const exchange = options.exchangeCode ?? exchangeGoogleCode;
  const mint = options.mintAccessToken ?? mintAccessToken;
  /* Remembered rather than recomputed: every `state()` that reaches Google costs
     two round-trips, and the answer only changes on events this module sees —
     a settings save, a sign-in, a disconnect, or a grant Google rejected during
     a Run (ADR-0008).
     Only ever holds a state Google told us — `connected` or `expired`. The other
     two are read from stored config every time, so a credential that changes
     without passing through this module cannot be masked by a stale answer. */
  let remembered: GoogleStatus | null = null;

  /**
   * `expiresAbout` is arithmetic over a stored timestamp, never a value Google
   * reported — it does not report one. Shown as an estimate everywhere, because
   * a password change or a revoke ends the grant early and a hard countdown
   * would be a promise the app cannot keep.
   */
  const base = (config: AppConfig) => {
    const lastConnectedAt = config.google.lastConnectedAt;
    /* Withheld until Google has refused this grant once. The seven-day limit
       belongs to a consent screen whose publishing status is Testing; an
       Internal app has no publishing status and no expiry, and this module
       cannot read which it is. Predicting anyway would warn an Internal user
       every week about an event that never arrives. */
    const predictable = lastConnectedAt !== null && config.google.hasExpiredBefore;
    return {
      redirectUri: redirectUriForPort(port),
      scopes: googleScopes(config.tasks.googleTasks.enabled),
      lastConnectedAt,
      expiresAbout: predictable
        ? new Date(
            new Date(lastConnectedAt).getTime() + GOOGLE_TESTING_TOKEN_DAYS * 86_400_000,
          ).toISOString()
        : null,
    };
  };

  /** The states decided by what is stored, before any token is spent. */
  const storedState = (config: AppConfig): GoogleConnectionState | null => {
    if (!config.google.clientId || !config.google.clientSecret) {
      return "unconfigured";
    }
    if (!config.google.refreshToken) {
      return "disconnected";
    }
    return null;
  };

  const remember = (status: GoogleStatus): GoogleStatus => {
    remembered = status;
    return status;
  };

  /**
   * A grant Google refused is a fact about the connection, wherever it came to
   * light. Shared by `observe` and `verifySetup`, so a check cannot learn
   * something a Run would then have to rediscover.
   */
  const noteRejection = (error: unknown): GoogleConnectionState | null => {
    if (!isRejectedGrant(error)) {
      return null;
    }
    /* Latch it before deriving the status: this refusal is what teaches the
       connection that this consent screen expires at all. */
    configStore.markGoogleExpired();
    remembered = { state: "expired", email: null, ...base(configStore.get()) };
    return "expired";
  };

  return {
    async state(): Promise<GoogleStatus> {
      const config = configStore.get();
      const stored = storedState(config);
      if (stored) {
        return { state: stored, email: null, ...base(config) };
      }
      if (remembered) {
        return remembered;
      }
      try {
        const { email } = await probe(config, port);
        return remember({ state: "connected", email, ...base(config) });
      } catch (error) {
        if (isRejectedGrant(error)) {
          return remember({ state: "expired", email: null, ...base(config) });
        }
        /* Google was unreachable, which is not evidence against the token. The
           credentials we hold are still the best answer we have — and it is not
           remembered, so the next call can find out for real. */
        return { state: "connected", email: null, ...base(config) };
      }
    },

    outputs(): OutputsAccess {
      const config = configStore.get();
      const stored = storedState(config);
      if (stored) {
        return { ok: false, state: stored };
      }
      if (remembered?.state === "expired") {
        return { ok: false, state: "expired" };
      }
      return { ok: true, outputs: googleOutputs(config, port) };
    },

    auth(): AuthAccess {
      const config = configStore.get();
      const stored = storedState(config);
      if (stored) {
        return { ok: false, state: stored };
      }
      if (remembered?.state === "expired") {
        return { ok: false, state: "expired" };
      }
      return { ok: true, auth: buildGoogleAuth(config, port) };
    },

    observe(error: unknown): GoogleConnectionState | null {
      return noteRejection(error);
    },

    async verifySetup(): Promise<SetupCheck> {
      const config = configStore.get();
      const stored = storedState(config);
      if (stored) {
        /* Nothing to ask Google: either no credentials, or no token to spend.
           The state alone says which, and the card explains both already. */
        return { state: stored, items: [] };
      }
      const items: SetupCheck["items"] = [];
      let rejected = false;
      /* Google Tasks is checked only when it is enabled. An unchecked optional
         surface is not a failure — nothing in the app is asking for it. */
      const surfaces = GOOGLE_SURFACES.filter(
        (surface) => surface !== "tasks" || config.tasks.googleTasks.enabled,
      );
      for (const surface of surfaces) {
        try {
          await surfaceProbe(config, port, surface);
          items.push({
            label: SURFACE[surface].label,
            ok: true,
            detail: "Google accepted the call.",
          });
        } catch (error) {
          rejected = noteRejection(error) !== null || rejected;
          items.push({
            label: SURFACE[surface].label,
            ok: false,
            detail: googleSurfaceHint(surface, error),
          });
        }
      }
      /* A disabled API is not a broken connection: the token worked, the
         project is simply missing a switch. Only a refused grant changes the
         state the rest of the app sees. */
      return { state: rejected ? "expired" : "connected", items };
    },

    authUrl(): AuthUrlAccess {
      const config = configStore.get();
      if (!config.google.clientId || !config.google.clientSecret) {
        return { ok: false, state: "unconfigured" };
      }
      return { ok: true, url: googleAuthUrl(config, port) };
    },

    async completeSignIn(code: string): Promise<void> {
      let grant: { refreshToken: string; grantedScopes: string[] };
      try {
        grant = await exchange(configStore.get(), port, code);
      } catch (error) {
        if (isRedirectUriMismatch(error)) {
          throw new RedirectUriMismatchError();
        }
        throw error;
      }
      const missing = findMissingScopes(
        grant.grantedScopes,
        googleScopes(configStore.get().tasks.googleTasks.enabled),
      );
      if (missing.length > 0) {
        throw new IncompleteGrantError(missing);
      }
      configStore.setGoogleRefreshToken(grant.refreshToken);
      remembered = null;
    },

    disconnect(): void {
      configStore.setGoogleRefreshToken(null);
      remembered = null;
    },

    invalidate(): void {
      remembered = null;
    },

    async pickerToken(): Promise<PickerTokenAccess> {
      const config = configStore.get();
      const stored = storedState(config);
      if (stored) {
        return { ok: false, state: stored };
      }
      if (remembered?.state === "expired") {
        return { ok: false, state: "expired" };
      }
      // If we have not yet proved the token, ask once; a remembered "connected"
      // stays fast, while a fresh "expired" is discovered here rather than after
      // minting.
      if (!remembered) {
        try {
          await probe(config, port);
          // Probe success implies we could remember connected, but we don't need
          // to — mint will prove it again. Keeping remembered null is fine.
        } catch (error) {
          if (isRejectedGrant(error)) {
            noteRejection(error);
            return { ok: false, state: "expired" };
          }
          // Unreachable — still try to mint; the mint will throw with the same
          // underlying cause.
        }
      }
      try {
        const result = await mint(config, port);
        return { ok: true, token: result.token, expiresAt: result.expiresAt };
      } catch (error) {
        const rejected = noteRejection(error);
        if (rejected) {
          return { ok: false, state: rejected };
        }
        throw error;
      }
    },
  };
}
