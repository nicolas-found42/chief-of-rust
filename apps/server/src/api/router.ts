import type { PersonResearchQueue } from "../person-profile/research-queue.js";
import type { FastifyInstance } from "fastify";
import { DEFAULT_MODELS, ConfigUpdateSchema } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import { redactConfig } from "../config.js";
import {
  googleFailureHint,
  IncompleteGrantError,
  RedirectUriMismatchError,
  type GoogleConnection,
} from "../google/connection.js";
import type { HostedModule } from "../engine/host.js";
import { RunNotFoundError, RunNotRetryableError } from "../engine/runner.js";
import type { Runs } from "../runs.js";
import type { WorkspaceMeetingJoin } from "../meetings/join.js";
import { registerMeetingsApi } from "./meetings.js";
import { registerPeopleApi } from "./people.js";
import { registerContentEngineApi } from "./content-engine.js";
import { registerTasksApi } from "./tasks.js";
import { registerOnboardingApi } from "./onboarding.js";
import type { WorkspaceMeetings } from "../meetings/store.js";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import type { WorkspaceContentProjects } from "../content-projects/projects.js";
import type { PersonProfileResolver } from "../person-profile/resolver.js";
import type { OwnerOnboarding } from "../onboarding/owner.js";
import type { WorkspaceTasks } from "../tasks/tasks.js";
import type { WorkspaceActionItems } from "../tasks/action-items.js";
import type { TaskLinking } from "../tasks/external-link.js";
import type { AsanaLinking } from "../tasks/asana-link.js";

export interface ApiContext {
  runs: Runs;
  port: number;
  configStore: ConfigStore;
  /**
   * Every Module this Shell hosts. A collection rather than one of each thing:
   * no route below reaches for "the" Module, and a Run is retried by whichever
   * Module made it.
   */
  modules: HostedModule[];
  /** The Person Profiles product area's Workspace-owned interface (spec #117). */
  people: WorkspacePersonProfiles;
  /** The Workspace's Meetings, which the Meeting Wizard presents (ADR-0050). */
  meetings: WorkspaceMeetings;
  /** The Meeting join owning match, attach, and merge (issue #165). */
  meetingJoin: WorkspaceMeetingJoin;
  /** Public-web identity resolution behind the typed-identifier lookup. */
  peopleResolver: PersonProfileResolver;
  personResearchQueue?: PersonResearchQueue;
  /** Owner onboarding (issue #123): the proposal/confirmation namespace. */
  onboarding: OwnerOnboarding;
  /** The Content Engine product area's Workspace-owned interface (spec #147). */
  contentProjects: WorkspaceContentProjects;
  /** The Tasks product area's Workspace-owned interface (ADR-0052). */
  tasks: WorkspaceTasks;
  /** The Action Items a Meeting Debrief proposed, which Tasks presents (issue #177). */
  actionItems: WorkspaceActionItems;
  /** Google Tasks as an optional Task Destination (issue #184). */
  taskLinking: TaskLinking;
  /** Asana as an optional Task Destination (issue #189). Required here like
      taskLinking: a composition that forgets it must fail typecheck, not
      surface as a silent "not available" answer at runtime. */
  asanaLinking: AsanaLinking;
  /** The only route to Google: the four states, the consent screen, and sign-out. */
  google: GoogleConnection;
  /**
   * Whether the mock provider exists in this process at all (issue #198). It
   * is a test and explicit-demo posture decided once at composition, never a
   * settings choice: production cannot silently run on fabricated output.
   */
  mockProviderAvailable: boolean;
  onConfigChanged: () => void | Promise<void>;
}

/** A page nobody asked for by hand, and nothing the UI needs beyond it. */
const MAX_RUN_PAGE = 200;

export async function registerApi(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const runs = ctx.runs;
  app.get("/api/health", async () => ({ ok: true }));

  /**
   * One list of Runs with a filter, rather than two endpoints that can
   * disagree. `module` is what each Module's own page passes; `limit` and
   * `cursor` are what the Runs list pages with. No `limit` means every Run,
   * which is what Home asks for because its sentence counts every failure.
   */
  app.get("/api/runs", async (request) => {
    const query = request.query as { module?: string; limit?: string; cursor?: string };
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    return runs.list({
      ...(query.module ? { module: query.module } : {}),
      ...(limit !== undefined && Number.isFinite(limit) && limit > 0
        ? { limit: Math.min(Math.floor(limit), MAX_RUN_PAGE) }
        : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = runs.detail(id);
    if (!detail) {
      reply.code(404).send({ error: "run not found" });
      return;
    }
    return detail;
  });

  app.post("/api/runs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    /* Retried by the Module that made it, found from the Run itself. A Run
       whose Module this Shell no longer hosts is not retryable — there is
       nobody left who knows what re-running it would mean. */
    const handle = runs.open(id);
    if (!handle) {
      reply.code(404).send({ error: `Run not found: ${id}` });
      return;
    }
    const owner = ctx.modules.find((module) => module.id === handle.read().module);
    if (!owner) {
      const module = handle.read().module;
      handle.appendEvent("retry_refused", { condition: "module_not_hosted", module });
      reply
        .code(409)
        .send({ error: `Run is not retryable because its Module ${module} is not hosted: ${id}` });
      return;
    }
    try {
      const meta = await owner.retryRun(id);
      return { status: meta.status };
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        reply.code(404).send({ error: error.message });
        return;
      }
      if (error instanceof RunNotRetryableError) {
        reply.code(409).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/runs/:id/artifacts/:name", async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const handle = runs.open(id);
    if (!handle) {
      reply.code(404).send({ error: "run not found" });
      return;
    }
    let text: string | null;
    try {
      text = handle.readArtifact(name);
    } catch {
      reply.code(400).send({ error: "invalid artifact name" });
      return;
    }
    if (text === null) {
      reply.code(404).send({ error: "artifact not found" });
      return;
    }
    reply.header("content-type", "text/plain; charset=utf-8").send(text);
  });

  app.get("/api/config", async () => ({
    config: redactConfig(ctx.configStore.get()),
    defaults: DEFAULT_MODELS,
    mockAvailable: ctx.mockProviderAvailable,
  }));

  app.put("/api/config", async (request, reply) => {
    const parsed = ConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid config", issues: parsed.error.issues });
      return;
    }
    const update = parsed.data;
    /* The mock posture is the composition's, not the caller's: outside tests
       and explicit demo mode there is no mock provider to switch into, whatever
       the request asks for. A workspace that already runs mock (carried from a
       test or demo run) keeps saving — the Settings card and Home show that
       state plainly instead of stranding every unrelated edit (#198). */
    if (
      update.provider === "mock" &&
      !ctx.mockProviderAvailable &&
      ctx.configStore.get().provider !== "mock"
    ) {
      reply.code(400).send({ error: "mock-provider-unavailable" });
      return;
    }
    const next = ctx.configStore.update(update);
    /* Credentials may have changed under the connection, so what it remembers
       about Google is no longer evidence of anything. */
    ctx.google.invalidate();
    await ctx.onConfigChanged();
    return {
      config: redactConfig(next),
      defaults: DEFAULT_MODELS,
      mockAvailable: ctx.mockProviderAvailable,
    };
  });

  app.get("/api/google/status", async () => ctx.google.state());

  /* Clearing the refresh token is the only way back to a chooser once a token
     is held: Google reuses the last-granted account silently, so switching
     accounts and recovering from a rejected token both start here. */
  app.post("/api/google/disconnect", async () => {
    ctx.google.disconnect();
    await ctx.onConfigChanged();
    return ctx.google.state();
  });

  /* POST, not GET: it spends the refresh token and calls Google twice, so it
     must not be reachable by a link or a prefetch. Person-initiated only
     (ADR-0008). */
  app.post("/api/google/check", async () => ctx.google.verifySetup());

  app.get("/api/google/connect", async (_request, reply) => {
    const access = ctx.google.authUrl();
    if (!access.ok) {
      reply.code(400).send({ error: googleFailureHint(access.state) });
      return;
    }
    return { authUrl: access.url };
  });

  app.get("/api/google/picker-token", async (_request, reply) => {
    try {
      const access = await ctx.google.pickerToken();
      if (!access.ok) {
        reply.code(400).send({ error: googleFailureHint(access.state) });
        return;
      }
      return { token: access.token, expiresAt: access.expiresAt };
    } catch (error) {
      reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });

  app.get("/api/google/callback", async (request, reply) => {
    const query = request.query as { code?: string; error?: string };
    if (query.error || !query.code) {
      /* `access_denied` has one cause worth naming: the account that just
         signed in is not on the consent screen's Test users list, so Google
         refused before issuing anything. Every other refusal is generic, and
         only the app knows the attempt happened at all. */
      const reason = query.error === "access_denied" ? "access_denied" : "error";
      reply.redirect(`/settings?google=${reason}`);
      return;
    }
    try {
      await ctx.google.completeSignIn(query.code);
      await ctx.onConfigChanged();
      reply.redirect("/settings?google=connected");
    } catch (error) {
      if (error instanceof IncompleteGrantError) {
        request.log.warn(error, "Google OAuth incomplete grant");
        const missing = error.missingScopes.join(",");
        reply.redirect(`/settings?google=scope_missing&missing=${encodeURIComponent(missing)}`);
        return;
      }
      if (error instanceof RedirectUriMismatchError) {
        request.log.warn(error, "Google OAuth redirect URI mismatch");
        reply.redirect("/settings?google=redirect_uri_mismatch");
        return;
      }
      request.log.warn(error, "Google OAuth code exchange failed");
      reply.redirect("/settings?google=error");
    }
  });

  /* Each Module's own endpoints, mounted last so the Shell's routes are in
     place first. The Shell holds no list of what a Module serves. */
  for (const module of ctx.modules) {
    await module.routes?.(app);
  }

  /* The Person Profiles product area is a Workspace resource, not a hosted
     Module: its routes hang off the Shell under /api/people (ADR-0043). */
  registerPeopleApi(app, {
    people: ctx.people,
    resolver: ctx.peopleResolver,
    ...(ctx.personResearchQueue ? { research: ctx.personResearchQueue } : {}),
  });
  /* Meetings are a Workspace resource too: the Meeting Wizard presents them,
     and their Transcripts follow them (issue #153). */
  registerMeetingsApi(app, {
    meetings: ctx.meetings,
    join: ctx.meetingJoin,
  });
  /* Owner onboarding (issue #123): the proposal/confirmation namespace, also
     a Workspace resource rather than a hosted Module. */
  registerOnboardingApi(app, { onboarding: ctx.onboarding });
  registerContentEngineApi(app, { contentProjects: ctx.contentProjects });
  /* Tasks (ADR-0052): the fifth product area, a Workspace resource like Person
     Profiles rather than a hosted Module. Its routes reach no provider at all. */
  registerTasksApi(app, {
    tasks: ctx.tasks,
    actionItems: ctx.actionItems,
    linking: ctx.taskLinking,
    asana: ctx.asanaLinking,
    /* The Action Item Policy (issue #181): the Tasks product's own setting,
       read and written on its own routes rather than through `PUT /api/config`
       — turning it on has an outbound consequence the route has to gate. */
    actionItemPolicy: {
      get: () => ctx.configStore.get().tasks.actionItemPolicy,
      set: (policy) => ctx.configStore.setActionItemPolicy(policy),
    },
  });
}
