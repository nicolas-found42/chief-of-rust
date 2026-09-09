import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GoogleStatus } from "@chief-of-staff-demo/shared";
import type { ConfigStore } from "../config.js";
import type { WorkspaceBrandProfileStore } from "../brand-profile/store.js";
import { OwnerOnboarding, OwnerOnboardingError } from "../onboarding/owner.js";

export interface OnboardingApiContext {
  /** The owner-onboarding interface; routes stay thin over it. */
  onboarding: OwnerOnboarding;
}

/**
 * The onboarding product namespace (issue #123): the connected Google
 * identity's owner-Profile proposal and the explicit confirmation that pins
 * it. Every route returns durable resource state or a typed failure
 * classification; no credential material passes through any of them.
 */
export function registerOnboardingApi(app: FastifyInstance, ctx: OnboardingApiContext): void {
  const onboarding = ctx.onboarding;

  app.get("/api/onboarding/owner", async () => {
    return {
      proposal: onboarding.proposal(),
      confirmed: onboarding.confirmed(),
    };
  });

  /* POST, not GET: it writes the durable owner reference. */
  app.post("/api/onboarding/owner/confirm", async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    if (typeof body.profileId !== "string" || !body.profileId.trim()) {
      reply.code(400).send({ error: "invalid-request" });
      return;
    }
    try {
      const confirmed = onboarding.confirm(body.profileId.trim());
      return confirmed;
    } catch (error) {
      if (error instanceof OwnerOnboardingError) {
        reply.code(error.code === "unknown-profile" ? 404 : 409).send({ error: error.code });
        return;
      }
      throw error;
    }
  });
}

/* ── Post-migration onboarding status (issue #144) ──────────────────────────
   The one aggregator behind GET /api/migration/status. Every step's `done` is
   a genuine read of the real store the step configures — never a flag — so
   the onboarding checklist follows the Workspace instead of the ceremony. */

interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
  href: string;
}

export interface OnboardingStatus {
  complete: boolean;
  steps: OnboardingStep[];
}

export interface OnboardingStatusDeps {
  configStore: ConfigStore;
  /** Narrowed to the one read the status makes; no credential surface. */
  googleConnection: { state(): Promise<Pick<GoogleStatus, "state">> };
  ownerOnboarding: OwnerOnboarding;
  brandProfiles: WorkspaceBrandProfileStore;
}

export async function buildOnboardingStatus(deps: OnboardingStatusDeps): Promise<OnboardingStatus> {
  const config = deps.configStore.get();
  const briefConfig = config.modules["meeting-brief-generator"];
  const [google, ownerConfirmed, brandVoice] = await Promise.all([
    deps.googleConnection.state(),
    Promise.resolve(deps.ownerOnboarding.confirmed()),
    Promise.resolve(deps.brandProfiles.current()),
  ]);
  /* A provider is enabled when it needs no key (mock, Ollama) or holds one —
     the same semantics the Settings page applies to the key field. */
  const modelProviderEnabled =
    config.provider === "mock" || config.provider === "ollama" || config.apiKey.trim().length > 0;
  const steps: OnboardingStep[] = [
    {
      id: "provider-enablement",
      label: "Enable providers",
      done: modelProviderEnabled && google.state === "connected",
      href: "/settings",
    },
    {
      id: "owner-profile",
      label: "Confirm the owner Profile",
      done: ownerConfirmed !== null,
      /* The Owner Profile card lives in Settings; "/onboarding" would send the
         owner back to the checklist they clicked from. */
      href: "/settings",
    },
    {
      id: "brand-voice",
      label: "Create Brand Voice",
      done: brandVoice !== null,
      href: "/content-scout",
    },
    {
      id: "internal-domains",
      label: "Select Internal Domains",
      done: briefConfig.internalDomains.length > 0,
      href: "/settings",
    },
    {
      id: "transcript-folder",
      label: "Choose the Transcripts folder",
      done: config.drive.enabled && config.drive.folderId.length > 0,
      href: "/settings",
    },
    {
      id: "sheets-destinations",
      label: "Configure clean Sheets destinations",
      done: config.modules["youtube-trends"].spreadsheetId.length > 0,
      href: "/settings",
    },
    {
      id: "workflow-bundles",
      label: "Configure workflow bundles",
      done: Object.keys(briefConfig.providerPolicy).length > 0,
      href: "/settings",
    },
  ];
  return { complete: steps.every((step) => step.done), steps };
}
