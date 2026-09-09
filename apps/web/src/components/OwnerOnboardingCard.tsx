import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GoogleConnectionState, PersonProfile } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { onboardingApi, type OwnerOnboardingStatus } from "../clients/workspace";
import { peopleApi } from "../clients/people";

/**
 * Owner onboarding (issue #123): the connected Google identity proposes the
 * owner's canonical Person Profile; the owner explicitly selects, corrects,
 * or creates-and-confirms it. Nothing is confirmed without the button press,
 * and the pinned reference carries the exact Profile revision.
 */
export function OwnerOnboardingCard({
  googleConnectionState,
}: {
  googleConnectionState: GoogleConnectionState | null;
}) {
  const [status, setStatus] = useState<OwnerOnboardingStatus | null>(null);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([onboardingApi.owner(), peopleApi.people()]);
      setStatus(next);
      setProfiles(list);
      setSelectedId((current) => {
        if (current && list.some((profile) => profile.id === current)) return current;
        return next.proposal?.matchedProfileId ?? list[0]?.id ?? "";
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [googleConnectionState, refresh]);

  const confirm = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await onboardingApi.confirm(selectedId);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmed = status?.confirmed ?? null;
  const proposal = status?.proposal ?? null;

  return (
    <div className="card" role="group" aria-labelledby="group-owner-onboarding">
      <h3 id="group-owner-onboarding">Owner Profile</h3>
      {error ? <p role="alert">{error}</p> : null}
      {confirmed ? (
        <>
          <p className="connection-summary" role="status">
            <span className="ok">Confirmed</span> — Profile{" "}
            <strong>
              {profiles.find((p) => p.id === confirmed.profileId)?.fullName ?? confirmed.profileId}
            </strong>{" "}
            (revision {confirmed.profileRevision}) for {confirmed.confirmedForGoogleEmail}
          </p>
          <p>
            Outward workflows address the workspace owner through this reference. Connecting a
            different Google account voids it and asks you to confirm again.
          </p>
        </>
      ) : proposal ? (
        <>
          <p>
            Connected as <strong>{proposal.googleEmail}</strong>. Confirm which Person Profile is
            the canonical owner identity — the proposal is a suggestion, never a confirmation.
          </p>
          {proposal.matchedProfileId ? (
            <p>
              Proposed by the connected email:{" "}
              <strong>
                {profiles.find((p) => p.id === proposal.matchedProfileId)?.fullName ??
                  proposal.matchedProfileId}
              </strong>
              .
            </p>
          ) : (
            <p>
              No existing Profile carries this email.{" "}
              <Link to="/people/new">Create one under Person Profiles</Link>, or select the
              corrected Profile below.
            </p>
          )}
          <label>
            Owner Profile
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={profiles.length === 0}
            >
              {profiles.length === 0 ? <option value="">No Person Profiles yet</option> : null}
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fullName ?? "(unnamed)"}
                  {profile.primaryEmail ? ` — ${profile.primaryEmail}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void confirm()} disabled={busy || !selectedId}>
            {busy ? "Confirming…" : "Confirm owner Profile"}
          </button>
        </>
      ) : (
        <p>Connect a Google account to propose the owner Profile.</p>
      )}
    </div>
  );
}
