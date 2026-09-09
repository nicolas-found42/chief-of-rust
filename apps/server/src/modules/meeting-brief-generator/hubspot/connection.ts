import type { ConfigStore } from "../../../config.js";
import type {
  HubSpotProbeState,
  HubSpotSetupCheck,
  HubSpotStatus,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import { hubSpotApi, type HubSpotApi } from "./client.js";
import { readErrorCode, readErrorStatus } from "../enrichment/helpers.js";

export type HubSpotProbeFactory = (token: string) => {
  probe(): Promise<void>;
};

function defaultProbeFactory(token: string) {
  const api = hubSpotApi(token);
  return {
    probe: () => api.listContacts(1).then(() => undefined),
  };
}

/**
 * Per-user HubSpot private-app token — Shell stores secret, classifies state
 * (ADR-0018). Module owns query semantics. No shared Found42 credential.
 *
 * Bounded read-only setup probe distinguishes:
 * missing_configuration, rejected, missing_authority, unavailable, healthy
 * (healthy_empty is healthy with empty data — still success).
 * Leaves no side effect, exposes redacted state only.
 */
export class HubSpotConnection {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly buildProbe: HubSpotProbeFactory = defaultProbeFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): HubSpotStatus {
    const hubspot = this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).hubspot;
    if (!hubspot.token) {
      return { state: "unconfigured", tokenHint: "", lastVerifiedAt: null };
    }
    const tokenHint = `…${hubspot.token.slice(-4)}`;
    return hubspot.lastVerifiedAt
      ? { state: "connected", tokenHint, lastVerifiedAt: hubspot.lastVerifiedAt }
      : { state: "unverified", tokenHint, lastVerifiedAt: null };
  }

  async connect(token: string): Promise<HubSpotStatus> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("A HubSpot private-app token is required.");
    await this.buildProbe(trimmed).probe();
    this.setToken(trimmed, this.now().toISOString());
    return this.status();
  }

  disconnect(): HubSpotStatus {
    this.setToken("", null);
    return this.status();
  }

  api(): HubSpotApi {
    const hubspot = this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).hubspot;
    if (!hubspot.token) throw new Error("Connect your HubSpot private app first.");
    return hubSpotApi(hubspot.token);
  }

  async verifySetup(): Promise<HubSpotSetupCheck> {
    const hubspot = this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID).hubspot;
    const checkedAt = this.now().toISOString();
    if (!hubspot.token) {
      return {
        state: "missing_configuration",
        detail: "HubSpot private-app token is not configured.",
        items: [],
        checkedAt,
      };
    }
    try {
      await this.buildProbe(hubspot.token).probe();
      this.setToken(hubspot.token, checkedAt);
      return {
        state: "healthy",
        detail: "HubSpot accepted the probe. Token is valid with required scopes.",
        items: [{ label: "HubSpot contacts", ok: true, detail: "HubSpot accepted the call." }],
        checkedAt,
      };
    } catch (error) {
      const classified = classifyHubSpotProbeError(error);
      if (classified === "rejected") {
        return {
          state: "rejected",
          detail: "HubSpot rejected the token. Check the private-app token value.",
          items: [
            {
              label: "HubSpot contacts",
              ok: false,
              detail: "HubSpot rejected the credentials (401).",
            },
          ],
          checkedAt,
        };
      }
      if (classified === "missing_authority") {
        return {
          state: "missing_authority",
          detail: "HubSpot token is missing required scopes (contacts/companies/deals read).",
          items: [
            {
              label: "HubSpot contacts",
              ok: false,
              detail: "HubSpot reports missing authority (403).",
            },
          ],
          checkedAt,
        };
      }
      if (classified === "unavailable") {
        return {
          state: "unavailable",
          detail: "HubSpot is currently unavailable. Try again later.",
          items: [
            {
              label: "HubSpot contacts",
              ok: false,
              detail: "HubSpot unavailable or network error.",
            },
          ],
          checkedAt,
        };
      }
      return {
        state: "unavailable",
        detail: error instanceof Error ? error.message : String(error),
        items: [
          {
            label: "HubSpot contacts",
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
        checkedAt,
      };
    }
  }

  private setToken(token: string, lastVerifiedAt: string | null): void {
    const current = this.configStore.getModuleConfig(MEETING_BRIEF_MODULE_ID);
    this.configStore.setModuleConfig(MEETING_BRIEF_MODULE_ID, {
      ...current,
      hubspot: { token, lastVerifiedAt },
    });
  }
}

function classifyHubSpotProbeError(error: unknown): HubSpotProbeState {
  const status = readErrorStatus(error);
  const category = readErrorCode(error);
  const text = error instanceof Error ? error.message : String(error);
  if (
    status === 401 ||
    category === "INVALID_AUTHENTICATION" ||
    /invalid_grant|unauthorized|401/i.test(text)
  ) {
    return "rejected";
  }
  if (
    status === 403 ||
    category === "MISSING_SCOPES" ||
    /MISSING_SCOPES|insufficient.*scope|403/i.test(text) ||
    /missing.*authority/i.test(text)
  ) {
    return "missing_authority";
  }
  if (status !== null && status >= 500 && status < 600) return "unavailable";
  if (status === 429) return "unavailable";
  if (error instanceof TypeError && /fetch|network|ECONNREFUSED|ETIMEDOUT/i.test(text))
    return "unavailable";
  if (status === null && /unavailable|network|timeout|5\d\d/i.test(text)) return "unavailable";
  if (status !== null) return "unavailable";
  return "unavailable";
}
