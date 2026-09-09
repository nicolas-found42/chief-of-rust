import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig, GoogleStatus } from "@chief-of-staff-demo/shared";
import { registerApi, type ApiContext } from "../../../apps/server/src/api/router";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { OwnerOnboarding } from "../../../apps/server/src/onboarding/owner";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { ConfigStore } from "../../../apps/server/src/config";
import {
  googleFailureHint,
  openGoogleConnection,
} from "../../../apps/server/src/google/connection";

const PORT = 4317;

let app: FastifyInstance;
let configStore: ConfigStore;
let workspaceDir: string;
let configChangeCompleted: boolean;

/** A workspace on disk, so the config the endpoints write is the one they read back. */
beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cos-google-"));
  mkdirSync(join(workspaceDir, "runs"), { recursive: true });
  configStore = new ConfigStore(join(workspaceDir, "config.json"));
  configStore.load();
  configChangeCompleted = false;

  app = fastify({ logger: false });
  const peopleProfiles = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const ownerOnboarding = new OwnerOnboarding({ people: peopleProfiles, workspaceDir });
  await registerApi(
    app,
    fromPartial<ApiContext>({
      port: PORT,
      configStore,
      modules: [],
      /* The real module, so the states below are the ones the server derives
         rather than ones the test asserts into existence. Its probe never runs:
         every state here is decided before a token is spent. */
      google: openGoogleConnection(configStore, PORT, {
        probe: async () => {
          throw new Error("no test reaches Google");
        },
      }),
      people: peopleProfiles,
      onboarding: ownerOnboarding,
      onConfigChanged: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        configChangeCompleted = true;
      },
    }),
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function status() {
  return app.inject({ method: "GET", url: "/api/google/status" });
}

function storedConfig(): AppConfig {
  const parsed: AppConfig = JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf8"));
  return parsed;
}

describe("GET /api/google/status", () => {
  it("reports unconfigured on a fresh workspace, with the setup values to register", async () => {
    const response = await status();
    expect(response.statusCode).toBe(200);
    const body = response.json<GoogleStatus>();
    expect(body.state).toBe("unconfigured");
    expect(body.email).toBeNull();
    expect(body.redirectUri).toBe(`http://localhost:${PORT}/api/google/callback`);
    expect(body.scopes).toContain("https://www.googleapis.com/auth/gmail.compose");
  });

  it("reports disconnected once client credentials are saved", async () => {
    configStore.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
    expect((await status()).json<GoogleStatus>().state).toBe("disconnected");
  });
});

describe("POST /api/google/disconnect", () => {
  it("clears the stored refresh token and reports disconnected", async () => {
    configStore.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
    configStore.setGoogleRefreshToken("stored-refresh-token");

    const response = await app.inject({ method: "POST", url: "/api/google/disconnect" });
    expect(response.statusCode).toBe(200);
    expect(response.json<GoogleStatus>().state).toBe("disconnected");
    // Cleared on disk, not just in memory: the next process start must agree.
    expect(storedConfig().google.refreshToken).toBeNull();
    // The client credentials survive, so signing back in is one click.
    expect(storedConfig().google.clientId).toBe("id.apps");
    expect(storedConfig().google.clientSecret).toBe("secret");
    expect(configChangeCompleted).toBe(true);
  });
});

describe("GET /api/google/connect", () => {
  it("refuses with a 400 that names what is missing", async () => {
    const response = await app.inject({ method: "GET", url: "/api/google/connect" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(googleFailureHint("unconfigured"));
  });

  it("hands back a Google consent URL carrying the redirect URI and the scopes in use", async () => {
    configStore.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
    const response = await app.inject({ method: "GET", url: "/api/google/connect" });
    expect(response.statusCode).toBe(200);

    const authUrl = new URL(response.json().authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe("id.apps");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `http://localhost:${PORT}/api/google/callback`,
    );
    // offline + consent is what returns a refresh token at all; without both the
    // exchange yields an access token that dies in an hour with no way to renew.
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("scope")).toContain("gmail.compose");
    /* Least privilege (issue #184): the Tasks scope is not part of a grant
       nobody has asked for, and every other capability is reachable without
       it. */
    expect(authUrl.searchParams.get("scope")).not.toContain("auth/tasks");
  });

  it("asks for the Tasks scope once Google Tasks is enabled as a Task Destination", async () => {
    configStore.update({ google: { clientId: "id.apps", clientSecret: "secret" } });
    configStore.setGoogleTasksDestination({
      enabled: true,
      taskListId: "list-1",
      taskListTitle: "Work",
    });

    const response = await app.inject({ method: "GET", url: "/api/google/connect" });

    const scope = new URL(response.json().authUrl).searchParams.get("scope");
    expect(scope).toContain("https://www.googleapis.com/auth/tasks");
    expect(scope).toContain("gmail.compose");
  });
});

describe("POST /api/google/check", () => {
  it("is a POST, because it spends the token and calls Google", async () => {
    // A GET would be reachable by a link or a browser prefetch, and this is not
    // a read: it is two deliberate calls on the user's Google account.
    const asGet = await app.inject({ method: "GET", url: "/api/google/check" });
    expect(asGet.statusCode).toBe(404);
  });

  it("asks Google nothing, and says so, while the connection is unconfigured", async () => {
    const response = await app.inject({ method: "POST", url: "/api/google/check" });
    expect(response.statusCode).toBe(200);
    // No credentials to call with. The empty item list is what the card turns
    // into "finish the steps and sign in, then check".
    expect(response.json()).toEqual({ state: "unconfigured", items: [] });
  });
});
