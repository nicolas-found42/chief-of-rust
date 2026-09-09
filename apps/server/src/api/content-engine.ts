import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CONTENT_PROJECT_TARGETS,
  type ContentProjectEvidenceAttachment,
  type ContentProjectEvidenceSelection,
  type ContentProjectIntentPatch,
  type ContentProjectTarget,
  type OutlineCharterProposalInput,
  type ResearchRequestInput,
} from "@chief-of-staff-demo/shared";
import {
  ContentProjectError,
  type WorkspaceContentProjects,
} from "../content-projects/projects.js";

export interface ContentEngineApiContext {
  /** The Workspace-owned Content Projects interface; routes stay thin over it. */
  contentProjects: WorkspaceContentProjects;
}

/**
 * Which refusals are "that does not exist", and which are "not yet". Everything
 * else a Content Project refuses is a malformed request. The mapping lives here
 * and nowhere else: a route never decides whether an operation is allowed, it
 * only says which kind of no it received.
 */
const NOT_FOUND_CODES = new Set<ContentProjectError["code"]>([
  "project-not-found",
  "profile-not-found",
  "outline-charter-not-found",
  "outline-not-found",
]);
const GATE_CODES = new Set<ContentProjectError["code"]>([
  "owner-not-confirmed",
  "author-forbidden",
  "opportunity-already-linked",
  "evidence-freeze-blocked",
  "outline-charter-blocked",
  "outline-generation-blocked",
  "draft-generation-blocked",
  "research-request-blocked",
]);

function projectFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof ContentProjectError) {
    reply.code(NOT_FOUND_CODES.has(error.code) ? 404 : GATE_CODES.has(error.code) ? 409 : 400);
    reply.header("content-type", "application/json; charset=utf-8");
    /* `missingGates` travels with the refusal so the surface can name what is
       missing instead of rendering a bare "not ready". */
    reply.send({ error: error.code, message: error.message, missingGates: error.missingGates });
    return;
  }
  throw error;
}

function parseTarget(value: string | undefined): ContentProjectTarget | null {
  return CONTENT_PROJECT_TARGETS.includes(value as ContentProjectTarget)
    ? (value as ContentProjectTarget)
    : null;
}

function unknownTarget(reply: FastifyReply, value: string | undefined): void {
  reply.code(400);
  reply.send({
    error: "unknown-target",
    message: `Not a publication target: ${value}. Known targets: ${CONTENT_PROJECT_TARGETS.join(", ")}.`,
    missingGates: [],
  });
}

/**
 * The Content Engine product namespace (spec #147). Content Projects is a
 * Workspace resource and not a Module — it owns no Runs, Intakes or Output
 * Adapters — so its routes are registered beside the other Workspace resources
 * rather than from a Module host, exactly as Person Profiles is.
 *
 * Every route below is a translation: parse, call one method on
 * `WorkspaceContentProjects`, map its refusal to a status. The gates, the
 * ordering rules and the immutability rules stay in the domain module, where
 * they are already covered. A route that starts deciding whether something is
 * allowed has drifted.
 */
export function registerContentEngineApi(app: FastifyInstance, ctx: ContentEngineApiContext): void {
  const projects = ctx.contentProjects;

  app.get("/api/content-engine/projects", async () => ({ projects: projects.list() }));

  app.get("/api/content-engine/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = projects.get(projectId);
    if (!project) {
      reply.code(404);
      return {
        error: "project-not-found",
        message: "No Content Project with that id.",
        missingGates: [],
      };
    }
    return { project, readiness: projects.readiness(projectId) };
  });

  app.get("/api/content-engine/projects/:projectId/readiness", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return projects.readiness(projectId);
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post("/api/content-engine/projects/:projectId/revisions", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      const patch: ContentProjectIntentPatch = request.body ?? {};
      return projects.reviseIntent(projectId, patch);
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post("/api/content-engine/projects/:projectId/evidence", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return projects.attachEvidence(
        projectId,
        (request.body ?? {}) as ContentProjectEvidenceAttachment,
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post("/api/content-engine/projects/:projectId/evidence/freeze", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return projects.freezeEvidence(
        projectId,
        (request.body ?? {}) as ContentProjectEvidenceSelection,
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.get("/api/content-engine/projects/:projectId/prompt-evidence", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      /* Null is the honest answer before a freeze, not a 404: the Project
         exists, its evidence simply is not frozen yet. */
      return { promptEvidence: projects.promptEvidence(projectId) };
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post("/api/content-engine/projects/:projectId/research", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return await projects.runResearchRequest(
        projectId,
        (request.body ?? {}) as ResearchRequestInput,
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post("/api/content-engine/projects/:projectId/outline-charters", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      return projects.proposeOutlineCharter(
        projectId,
        (request.body ?? {}) as OutlineCharterProposalInput,
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post(
    "/api/content-engine/projects/:projectId/outline-charters/:outlineCharterId/approve",
    async (request, reply) => {
      const { projectId, outlineCharterId } = request.params as {
        projectId: string;
        outlineCharterId: string;
      };
      try {
        return projects.approveOutlineCharter(projectId, outlineCharterId);
      } catch (error) {
        return projectFailure(reply, error);
      }
    },
  );

  app.post("/api/content-engine/projects/:projectId/outlines/:target", async (request, reply) => {
    const { projectId, target } = request.params as { projectId: string; target: string };
    const parsed = parseTarget(target);
    if (!parsed) return unknownTarget(reply, target);
    const body = (request.body ?? {}) as { instruction?: string };
    try {
      return await projects.generateOutline(
        projectId,
        parsed,
        body.instruction === undefined ? {} : { instruction: body.instruction },
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  /* The nine-target Outline Set with missing-only retry (#132): the same route
     generates and retries, because the domain decides which targets are still
     missing — asking the surface to track that would duplicate the rule. */
  app.post("/api/content-engine/projects/:projectId/outlines", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = (request.body ?? {}) as { concurrency?: number };
    try {
      return await projects.generateOutlineSet(
        projectId,
        body.concurrency === undefined ? {} : { concurrency: body.concurrency },
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });

  app.post(
    "/api/content-engine/projects/:projectId/outlines/:target/approve",
    async (request, reply) => {
      const { projectId, target } = request.params as { projectId: string; target: string };
      const parsed = parseTarget(target);
      if (!parsed) return unknownTarget(reply, target);
      try {
        return projects.approveOutline(projectId, parsed);
      } catch (error) {
        return projectFailure(reply, error);
      }
    },
  );

  app.post("/api/content-engine/projects/:projectId/drafts/:target", async (request, reply) => {
    const { projectId, target } = request.params as { projectId: string; target: string };
    const parsed = parseTarget(target);
    if (!parsed) return unknownTarget(reply, target);
    const body = (request.body ?? {}) as { instruction?: string };
    try {
      return await projects.generateDraft(
        projectId,
        parsed,
        body.instruction === undefined ? {} : { instruction: body.instruction },
      );
    } catch (error) {
      return projectFailure(reply, error);
    }
  });
}
