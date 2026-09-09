import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SCOPES } from "../../../apps/server/src/google/oauth";
import {
  googleFailureHint,
  isRejectedGrant,
  openGoogleConnection,
  type GoogleConnection,
  type GoogleProbe,
  type GoogleSurface,
  type SurfaceProbe,
} from "../../../apps/server/src/google/connection";
import { ConfigStore } from "../../../apps/server/src/config";

const PORT = 4317;

/** The error gaxios throws when Google will not honour the refresh token again. */
/*
 * googleapis throws an Error carrying the refusal on `response.data.error`, so
 * the doubles here do the same. Both classifiers read that payload before they
 * ever look at `message`, so the Error wrapper changes nothing under test — it
 * just stops the doubles pretending a bare object is throwable.
 */
const REJECTED = Object.assign(new Error("invalid_grant"), {
  response: { data: { error: "invalid_grant" } },
});

let configStore: ConfigStore;
let probeCalls: number;

beforeEach(() => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-connection-"));
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  probeCalls = 0;
});

/** A connection whose token-spending step answers however the test needs it to. */
function connection(answer: GoogleProbe): GoogleConnection {
  const probe: GoogleProbe = async (config, port) => {
    probeCalls += 1;
    return answer(config, port);
  };
  return openGoogleConnection(configStore, PORT, { probe });
}

const signedIn = (email: string | null = "nicolas@found42.com"): GoogleConnection =>
  connection(async () => ({ email }));

const rejected = (): GoogleConnection =>
  connection(async () => {
    throw REJECTED;
  });

function withCredentials(): void {
  configStore.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
}

function withToken(): void {
  withCredentials();
  configStore.setGoogleRefreshToken("stored-refresh-token");
}

/** Google Tasks enabled as a Task Destination, which is what puts it in scope. */
function withGoogleTasks(): void {
  configStore.setGoogleTasksDestination({
    enabled: true,
    taskListId: "list-1",
    taskListTitle: "Work",
  });
}

describe("state — the states decided before a token is spent", () => {
  it("reports unconfigured until both client credentials are stored", async () => {
    const google = signedIn();
    await expect(google.state()).resolves.toMatchObject({ state: "unconfigured", email: null });

    configStore.update({ google: { clientId: "id.apps" } });
    await expect(google.state()).resolves.toMatchObject({ state: "unconfigured" });
    expect(probeCalls).toBe(0);
  });

  it("reports disconnected once credentials are stored but nobody has signed in", async () => {
    withCredentials();
    await expect(signedIn().state()).resolves.toMatchObject({
      state: "disconnected",
      email: null,
    });
    expect(probeCalls).toBe(0);
  });

  it("serves the redirect URI for the running port, and the scopes to register", async () => {
    // The UI used to hardcode both. Registering a URI that differs from the one
    // the server will send by even a character fails the exchange, so the value
    // has to come from the port in use.
    const status = await openGoogleConnection(configStore, 5000).state();
    expect(status.redirectUri).toBe("http://localhost:5000/api/google/callback");
    expect(status.scopes).toEqual([...GOOGLE_SCOPES]);
  });
});

describe("state — the states only Google can settle", () => {
  it("reports connected, with the signed-in address, when the token is honoured", async () => {
    withToken();
    await expect(signedIn().state()).resolves.toMatchObject({
      state: "connected",
      email: "nicolas@found42.com",
    });
  });

  it("reports expired when Google rejects the stored grant", async () => {
    withToken();
    await expect(rejected().state()).resolves.toMatchObject({ state: "expired", email: null });
  });

  it("does not report a lost connection when Google was simply unreachable", async () => {
    // A flight-mode Settings visit must not tell the user to re-run the whole
    // OAuth setup, so an unreachable Google leaves the stored token believed.
    withToken();
    const google = connection(async () => {
      throw new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com");
    });
    await expect(google.state()).resolves.toMatchObject({ state: "connected", email: null });
    // Not remembered either: the next call gets to find out for real.
    await google.state();
    expect(probeCalls).toBe(2);
  });
});

describe("state — what is remembered, and what invalidates it", () => {
  it("asks Google once and answers the rest from what it learned", async () => {
    withToken();
    const google = signedIn();
    await google.state();
    await google.state();
    await google.state();
    expect(probeCalls).toBe(1);
  });

  it("asks again after a sign-out, a settings save, or any explicit invalidation", async () => {
    withToken();
    const google = signedIn();
    await google.state();
    expect(probeCalls).toBe(1);

    google.invalidate();
    await google.state();
    expect(probeCalls).toBe(2);
  });

  it("never lets a remembered answer outlive the credentials it was about", async () => {
    // Config can change without passing through this module. The two stored
    // states are therefore read fresh every time, so a remembered `connected`
    // cannot answer for a workspace whose token has since been cleared.
    withToken();
    const google = signedIn();
    await expect(google.state()).resolves.toMatchObject({ state: "connected" });

    configStore.setGoogleRefreshToken(null);
    await expect(google.state()).resolves.toMatchObject({ state: "disconnected" });
  });
});

describe("outputs — the only route to a Google surface", () => {
  it("refuses, naming the state, before any credentials exist", () => {
    expect(signedIn().outputs()).toEqual({ ok: false, state: "unconfigured" });
    withCredentials();
    expect(signedIn().outputs()).toEqual({ ok: false, state: "disconnected" });
  });

  it("hands out a surface without spending the token", () => {
    withToken();
    const access = signedIn().outputs();
    expect(access.ok).toBe(true);
    // The point of ADR-0008: no round-trip before the Run, and none here.
    expect(probeCalls).toBe(0);
  });

  it("refuses once a Run has proven the grant is dead", async () => {
    withToken();
    const google = signedIn();
    expect(google.outputs().ok).toBe(true);

    expect(google.observe(REJECTED)).toBe("expired");

    // Every later Run refuses immediately rather than repeating the failure.
    expect(google.outputs()).toEqual({ ok: false, state: "expired" });
    // …and the UI is told the same thing, without asking Google again.
    await expect(google.state()).resolves.toMatchObject({ state: "expired" });
    expect(probeCalls).toBe(0);
  });

  it("hands out a surface again after signing back in", async () => {
    withToken();
    const google = signedIn();
    google.observe(REJECTED);
    expect(google.outputs().ok).toBe(false);

    google.invalidate();
    expect(google.outputs().ok).toBe(true);
  });
});

describe("observe", () => {
  it("establishes expired only for a grant Google actually rejected", () => {
    withToken();
    const google = signedIn();
    expect(google.observe(new Error("getaddrinfo ENOTFOUND tasks.googleapis.com"))).toBeNull();
    expect(google.observe({ code: 500 })).toBeNull();
    // A failure that says nothing about the token leaves the surface available.
    expect(google.outputs().ok).toBe(true);

    expect(google.observe(REJECTED)).toBe("expired");
  });
});

describe("authUrl", () => {
  it("refuses while the OAuth client is unconfigured", () => {
    expect(signedIn().authUrl()).toEqual({ ok: false, state: "unconfigured" });
  });

  it("carries the redirect URI, both scopes, and the parameters that yield a refresh token", () => {
    withCredentials();
    const access = signedIn().authUrl();
    expect(access.ok).toBe(true);
    const url = new URL(access.ok ? access.url : "");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `http://localhost:${PORT}/api/google/callback`,
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("disconnect", () => {
  it("clears the stored token and forgets what it knew", async () => {
    withToken();
    const google = signedIn();
    await google.state();

    google.disconnect();

    expect(configStore.get().google.refreshToken).toBeNull();
    // The client credentials survive, so signing back in is one click.
    expect(configStore.get().google.clientId).toBe("id.apps");
    await expect(google.state()).resolves.toMatchObject({ state: "disconnected" });
  });
});

describe("googleFailureHint", () => {
  it("tells the user what to do about each state, and never the wrong thing", () => {
    // The defect this module was built for: an expired token used to fail a Run
    // with "Retry, or check the events below", which retry could never fix.
    expect(googleFailureHint("expired")).toMatch(/expired/i);
    expect(googleFailureHint("expired")).toMatch(/Settings/);
    expect(googleFailureHint("disconnected")).toMatch(/Sign in/i);
    expect(googleFailureHint("unconfigured")).toMatch(/Settings/);
    expect(googleFailureHint("connected")).not.toMatch(/Settings/);
  });
});

describe("isRejectedGrant", () => {
  it("treats Google's invalid_grant as a token that will not work again", () => {
    // The shape gaxios actually throws.
    expect(
      isRejectedGrant({
        response: {
          data: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        },
      }),
    ).toBe(true);
    expect(isRejectedGrant(new Error("invalid_grant: Token has been expired or revoked."))).toBe(
      true,
    );
  });

  it("does not blame the token for a failure that says nothing about it", () => {
    // This is the distinction the connection state rests on: an unreachable
    // Google must not present as a lost connection, or a flight-mode Settings
    // visit would tell the user to re-run the whole OAuth setup.
    expect(isRejectedGrant(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"))).toBe(false);
    expect(isRejectedGrant({ response: { data: { error: "internal_failure" } } })).toBe(false);
    expect(isRejectedGrant({ code: "ECONNRESET" })).toBe(false);
    expect(isRejectedGrant(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The sign-in counter, and the setup check
// ---------------------------------------------------------------------------

/** A 403 shaped the way the Google API clients throw one. */
const apiRefusal = (message: string, reason: string) =>
  Object.assign(new Error(message), {
    response: { data: { error: { code: 403, message, errors: [{ reason }] } } },
  });

const API_DISABLED = apiRefusal(
  "Tasks API has not been used in project 123 before or it is disabled.",
  "accessNotConfigured",
);
const SCOPE_MISSING = apiRefusal(
  "Request had insufficient authentication scopes.",
  "insufficientPermissions",
);

/**
 * A connection whose two surface calls answer however the test needs. The
 * token-spending probe is answered too, so `state()` stays usable alongside it.
 */
function checking(answer: (surface: GoogleSurface) => void): GoogleConnection {
  const surfaceProbe: SurfaceProbe = async (_config, _port, surface) => {
    answer(surface);
  };
  return openGoogleConnection(configStore, PORT, {
    probe: async () => ({ email: "nicolas@found42.com" }),
    surfaceProbe,
  });
}

describe("lastConnectedAt — whether the console work has ever landed", () => {
  it("is null, with no expiry estimate, until a sign-in succeeds", async () => {
    withCredentials();
    await expect(signedIn().state()).resolves.toMatchObject({
      state: "disconnected",
      lastConnectedAt: null,
      expiresAbout: null,
    });
  });

  it("is stamped by a sign-in, but predicts no expiry from the stamp alone", async () => {
    withToken();
    const status = await signedIn().state();
    expect(status.lastConnectedAt).not.toBeNull();
    /* The seven-day limit belongs to a consent screen in Testing. An Internal
       one never expires, and this module cannot read which it is — so it makes
       no prediction rather than announcing a weekly event that never arrives. */
    expect(status.expiresAbout).toBeNull();
  });

  it("predicts seven days out once Google has actually refused a grant", async () => {
    withToken();
    const google = connection(async () => ({ email: null }));
    expect(google.observe(REJECTED)).toBe("expired");
    expect(configStore.get().google.hasExpiredBefore).toBe(true);

    // Signing back in: the latch is precisely what a later success does not undo.
    configStore.setGoogleRefreshToken("fresh-refresh-token");
    google.invalidate();

    const status = await google.state();
    expect(status.state).toBe("connected");
    expect(
      new Date(status.expiresAbout!).getTime() - new Date(status.lastConnectedAt!).getTime(),
    ).toBe(7 * 86_400_000);
  });

  it("survives a deliberate disconnect, because the console work is still done", async () => {
    withToken();
    const google = signedIn();
    const before = (await google.state()).lastConnectedAt;
    expect(before).not.toBeNull();

    google.disconnect();
    // Signed out, but not back to needing the setup steps — which is the whole
    // reason this is a timestamp and not a fifth connection state.
    await expect(google.state()).resolves.toMatchObject({
      state: "disconnected",
      lastConnectedAt: before,
    });
  });
});

describe("verifySetup — asking Google what is missing", () => {
  it("asks Google nothing when there is nothing to ask with", async () => {
    const google = checking(() => {});
    await expect(google.verifySetup()).resolves.toEqual({ state: "unconfigured", items: [] });

    withCredentials();
    await expect(google.verifySetup()).resolves.toEqual({ state: "disconnected", items: [] });
  });

  it("reports every surface working when Google accepts every call", async () => {
    withToken();
    const check = await checking(() => {}).verifySetup();
    expect(check.state).toBe("connected");
    /* YouTube is probed like the rest (ADR-0016): unlike the Picker it has a
       server-side surface, so no step is exempt. Google Tasks is the one
       exception, because it is the one optional surface (issue #184). */
    expect(check.items.map((item) => [item.label, item.ok])).toEqual([
      ["Gmail drafts", true],
      ["Gmail history", true],
      ["Gmail delivery", true],
      ["Google Calendar", true],
      ["Google Drive", true],
      ["YouTube view counts", true],
    ]);
  });

  it("leaves Google Tasks unchecked until it is enabled, and checks it once it is", async () => {
    withToken();
    const probed: GoogleSurface[] = [];
    const record = (surface: GoogleSurface) => {
      probed.push(surface);
    };

    await checking(record).verifySetup();
    expect(probed).not.toContain("tasks");

    withGoogleTasks();
    const check = await checking(record).verifySetup();
    expect(probed).toContain("tasks");
    expect(check.items.at(-1)).toMatchObject({ label: "Google Tasks", ok: true });
  });

  it("names the API that was never enabled, and stays connected", async () => {
    withToken();
    withGoogleTasks();
    const check = await checking((surface) => {
      if (surface === "tasks") {
        throw API_DISABLED;
      }
    }).verifySetup();

    // The token worked; the project is missing a switch. Those are different
    // problems, and calling this a broken connection would send the user to the
    // wrong step.
    expect(check.state).toBe("connected");
    expect(check.items.at(-1)).toMatchObject({ label: "Google Tasks", ok: false });
    expect(check.items.at(-1)?.detail).toContain("Tasks API is not enabled");
    expect(check.items[0]).toMatchObject({ label: "Gmail drafts", ok: true });
  });

  it("names the project Google named, and allows for the propagation delay", async () => {
    withToken();
    withGoogleTasks();
    const check = await checking((surface) => {
      if (surface === "tasks") {
        throw API_DISABLED;
      }
    }).verifySetup();

    /* The console does not switch to a project it has just created, so enabling
       the APIs somewhere else is easy and otherwise invisible. Echoing back the
       project Google named is the only way anyone catches it. */
    expect(check.items.at(-1)?.detail).toContain("project 123");
    // And a correct setup that is merely too new looks identical to a broken one.
    expect(check.items.at(-1)?.detail).toMatch(/few minutes/i);
  });

  it("treats a stale saved sign-in as the first insufficient-scope remedy", async () => {
    withToken();
    const check = await checking((surface) => {
      if (surface === "gmail") {
        throw SCOPE_MISSING;
      }
    }).verifySetup();

    const detail = check.items[0].detail;
    expect(detail).toContain("gmail.compose");
    expect(detail).toMatch(/sign in again first/i);
    expect(detail).toContain("If that does not fix it");
    expect(detail.toLowerCase().indexOf("sign in again first")).toBeLessThan(
      detail.indexOf("Data Access"),
    );
  });

  it("records a refused grant, so a Run does not have to rediscover it", async () => {
    withToken();
    const google = checking(() => {
      throw REJECTED;
    });

    await expect(google.verifySetup()).resolves.toMatchObject({ state: "expired" });
    // ADR-0008: what the check learned is what the connection now knows.
    expect(google.outputs()).toEqual({ ok: false, state: "expired" });
    await expect(google.state()).resolves.toMatchObject({ state: "expired" });
  });

  it("passes an unrecognised refusal through rather than flattening it", async () => {
    withToken();
    const check = await checking(() => {
      throw Object.assign(new Error("Backend error"), {
        response: { data: { error: { code: 500, message: "Backend error", errors: [] } } },
      });
    }).verifySetup();

    expect(check.state).toBe("connected");
    expect(check.items[0].detail).toBe("Backend error");
  });
});
