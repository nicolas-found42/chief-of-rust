import type {
  ContentAngle,
  ContentProjectResearchMode,
  ContentProjectTarget,
} from "@chief-of-staff-demo/shared";
import type { WorkspaceContentProjects } from "./projects.js";

/**
 * The governed Project inputs a person supplies when starting one Project from
 * a selected Content Opportunity. Nothing here bypasses the Content Project's
 * own validation: objective, audience, targets and research mode are checked
 * again when the Project is created.
 */
export interface OpportunityProjectInput {
  objective: string;
  audience: string;
  constraints: string[];
  targets: ContentProjectTarget[];
  researchMode: ContentProjectResearchMode | null;
  seedMaterial: string[];
  authorProfileId?: string;
}

/**
 * The Opportunity→Project seam (#133). Selecting one shortlisted Content
 * Opportunity starts exactly one governed Content Project and records the
 * relationship on it. The call is idempotent per Opportunity: re-selection
 * returns the same Project and creates nothing. Nothing is generated here —
 * the Project's own evidence review and Outline Charter approval remain the only
 * route to generation.
 */
export interface OpportunityProjects {
  start(input: {
    runId: string;
    opportunityId: string;
    title: string;
    angle: ContentAngle;
    angleDescription: string;
    urgency: string;
    sourceUrls: string[];
    brandProfileRevisionId: string;
    project: OpportunityProjectInput;
  }): Promise<{ projectId: string; created: boolean }>;
}

/**
 * The adapter over the Workspace's governed Content Projects. The subject
 * comes from the Opportunity's title; the angle description, urgency, and
 * supporting source URLs become seed material the owner reviews like any
 * other input.
 */
export function contentProjectOpportunityStarter(
  projects: WorkspaceContentProjects,
): OpportunityProjects {
  return {
    async start(input) {
      const existing = projects.projectByOpportunity(input.opportunityId);
      if (existing) {
        return { projectId: existing.id, created: false };
      }
      const personInput = input.project;
      const project = projects.create({
        subject: { kind: "topic", topic: input.title },
        ...(personInput.authorProfileId ? { authorProfileId: personInput.authorProfileId } : {}),
        objective: personInput.objective,
        audience: personInput.audience,
        constraints: personInput.constraints,
        targets: personInput.targets,
        researchMode: personInput.researchMode,
        seedMaterial: [
          ...personInput.seedMaterial,
          `Opportunity angle (${input.angle}): ${input.angleDescription}`,
          `Urgency: ${input.urgency}`,
          ...input.sourceUrls,
        ],
        sourceOpportunity: {
          opportunityId: input.opportunityId,
          runId: input.runId,
          title: input.title,
          angle: input.angle,
          angleDescription: input.angleDescription,
          sourceUrls: [...input.sourceUrls],
          brandProfileRevisionId: input.brandProfileRevisionId,
        },
      });
      return { projectId: project.id, created: true };
    },
  };
}
