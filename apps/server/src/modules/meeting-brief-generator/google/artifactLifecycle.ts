import type {
  GoogleEnrichmentArtifact,
  MeetingBriefEnrichmentSection,
} from "@chief-of-staff-demo/shared";
import type { RunContext } from "../../../engine/module.js";
import { PROVIDER_RETRY_ATTEMPTS, withBoundedRetry } from "../enrichment/helpers.js";

type ArtifactContext = Pick<RunContext, "readFile" | "writeFile">;

function artifactSection(artifact: GoogleEnrichmentArtifact): MeetingBriefEnrichmentSection {
  return {
    source: artifact.source,
    guest: artifact.guestEmail,
    ...(artifact.companyDomain ? { company: artifact.companyDomain } : {}),
    status: artifact.status,
    evidence: artifact.evidence,
    references: artifact.references,
  };
}

function readReusableArtifact(
  ctx: ArtifactContext,
  filename: string,
  eventVersion: string,
): { artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection } | null {
  const raw = ctx.readFile(filename);
  if (!raw) return null;
  try {
    const artifact = JSON.parse(raw) as GoogleEnrichmentArtifact;
    if (
      artifact.eventVersion !== eventVersion ||
      (artifact.status !== "completed" && artifact.status !== "empty")
    ) {
      return null;
    }
    return { artifact, section: artifactSection(artifact) };
  } catch {
    return null;
  }
}

function persistArtifact(
  ctx: ArtifactContext,
  filename: string,
  artifact: GoogleEnrichmentArtifact,
): { artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection } {
  ctx.writeFile(filename, JSON.stringify(artifact, null, 2) + "\n");
  return { artifact, section: artifactSection(artifact) };
}

export async function runArtifactLifecycle(options: {
  ctx: ArtifactContext;
  filename: string;
  eventVersion: string;
  lookup: (attempt: number) => Promise<GoogleEnrichmentArtifact>;
  failure: (error: unknown, attempt: number) => GoogleEnrichmentArtifact;
  onRetry: (error: unknown, attempt: number) => void;
  onSettled: (artifact: GoogleEnrichmentArtifact) => void;
}): Promise<{ artifact: GoogleEnrichmentArtifact; section: MeetingBriefEnrichmentSection }> {
  const reusable = readReusableArtifact(options.ctx, options.filename, options.eventVersion);
  if (reusable) return reusable;

  const outcome = await withBoundedRetry({
    attempt: (attempt) => options.lookup(attempt),
    onRetry: options.onRetry,
  });
  const artifact = outcome.ok
    ? outcome.value
    : options.failure(outcome.error, PROVIDER_RETRY_ATTEMPTS);
  options.onSettled(artifact);
  return persistArtifact(options.ctx, options.filename, artifact);
}
