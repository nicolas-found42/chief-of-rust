import { useEffect, useState } from "react";
import type {
  GoogleStatus,
  HubSpotSetupCheck,
  HubSpotStatus,
  SetupCheck,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { relayApi } from "../clients/workspace";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";

interface RelayStatus {
  installationId: string | null;
  relayBaseUrl: string | null;
  relayHealth: "ok" | "unreachable" | "not_configured";
  channels: Array<{ channelId: string; expiration: string | null; resourceId: string | null }>;
  lastWakeUpAt: string | null;
  hasSecret: boolean;
}

/** Human labels for the bundle vocabulary; the ids themselves are the contract. */
const PROVIDER_LABELS: Record<string, string> = {
  "person-profile": "Person Profile",
  "gmail-relationship": "Gmail relationship evidence",
  "gmail-company-domain": "Gmail company domain",
  "calendar-history": "Calendar history",
  "drive-workspace": "Drive Workspace evidence",
  crm: "HubSpot CRM",
  "employer-proposal": "Employer proposal",
  "public-intelligence": "Public person and company intelligence",
  "confirmed-transcripts": "Confirmed transcripts",
};

export function MeetingBriefSettings({
  googleStatus,
  googleCheck,
  client = meetingsApi,
}: {
  googleStatus: GoogleStatus | null;
  googleCheck: SetupCheck | null;
  client?: MeetingsClient;
}) {
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const [relayBaseUrl, setRelayBaseUrl] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [internalDomains, setInternalDomains] = useState("");
  const [domainsBusy, setDomainsBusy] = useState(false);
  const [domainsNotice, setDomainsNotice] = useState<string | null>(null);
  const [hubSpotStatus, setHubSpotStatus] = useState<HubSpotStatus | null>(null);
  const [hubSpotToken, setHubSpotToken] = useState("");
  const [hubSpotBusy, setHubSpotBusy] = useState(false);
  const [hubSpotError, setHubSpotError] = useState<string | null>(null);
  const [hubSpotCheck, setHubSpotCheck] = useState<HubSpotSetupCheck | null>(null);
  const [checkingHubSpot, setCheckingHubSpot] = useState(false);
  const [bundleProviders, setBundleProviders] = useState<string[]>([]);
  const [bundleDisabled, setBundleDisabled] = useState<string[]>([]);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleNotice, setBundleNotice] = useState<string | null>(null);
  const [bundleRecorded, setBundleRecorded] = useState(false);

  const refreshRelay = async () => {
    try {
      const status = await relayApi.status();
      setRelayStatus(status);
      if (status.relayBaseUrl) setRelayBaseUrl(status.relayBaseUrl);
    } catch (error) {
      setRelayError(errorMessage(error));
    }
  };

  const refreshHubSpot = async () => {
    try {
      setHubSpotStatus(await client.hubspotStatus());
    } catch (error) {
      setHubSpotError(errorMessage(error));
    }
  };

  useEffect(() => {
    void refreshRelay();
    void client
      .hubspotStatus()
      .then((status) => setHubSpotStatus(status))
      .catch((error: unknown) => setHubSpotError(errorMessage(error)));
    void client
      .meetingBriefConfig()
      .then((config) => setInternalDomains(config.internalDomains.join(", ")))
      .catch((error: unknown) => setDomainsNotice(errorMessage(error)));
    void client
      .meetingBriefProviderPolicy()
      .then((state) => {
        setBundleProviders(state.providers);
        setBundleDisabled(
          Object.entries(state.policy)
            .filter(([, entry]) => entry.disabled)
            .map(([provider]) => provider),
        );
        setBundleRecorded(Object.keys(state.policy).length > 0);
      })
      .catch((error: unknown) => setBundleNotice(errorMessage(error)));
  }, [client]);

  const runRelayAction = async (action: () => Promise<unknown>) => {
    if (relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    try {
      await action();
      await refreshRelay();
    } catch (error) {
      setRelayError(errorMessage(error));
    } finally {
      setRelayBusy(false);
    }
  };

  const saveBundlePolicy = async () => {
    if (bundleBusy) return;
    setBundleBusy(true);
    setBundleNotice(null);
    try {
      const state = await client.saveMeetingBriefProviderPolicy(bundleDisabled);
      setBundleRecorded(Object.keys(state.policy).length > 0);
      setBundleNotice(
        bundleDisabled.length === 0
          ? "Policy recorded — every bundle provider is required."
          : `Policy recorded — ${String(bundleDisabled.length)} provider(s) disabled.`,
      );
    } catch (error) {
      setBundleNotice(errorMessage(error));
    } finally {
      setBundleBusy(false);
    }
  };

  const saveDomains = async () => {
    if (domainsBusy) return;
    setDomainsBusy(true);
    setDomainsNotice(null);
    try {
      const domains = internalDomains
        .split(/[\n,]/)
        .map((domain) => domain.trim())
        .filter(Boolean);
      const result = await client.saveMeetingBriefConfig({ internalDomains: domains });
      setInternalDomains(result.internalDomains.join(", "));
      setDomainsNotice("Internal domains saved.");
    } catch (error) {
      setDomainsNotice(errorMessage(error));
    } finally {
      setDomainsBusy(false);
    }
  };

  const connectHubSpot = async () => {
    if (hubSpotBusy) return;
    setHubSpotBusy(true);
    setHubSpotError(null);
    try {
      setHubSpotStatus(await client.hubspotConnect(hubSpotToken.trim()));
      setHubSpotToken("");
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setHubSpotBusy(false);
    }
  };

  const disconnectHubSpot = async () => {
    if (hubSpotBusy) return;
    setHubSpotBusy(true);
    setHubSpotError(null);
    setHubSpotCheck(null);
    try {
      setHubSpotStatus(await client.hubspotDisconnect());
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setHubSpotBusy(false);
    }
  };

  const checkHubSpot = async () => {
    if (checkingHubSpot) return;
    setCheckingHubSpot(true);
    setHubSpotError(null);
    try {
      setHubSpotCheck(await client.hubspotCheck());
      await refreshHubSpot();
    } catch (error) {
      setHubSpotError(errorMessage(error));
    } finally {
      setCheckingHubSpot(false);
    }
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="section-relay">
        <h2 id="section-relay">Calendar Relay</h2>
        <div className="card">
          <p className="muted">
            Opaque calendar wake-up relay (ADR-0031). Stores only installation, channel, message,
            expiry and ack metadata.
          </p>
          {relayStatus ? (
            <div className="field-grid">
              <p>
                <strong>Installation:</strong> {relayStatus.installationId ?? "— not registered"}
              </p>
              <p>
                <strong>Relay URL:</strong> {relayStatus.relayBaseUrl ?? "—"}
              </p>
              <p>
                <strong>Relay health:</strong> {relayStatus.relayHealth}
              </p>
              <p>
                <strong>Channels:</strong> {relayStatus.channels.length}
                {relayStatus.channels.length > 0
                  ? ` — ${relayStatus.channels.map((channel) => channel.channelId).join(", ")}`
                  : ""}
              </p>
              <p>
                <strong>Last wake-up:</strong> {relayStatus.lastWakeUpAt ?? "— none yet"}
              </p>
              <p className="muted">Secrets are kept in Workspace and never shown here.</p>
            </div>
          ) : (
            <p className="muted" role="status">
              Loading relay status…
            </p>
          )}
          <div className="field">
            <label htmlFor="relay-base-url">Public relay base URL</label>
            <input
              id="relay-base-url"
              type="url"
              value={relayBaseUrl}
              onChange={(event) => setRelayBaseUrl(event.target.value)}
              placeholder="https://relay.example.com"
            />
            <p className="muted field-hint">
              Use the stable public HTTPS URL of the separately deployed relay so Google can reach
              its /google/push callback.
            </p>
          </div>
          {relayError ? (
            <p className="field-error" role="alert">
              {relayError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() =>
                void runRelayAction(() => relayApi.install(relayBaseUrl.trim() || undefined))
              }
              aria-disabled={relayBusy}
            >
              {relayBusy ? "Working…" : "Register / Update relay"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void runRelayAction(() => relayApi.poll())}
              aria-disabled={relayBusy}
            >
              Poll now
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void refreshRelay()}
              aria-disabled={relayBusy}
            >
              Refresh status
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="section-meeting-brief">
        <h2 id="section-meeting-brief">Meeting Brief Generator</h2>
        <div className="card" role="group" aria-labelledby="group-meeting-brief-domains">
          <h3 id="group-meeting-brief-domains">Internal Domains</h3>
          <p className="muted">
            Email domains belonging to your organization. Attendees from these domains are not
            treated as External Guests. Consumer domains remain external and are never employer
            evidence.
          </p>
          <div className="field">
            <label htmlFor="meeting-brief-domains">
              Internal Domains (comma or newline separated)
            </label>
            <input
              id="meeting-brief-domains"
              value={internalDomains}
              onChange={(event) => setInternalDomains(event.target.value)}
              placeholder="example.com, internal.example.org"
              aria-describedby="meeting-brief-domains-hint"
            />
            <p id="meeting-brief-domains-hint" className="muted field-hint">
              Saved domains are normalized to lower case and duplicates are removed.
            </p>
          </div>
          {domainsNotice ? <p role="status">{domainsNotice}</p> : null}
          <button
            type="button"
            className="action-button"
            onClick={() => void saveDomains()}
            aria-disabled={domainsBusy}
          >
            {domainsBusy ? "Saving…" : "Save domains"}
          </button>
        </div>

        <div className="card" role="group" aria-labelledby="group-meeting-brief-bundles">
          <h3 id="group-meeting-brief-bundles">Workflow bundles</h3>
          <p className="muted">
            Every provider a bundle selects is required: a Brief is never presented as complete when
            configured evidence is missing. A provider leaves the required set only through an
            explicit action here — policy never relaxes silently.
          </p>
          {bundleProviders.length === 0 ? (
            <p className="muted" role="status">
              Loading bundle providers…
            </p>
          ) : (
            <ul className="setup-check-list">
              {bundleProviders.map((provider) => (
                <li key={provider}>
                  <label htmlFor={`bundle-${provider}`}>
                    <input
                      id={`bundle-${provider}`}
                      type="checkbox"
                      checked={!bundleDisabled.includes(provider)}
                      onChange={(event) =>
                        setBundleDisabled((current) =>
                          event.target.checked
                            ? current.filter((id) => id !== provider)
                            : [...current, provider],
                        )
                      }
                    />{" "}
                    {PROVIDER_LABELS[provider] ?? provider}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted field-hint">
            {bundleRecorded
              ? "A policy is recorded for this Workspace."
              : "No policy recorded yet — save once to confirm the bundle, even if you disable nothing."}
          </p>
          {bundleNotice ? <p role="status">{bundleNotice}</p> : null}
          <button
            type="button"
            className="action-button"
            onClick={() => void saveBundlePolicy()}
            aria-disabled={bundleBusy}
          >
            {bundleBusy ? "Saving…" : "Save bundle policy"}
          </button>
        </div>

        <div className="card" role="group" aria-labelledby="group-hubspot">
          <h3 id="group-hubspot">HubSpot CRM</h3>
          <p className="muted">
            Per-user private-app token for read-only contacts, companies, and deals. Status exposes
            only a redacted hint.
          </p>
          {hubSpotStatus ? (
            <p role="status">
              <strong>Status:</strong> {hubSpotStatus.state}
              {hubSpotStatus.tokenHint ? ` (${hubSpotStatus.tokenHint})` : ""}
              {hubSpotStatus.lastVerifiedAt
                ? ` — last verified ${hubSpotStatus.lastVerifiedAt}`
                : ""}
            </p>
          ) : (
            <p className="muted" role="status">
              Loading HubSpot status…
            </p>
          )}
          <div className="field">
            <label htmlFor="hubspot-token">HubSpot private-app token</label>
            <input
              id="hubspot-token"
              type="password"
              value={hubSpotToken}
              onChange={(event) => setHubSpotToken(event.target.value)}
              placeholder="pat-na1-..."
              autoComplete="off"
            />
            <p className="muted field-hint">
              Required scopes: crm.objects.contacts.read, crm.objects.companies.read, and
              crm.objects.deals.read.
            </p>
          </div>
          {hubSpotError ? (
            <p className="field-error" role="alert">
              {hubSpotError}
            </p>
          ) : null}
          <div className="field-row">
            <button
              type="button"
              className="action-button"
              onClick={() => void connectHubSpot()}
              disabled={hubSpotToken.trim() === ""}
              aria-disabled={hubSpotBusy}
            >
              {hubSpotBusy ? "Connecting…" : "Connect HubSpot"}
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void disconnectHubSpot()}
              disabled={hubSpotStatus?.state === "unconfigured"}
              aria-disabled={hubSpotBusy}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="action-button"
              onClick={() => void checkHubSpot()}
              disabled={hubSpotStatus?.state === "unconfigured"}
              aria-disabled={checkingHubSpot}
            >
              {checkingHubSpot ? "Checking…" : "Check my setup"}
            </button>
          </div>
          {hubSpotCheck ? (
            <div className="banner" role="status">
              <p>
                <strong>Probe:</strong> {hubSpotCheck.state} — {hubSpotCheck.detail}
              </p>
              {hubSpotCheck.items.length > 0 ? (
                <ul>
                  {hubSpotCheck.items.map((item) => (
                    <li key={item.label}>
                      {item.label}: {item.ok ? "ok" : "failed"} — {item.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="muted">Checked at {hubSpotCheck.checkedAt}</p>
            </div>
          ) : null}
        </div>

        <div className="card" role="group" aria-labelledby="group-person-profiles">
          <h3 id="group-person-profiles">Person Profiles</h3>
          <p className="muted">
            Reusable, evidence-backed identity records for people encountered across Modules.
            Meeting Brief Generator resolves each external attendee from their email and displayed
            name, then preserves the exact profile revision used by the brief.
          </p>
          <p role="status">
            <strong>Sources:</strong> connected HubSpot records, public-web mentions and social
            references, and feeds declared by high-confidence matched personal sites.
          </p>
          <p className="muted field-hint">
            Email addresses, full names, handles, profile URLs, and employer clues participate in
            identity matching. LinkedIn enters only through publicly indexed references or a future
            explicitly authorized adapter—never an imported browser session or CAPTCHA bypass.
          </p>
        </div>

        <div className="card" role="group" aria-labelledby="group-google-meeting-brief">
          <h3 id="group-google-meeting-brief">Google — Calendar, Gmail, Drive</h3>
          <p className="muted">
            Required scopes: calendar.readonly, gmail.readonly, gmail.send, gmail.compose, and
            drive. Use Check my setup in the Google card above to verify scopes and API enablement.
          </p>
          <p role="status" className="muted">
            Google: {googleStatus?.state ?? "loading"}{" "}
            {googleStatus?.email ? `as ${googleStatus.email}` : ""}
          </p>
          {googleCheck ? (
            <ul>
              {googleCheck.items.map((item) => (
                <li key={item.label}>
                  {item.label}: {item.ok ? "ok" : "failed"} — {item.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Run Check my setup above to see per-surface results.</p>
          )}
        </div>
        <div className="card" role="group" aria-labelledby="group-relay-summary">
          <h3 id="group-relay-summary">Calendar Relay (opaque)</h3>
          <p className="muted">
            Relay stores no Calendar credentials or event data. Relay health:{" "}
            {relayStatus?.relayHealth ?? "loading"}
            {relayStatus?.lastWakeUpAt
              ? ` · last wake-up ${relayStatus.lastWakeUpAt}`
              : " · no wake-up yet"}
            .
          </p>
        </div>
      </section>
    </>
  );
}
