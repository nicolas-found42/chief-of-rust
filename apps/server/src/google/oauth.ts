import { google } from "googleapis";
import type { AppConfig } from "@chief-of-staff-demo/shared";

/** The Google Tasks scope, requested only when the owner enables that surface. */
const GOOGLE_TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/**
 * What every Google capability in this app needs. Google Tasks is deliberately
 * absent (issue #184): filing work into someone's Google account is a choice,
 * and asking for permission to do it before they have made that choice makes
 * every other capability wait on a scope nothing is using.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Meeting Brief delivery owns send-only-to-owner (ADR-0034). This deliberate
  // exception to the draft-only policy requests gmail.send without assuming it;
  // verifySetup probes it read-only and the Module never sends to External Guests.
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive",
  /* ADR-0016: YouTube rides this connection rather than an API key. Read-only
     is the narrowest of the four scopes that answer `videos.list`, and reading
     is all the Module does. Every existing connection must consent once more,
     because a refresh token does not acquire scopes granted after it was
     issued. */
  "https://www.googleapis.com/auth/youtube.readonly",
];

/**
 * The scopes one sign-in asks for. A refresh token does not acquire scopes
 * granted after it was issued, so enabling Google Tasks means consenting once
 * more — which is the honest cost of a least-privilege grant.
 */
export function googleScopes(googleTasksEnabled: boolean): string[] {
  return googleTasksEnabled ? [...GOOGLE_SCOPES, GOOGLE_TASKS_SCOPE] : [...GOOGLE_SCOPES];
}

/** The exact redirect URI that must be registered in Google Cloud Console. */
export function redirectUriForPort(port: number): string {
  return `http://localhost:${port}/api/google/callback`;
}
/** Authorized Google API client used by every google/* module. */
// Follow the auth-library version used by the client we actually construct.
export type GoogleAuth = InstanceType<typeof google.auth.OAuth2>;
export function buildGoogleAuth(config: AppConfig, port: number): GoogleAuth {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port),
  );
  if (config.google.refreshToken) {
    client.setCredentials({ refresh_token: config.google.refreshToken });
  }
  return client;
}

export function googleAuthUrl(config: AppConfig, port: number): string {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port),
  );
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: googleScopes(config.tasks.googleTasks.enabled),
  });
}

export async function exchangeGoogleCode(
  config: AppConfig,
  port: number,
  code: string,
): Promise<{ refreshToken: string; grantedScopes: string[] }> {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port),
  );
  const { tokens } = await client.getToken(code);
  const refresh = tokens.refresh_token;
  if (!refresh) {
    throw new Error("Google did not return a refresh token");
  }
  const scopeString =
    (tokens as { scope?: string }).scope ??
    (tokens as { scopes?: string[] }).scopes?.join(" ") ??
    "";
  const grantedScopes = scopeString
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { refreshToken: refresh, grantedScopes };
}

export async function mintAccessToken(
  config: AppConfig,
  port: number,
): Promise<{ token: string; expiresAt: string | null }> {
  const auth = buildGoogleAuth(config, port);
  const result = await auth.getAccessToken();
  const token =
    (result as { token?: string | null }).token ?? auth.credentials.access_token ?? null;
  if (!token) {
    throw new Error("Google did not return an access token");
  }
  const expiry = auth.credentials.expiry_date ?? null;
  const expiresAt = expiry ? new Date(expiry).toISOString() : null;
  return { token, expiresAt };
}
