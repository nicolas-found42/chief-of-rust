import { PersonDossierQueries } from "../person-profile/dossier-queries.js";
import type { FastifyInstance } from "fastify";
import {
  type PersonRelationshipRecord,
  PersonDossierQuerySchema,
  PersonResearchSettingsSchema,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import type { PersonDossierStore } from "../person-profile/dossier-store.js";
import type { PersonResearchQueue } from "../person-profile/research-queue.js";

export function registerPersonDossierApi(
  app: FastifyInstance,
  deps: {
    people: WorkspacePersonProfiles;
    dossiers: PersonDossierStore;
    queue: PersonResearchQueue;
    history?: (profileId: string) => PersonRelationshipRecord[];
  },
): void {
  const view = (id: string) => ({
    dossier: deps.dossiers.get(id),
    research: deps.queue.job(id),
  });
  app.get<{ Params: { profileId: string; revision: string } }>(
    "/api/people/:profileId/dossier/revisions/:revision",
    async (request, reply) => {
      const revision = Number(request.params.revision);
      if (!Number.isInteger(revision) || revision < 1)
        return reply.code(400).send({ error: "invalid-revision" });
      return (
        deps.dossiers.getRevision(request.params.profileId, revision) ??
        reply.code(404).send({ error: "revision-not-found" })
      );
    },
  );
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/relationship-history",
    async (request, reply) => {
      if (!deps.people.get(request.params.profileId))
        return reply.code(404).send({ error: "profile-not-found" });
      return deps.history?.(request.params.profileId) ?? [];
    },
  );
  const queries = new PersonDossierQueries(deps);
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/dossier-analysis",
    async (request, reply) =>
      queries.analyse(request.params.profileId, "private") ??
      reply.code(404).send({ error: "dossier-not-found" }),
  );
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/people/connection-path",
    async (request, reply) => {
      if (!request.query.from || !request.query.to)
        return reply.code(400).send({ error: "two-profiles-required" });
      return {
        path: queries.connectionPath(request.query.from, request.query.to, "private"),
        scope:
          "Documented connections only. A path does not establish an introduction, access, willingness or availability.",
      };
    },
  );
  app.post("/api/people/dossier-query", async (request, reply) => {
    const input = PersonDossierQuerySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid-dossier-query" });
    return queries.search(input.data);
  });
  app.get("/api/people/research/status", async () => deps.queue.status());
  app.patch("/api/people/research/settings", async (request, reply) => {
    const parsed = PersonResearchSettingsSchema.partial().strict().safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "invalid-research-settings",
        message: "Research limits must be within the supported ranges.",
      });
    /* The queue owns the merge onto its live settings; sending it a whole
       object here would re-assert `paused` on every unrelated edit and cancel
       in-flight research for a changed refresh interval (#207). */
    return deps.queue.configure(parsed.data);
  });
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/dossier",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      deps.queue.enqueue(id, "viewed");
      return view(id);
    },
  );
  app.post<{ Params: { profileId: string } }>(
    "/api/people/:profileId/research",
    async (request, reply) => {
      const id = request.params.profileId;
      const person = deps.people.get(id);
      if (!person) return reply.code(404).send({ error: "profile-not-found" });
      if (person.archivedAt || person.mergedInto)
        return reply.code(409).send({ error: "profile-inactive" });
      deps.queue.enqueue(id, "explicit");
      return reply.code(202).send(view(id));
    },
  );
  app.post<{ Params: { profileId: string; sourceId: string } }>(
    "/api/people/:profileId/sources/:sourceId/detach",
    async (request, reply) => {
      const { profileId, sourceId } = request.params;
      if (!deps.people.get(profileId) || !deps.dossiers.source(profileId, sourceId))
        return reply.code(404).send({ error: "source-not-found" });
      deps.queue.remove(profileId);
      deps.dossiers.detach(profileId, sourceId);
      deps.people.forgetResearchSource(profileId, sourceId);
      return view(profileId);
    },
  );
  app.get<{ Params: { profileId: string; sourceId: string } }>(
    "/api/people/:profileId/sources/:sourceId",
    async (request, reply) => {
      const { profileId, sourceId } = request.params;
      if (!deps.people.get(profileId)) return reply.code(404).send({ error: "profile-not-found" });
      const source = deps.dossiers.source(profileId, sourceId);
      return source ?? reply.code(404).send({ error: "source-not-found" });
    },
  );
}
