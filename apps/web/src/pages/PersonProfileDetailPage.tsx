import { PersonDossierPanel } from "./PersonDossierPanel";
import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  PersonProfile,
  PersonProfileDeletionReceipt,
  PersonProfileInvalidation,
  PersonProfileLifecycleRefusal,
  PersonProfileLifecycleState,
  PersonProfileMatchConfidence,
  PersonProfilePrivacyDeleted,
  PersonProfileRepairFactKey,
  PersonProfileResidualSourceArtifact,
} from "@chief-of-staff-demo/shared";
import {
  PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION,
  PERSON_PROFILE_REPAIR_FACT_KEYS,
  invalidationAffectsRevision,
} from "@chief-of-staff-demo/shared";

import { ApiError, errorMessage } from "../client";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

// PROTOTYPE — throwaway Person Profile UI exploration (?variant=a|b|c|d).
// Delete with the losing variants; the switcher is null in prod builds.
// The variants are loaded lazily so the exploration — its stylesheet and its
// animation library — lands in its own chunk instead of the bundle every reader
// of a real Profile downloads.
import { PrototypeSwitcher, type PrototypeVariant } from "../components/PrototypeSwitcher";
import { usePrototypeDossier } from "./personProfilePrototypeData";

const prototypeVariants = () => import("./personProfilePrototypeVariants");
const VariantA = lazy(() => prototypeVariants().then((m) => ({ default: m.VariantA })));
const VariantB = lazy(() => prototypeVariants().then((m) => ({ default: m.VariantB })));
const VariantC = lazy(() => prototypeVariants().then((m) => ({ default: m.VariantC })));
const VariantD = lazy(() => prototypeVariants().then((m) => ({ default: m.VariantD })));

const PROFILE_VARIANTS: PrototypeVariant[] = [
  { key: "current", name: "Current" },
  { key: "a", name: "Critical Edition" },
  { key: "b", name: "Spine" },
  { key: "c", name: "Provenance" },
  { key: "d", name: "Prep Sheet" },
];

const CONFIDENCE_LABELS: Record<PersonProfileMatchConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const REPAIR_LABELS: Record<PersonProfileInvalidation["kind"], string> = {
  correction: "Correction",
  merge: "Merge",
  "evidence-detached": "Evidence detached",
};

const REPAIR_FACT_PRESENTATION: Record<
  PersonProfileRepairFactKey,
  { label: string; control: "text" | "email" | "textarea" }
> = {
  fullName: { label: "Full name", control: "text" },
  primaryEmail: { label: "Primary email", control: "email" },
  role: { label: "Role", control: "text" },
  currentEmployer: { label: "Current employer", control: "text" },
  background: { label: "Background", control: "textarea" },
};
const repairableFactFields = PERSON_PROFILE_REPAIR_FACT_KEYS.filter(
  (key): key is Exclude<PersonProfileRepairFactKey, "fullName"> => key !== "fullName",
).map((key) => ({ key, ...REPAIR_FACT_PRESENTATION[key] }));
const mergeRepairFactFields = PERSON_PROFILE_REPAIR_FACT_KEYS.map((key) => ({
  key,
  ...REPAIR_FACT_PRESENTATION[key],
}));

function RepairFactControl({
  id,
  label,
  control,
  value,
  onChange,
  clear,
}: {
  id: string;
  label: string;
  control: "text" | "email" | "textarea";
  value: string;
  onChange: (value: string) => void;
  clear?: { checked: boolean; label: string; onChange: (checked: boolean) => void };
}) {
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      {control === "textarea" ? (
        <textarea
          id={id}
          rows={3}
          disabled={clear?.checked}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={control}
          autoComplete="off"
          disabled={clear?.checked}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {clear ? (
        <label>
          <input
            type="checkbox"
            checked={clear.checked}
            onChange={(event) => clear.onChange(event.target.checked)}
          />{" "}
          {clear.label}
        </label>
      ) : null}
    </div>
  );
}

const RESIDUAL_KIND_LABELS: Record<PersonProfileResidualSourceArtifact["kind"], string> = {
  transcript: "Transcript",
  "public-source": "Public source",
};

/** The refusal body a lifecycle route answers with, when there is one. */
function lifecycleRefusal(error: unknown): PersonProfileLifecycleRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (body === null || typeof body !== "object") return null;
  return "lifecycle" in body ? (body as PersonProfileLifecycleRefusal) : null;
}

/** The tombstone and receipt a privacy-deleted Profile's route answers with. */
function privacyDeleted(error: unknown): PersonProfilePrivacyDeleted | null {
  if (!(error instanceof ApiError) || error.status !== 410) return null;
  const body = error.body;
  if (body === null || typeof body !== "object") return null;
  return "tombstone" in body ? (body as PersonProfilePrivacyDeleted) : null;
}

/**
 * The immutable documents a privacy deletion deliberately does not rewrite.
 * Listed as references — which document, of what kind, separately deletable or
 * not — never by title, because the disclosure outlives the identity the
 * document may still name.
 */
function ResidualSourceDisclosure({
  artifacts,
}: {
  artifacts: PersonProfileResidualSourceArtifact[];
}) {
  if (artifacts.length === 0) {
    return (
      <p className="banner-warn" role="status">
        Immutable transcript and public-source documents are <strong>never</strong> deleted with the
        Profile. None in this Workspace references it today; any that name it remain until each is
        separately deleted.
      </p>
    );
  }
  return (
    <>
      <p className="banner-warn" role="status">
        These source documents are immutable and are <strong>not</strong> deleted with the Profile.
        They remain until each is separately deleted.
      </p>
      <ul>
        {artifacts.map((artifact) => (
          <li key={artifact.artifactId}>
            <span className="status-badge status-source">
              {RESIDUAL_KIND_LABELS[artifact.kind]}
            </span>{" "}
            <code>{artifact.artifactId}</code> —{" "}
            {artifact.separateDeleteSupported
              ? "separate source deletion is supported"
              : "no separate source deletion is available"}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Consumers still pointed at this Profile. Archive and privacy deletion both
 * refuse while one is active, so the operator resolves each explicitly by
 * pausing or re-pointing it rather than leaving it orphaned.
 */
function DependentConfigurationDisclosure({
  lifecycle,
}: {
  lifecycle: PersonProfileLifecycleState;
}) {
  const active = lifecycle.dependentConfigurations.filter((one) => one.state === "active");
  if (lifecycle.dependentConfigurations.length === 0) {
    return <p className="muted">No configuration depends on this Profile.</p>;
  }
  return (
    <>
      {active.length > 0 && (
        <p className="banner-warn" role="status">
          {active.length === 1
            ? "One active configuration still points at this Profile."
            : `${active.length} active configurations still point at this Profile.`}{" "}
          Pause or re-point each one before archiving or deleting.
        </p>
      )}
      <ul>
        {lifecycle.dependentConfigurations.map((dependency) => (
          <li key={dependency.id}>
            <span
              className={`status-badge ${dependency.state === "active" ? "status-active" : "status-skipped"}`}
            >
              {dependency.state === "active" ? "Active" : "Paused"}
            </span>{" "}
            {dependency.label} <span className="muted">({dependency.consumer})</span>
            {dependency.availableActions.length > 0 && (
              <>
                {" "}
                — resolve by:{" "}
                {dependency.availableActions
                  .map((action) => (action === "pause" ? "pause" : "re-point"))
                  .join(" or ")}
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function described(profile: PersonProfile): string {
  return [profile.fullName, profile.role, profile.currentEmployer]
    .filter((value) => value !== null)
    .join(" — ");
}

/**
 * The stable Profile detail route (spec #117 IA, /people/:profileId). It shows
 * the current facts, identity signals, sites, publications, evidence with
 * provenance and confidence, enrichment diagnostics, and the revision history;
 * any exact historical revision is one click away and clearly marked as
 * superseded.
 */
export function PersonProfileDetailPage({ client = peopleApi }: { client?: PeopleClient }) {
  const { profileId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const revisionParam = searchParams.get("revision");
  const viewRevision = revisionParam === null ? null : Number(revisionParam);

  const [current, setCurrent] = useState<PersonProfile | null>(null);
  const [viewed, setViewed] = useState<PersonProfile | null>(null);
  const [revisions, setRevisions] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const focusRef = usePageFocus<HTMLHeadingElement>();

  useTitle(viewed?.fullName ?? current?.fullName ?? "Person Profile");

  /* PROTOTYPE — read-only dossier for the ?variant= exploration. Called here so
     it sits above the lifecycle early returns and the hook order never shifts. */
  const variant = searchParams.get("variant") ?? "current";
  const prototyping = variant === "a" || variant === "b" || variant === "c" || variant === "d";
  const prototypeView = usePrototypeDossier(
    profileId,
    viewed?.fullName ?? current?.fullName ?? "(unnamed)",
    prototyping,
  );

  /* Profile lifecycle (ticket #122): archive is reversible state; privacy
     deletion is the audited exception, behind its own confirmation. */
  const [lifecycle, setLifecycle] = useState<PersonProfileLifecycleState | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [receipt, setReceipt] = useState<PersonProfileDeletionReceipt | null>(null);
  const [deleted, setDeleted] = useState<PersonProfilePrivacyDeleted | null>(null);

  const loadLifecycle = useCallback(async () => {
    try {
      setLifecycle(await client.personProfileLifecycle(profileId));
    } catch {
      /* The lifecycle preview is a disclosure, not a precondition for reading
         the Profile: a failure to load it must not blank the detail page. */
    }
  }, [client, profileId]);

  useEffect(() => {
    let cancelled = false;
    /* Each .then body is its own closure, so every check reads the flag fresh
       rather than a narrowed snapshot taken before the awaits. */
    void client
      .personProfile(profileId)
      .then((profile) => {
        if (cancelled) return;
        setCurrent(profile);
        setError(null);
        return client.personProfileRevisions(profileId).then((history) => {
          if (cancelled) return;
          setRevisions(history.map((p) => p.revision));
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        /* A privacy-deleted Profile is gone on purpose, not broken: its route
           answers 410 with the tombstone that keeps the reference resolvable. */
        setDeleted(privacyDeleted(err));
        setError(errorMessage(err));
      });
    void loadLifecycle();
    return () => {
      cancelled = true;
    };
  }, [client, profileId, loadLifecycle]);

  useEffect(() => {
    let cancelled = false;
    if (viewRevision === null || Number.isNaN(viewRevision)) {
      setViewed(null);
      return;
    }
    async function loadRevision() {
      try {
        const profile = await client.personProfileRevision(profileId, viewRevision!);
        if (!cancelled) setViewed(profile);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }
    void loadRevision();
    return () => {
      cancelled = true;
    };
  }, [client, profileId, viewRevision]);

  /* Identity repair (ticket #121): the owner's repair decisions. Every action
     goes through the product API, appends a revision, and refreshes the
     history; nothing here rewrites what was already recorded. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState({
    fullName: "",
    primaryEmail: "",
    role: "",
    currentEmployer: "",
    background: "",
    profileUrls: "",
    note: "",
  });
  const [clearCorrection, setClearCorrection] = useState({
    primaryEmail: false,
    role: false,
    currentEmployer: false,
    background: false,
    profileUrls: false,
  });
  const [duplicateQuery, setDuplicateQuery] = useState("");
  const [duplicates, setDuplicates] = useState<PersonProfile[]>([]);
  useEffect(() => {
    if (duplicateQuery.trim().length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void client
        .people(duplicateQuery)
        .then((profiles) => {
          if (active)
            setDuplicates(
              profiles.filter((profile) => profile.id !== profileId && !profile.mergedInto),
            );
        })
        .catch((error) => {
          if (active) setActionError(errorMessage(error));
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, duplicateQuery, profileId]);
  const [mergeForm, setMergeForm] = useState({
    duplicateId: "",
    fullName: "",
    primaryEmail: "",
    role: "",
    currentEmployer: "",
    background: "",
    note: "",
  });
  const [detachForm, setDetachForm] = useState({ evidenceId: "", toProfileId: "", note: "" });

  const runRepair = useCallback(
    async (apply: () => Promise<PersonProfile>) => {
      setBusy(true);
      setActionError(null);
      try {
        setCurrent(await apply());
        const history = await client.personProfileRevisions(profileId);
        setRevisions(history.map((profile) => profile.revision));
      } catch (err) {
        setActionError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [client, profileId],
  );

  /**
   * One lifecycle action. A refusal is rendered as the disclosure it carries —
   * the configurations still pointing here, or the residual source documents —
   * rather than as an opaque failure.
   */
  const runLifecycle = useCallback(
    async (apply: () => Promise<PersonProfile>) => {
      setBusy(true);
      setActionError(null);
      try {
        setCurrent(await apply());
      } catch (err) {
        const refusal = lifecycleRefusal(err);
        if (refusal) setLifecycle(refusal.lifecycle);
        setActionError(errorMessage(err));
      } finally {
        setBusy(false);
        await loadLifecycle();
      }
    },
    [loadLifecycle],
  );

  const submitPrivacyDelete = (event: FormEvent) => {
    event.preventDefault();
    void (async () => {
      setBusy(true);
      setActionError(null);
      try {
        setReceipt(await client.privacyDeletePersonProfile(profileId, confirmation));
        setCurrent(null);
      } catch (err) {
        const refusal = lifecycleRefusal(err);
        if (refusal) setLifecycle(refusal.lifecycle);
        setActionError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const submitCorrection = (event: FormEvent) => {
    event.preventDefault();
    const stated = {
      ...(correction.fullName.trim() === "" ? {} : { fullName: correction.fullName }),
      ...(clearCorrection.primaryEmail
        ? { primaryEmail: null }
        : correction.primaryEmail.trim() === ""
          ? {}
          : { primaryEmail: correction.primaryEmail }),
      ...(clearCorrection.role
        ? { role: null }
        : correction.role.trim() === ""
          ? {}
          : { role: correction.role }),
      ...(clearCorrection.currentEmployer
        ? { currentEmployer: null }
        : correction.currentEmployer.trim() === ""
          ? {}
          : { currentEmployer: correction.currentEmployer }),
      ...(clearCorrection.background
        ? { background: null }
        : correction.background.trim() === ""
          ? {}
          : { background: correction.background }),
      ...(clearCorrection.profileUrls
        ? { profileUrls: null }
        : correction.profileUrls.trim() === ""
          ? {}
          : {
              profileUrls: correction.profileUrls
                .split(/[\n,]/)
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            }),
      ...(correction.note.trim() === "" ? {} : { note: correction.note }),
    };
    void runRepair(() => client.correctPersonProfile(profileId, stated));
  };

  const submitMerge = (event: FormEvent) => {
    event.preventDefault();
    void runRepair(() =>
      client.mergePersonProfile(profileId, {
        duplicateId: mergeForm.duplicateId.trim(),
        resolutions: {
          ...(mergeForm.fullName.trim() === "" ? {} : { fullName: mergeForm.fullName }),
          ...(mergeForm.primaryEmail.trim() === "" ? {} : { primaryEmail: mergeForm.primaryEmail }),
          ...(mergeForm.role.trim() === "" ? {} : { role: mergeForm.role }),
          ...(mergeForm.currentEmployer.trim() === ""
            ? {}
            : { currentEmployer: mergeForm.currentEmployer }),
          ...(mergeForm.background.trim() === "" ? {} : { background: mergeForm.background }),
        },
        ...(mergeForm.note.trim() === "" ? {} : { note: mergeForm.note }),
      }),
    );
  };

  const submitDetach = (event: FormEvent) => {
    event.preventDefault();
    void runRepair(async () => {
      const split = await client.detachPersonEvidence(profileId, {
        evidenceId: detachForm.evidenceId,
        ...(detachForm.toProfileId.trim() === "" ? {} : { toProfileId: detachForm.toProfileId }),
        ...(detachForm.note.trim() === "" ? {} : { note: detachForm.note }),
      });
      return split.from;
    });
  };

  const backToCurrent = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  /* The maintenance disclosure belongs to the reader, not to the router.
     Opening a historical revision reveals it, and returning to the current
     revision must not collapse the section the reader was working in (#209). */
  useEffect(() => {
    if (viewed !== null && current !== null && viewed.revision !== current.revision)
      setMaintenanceOpen(true);
  }, [viewed, current]);

  /* The receipt for a deletion this surface just performed, and the tombstone
     for one performed earlier, are the same fact seen at two moments. */
  if (receipt !== null || deleted !== null) {
    const shown = receipt ?? deleted!.receipt;
    const tombstone = receipt?.tombstone ?? deleted!.tombstone;
    return (
      <>
        <h1 ref={focusRef} tabIndex={-1}>
          Profile privacy-deleted
        </h1>
        <p className="banner-ok" role="status">
          This Person Profile and its local identity records were deleted on{" "}
          {tombstone.deletedAt.slice(0, 10)}. A content-free tombstone keeps existing references
          resolvable; it names nobody.
        </p>
        {shown && (
          <div className="card">
            <h2>What the deletion accounted for</h2>
            <dl>
              <dt>Canonical Profile records</dt>
              <dd>{shown.removed.canonicalProfileRecords}</dd>
              <dt>Revisions</dt>
              <dd>{shown.removed.revisions}</dd>
              <dt>Evidence records</dt>
              <dd>{shown.removed.evidence}</dd>
              <dt>Aliases</dt>
              <dd>{shown.removed.aliases}</dd>
              <dt>Candidates</dt>
              <dd>{shown.removed.candidates}</dd>
              <dt>Learned mappings</dt>
              <dd>{shown.removed.mappings}</dd>
              <dt>Structured identity decisions</dt>
              <dd>{shown.removed.decisions}</dd>
              <dt>Active consumer links</dt>
              <dd>{shown.removed.activeLinks}</dd>
              <dt>Person-specific derived snapshots</dt>
              <dd>{shown.removed.personSnapshots}</dd>
              <dt>Remote provider operations</dt>
              <dd>{shown.remoteProviderOperations} — no remote provider data was deleted</dd>
            </dl>
          </div>
        )}
        <div className="card">
          <h2>Source documents that remain</h2>
          <ResidualSourceDisclosure artifacts={shown?.residualSourceArtifacts ?? []} />
        </div>
        <p>
          <Link to="/people">Back to the list</Link>.
        </p>
      </>
    );
  }
  /* PROTOTYPE — the four variants replace the reading surface (heading, facts
     line and dossier panel) and own the route's single <h1>. The Shell's header,
     nav and footer stay, so each design is judged at real density. Profile
     maintenance is unchanged and stays on ?variant=current. Placed above the
     load and error returns on purpose: a UI prototype has to be viewable on a
     Workspace with no researched Profile, which is every dev Workspace, and the
     demo corpus needs nothing from the API. */
  if (prototyping) {
    if (!prototypeView) return <p className="muted">Loading dossier…</p>;
    const shared = { view: prototypeView, headingRef: focusRef };
    return (
      <>
        {current?.archivedAt && (
          <p className="status-badge" role="status">
            Archived
          </p>
        )}
        {current?.mergedInto && (
          <p className="banner-error" role="alert">
            This Profile was merged into{" "}
            <Link to={`/people/${current.mergedInto}`}>another Profile</Link>.
          </p>
        )}
        <Suspense fallback={<p className="muted">Loading dossier…</p>}>
          {variant === "a" && <VariantA {...shared} />}
          {variant === "b" && <VariantB {...shared} />}
          {variant === "c" && <VariantC {...shared} />}
          {variant === "d" && <VariantD {...shared} />}
        </Suspense>
        <PrototypeSwitcher current={variant} variants={PROFILE_VARIANTS} />
      </>
    );
  }

  if (error) {
    return (
      <>
        <h1 ref={focusRef} tabIndex={-1}>
          Person Profile
        </h1>
        <p className="banner-error" role="alert">
          {error} — <Link to="/people">back to the list</Link>.
        </p>
      </>
    );
  }
  if (!current) {
    return <p className="muted">Loading…</p>;
  }

  const profile = viewed ?? current;
  const isHistorical = viewed !== null && viewed.revision !== current.revision;
  const detachableEvidence = [...current.publications, ...current.mentions, ...current.evidence];
  const signals: string[] = [
    ...profile.emails,
    ...Object.entries(profile.handles).flatMap(([platform, values]) =>
      values.map((value) => `${platform}: ${value}`),
    ),
    ...profile.profileUrls,
    ...profile.employerHints,
  ];

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        {profile.fullName ?? "(unnamed)"}
      </h1>
      {profile.archivedAt && (
        <p className="status-badge" role="status">
          Archived
        </p>
      )}
      {current.mergedInto && (
        <p className="banner-error" role="alert">
          This Profile was merged into{" "}
          <Link to={`/people/${current.mergedInto}`}>another Profile</Link>. It holds no current
          identity of its own; its revisions remain readable below.
        </p>
      )}
      {actionError && (
        <p className="banner-error" role="alert">
          {actionError}
        </p>
      )}
      {isHistorical && (
        <p className="banner-error" role="alert">
          Viewing revision {viewed.revision} exactly as it was recorded.{" "}
          <button type="button" className="linklike" onClick={backToCurrent}>
            Back to the current revision ({current.revision})
          </button>
          {(current.invalidations ?? [])
            .filter((record) => invalidationAffectsRevision(record, viewed.revision))
            .map((record) => (
              <span key={record.id}>
                {" "}
                This revision was later invalidated ({REPAIR_LABELS[record.kind].toLowerCase()}):
                {record.detail}
              </span>
            ))}
        </p>
      )}
      <p className="muted">{described(profile) || "No resolved facts yet."}</p>
      {/* PROTOTYPE — dev-only entry point to ?variant=a|b|c|d; null in prod. */}
      <PrototypeSwitcher current={variant} variants={PROFILE_VARIANTS} />

      {!current.mergedInto && !isHistorical && (
        <PersonDossierPanel key={profileId} profileId={profileId} />
      )}
      <details
        open={maintenanceOpen}
        onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}
      >
        <summary>Profile maintenance and revision history</summary>
        {!current.mergedInto && !current.archivedAt && !isHistorical && (
          <div className="card">
            <h2>Search the public web again</h2>
            <p className="muted">
              Runs the same search the typed-identifier lookup runs, from the identity this Profile
              already holds — its emails, names, handles and profile addresses. Anything new is
              added as a further revision; nothing already recorded is removed. A Profile a meeting
              minted from an email alone starts here.
            </p>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void runRepair(() => client.enrichPersonProfile(profileId))}
            >
              {busy ? "Searching…" : "Search again"}
            </button>
          </div>
        )}

        <div className="card">
          <h2>Current facts</h2>
          <dl>
            <dt>Full name</dt>
            <dd>{profile.fullName ?? "—"}</dd>
            <dt>Primary email</dt>
            <dd>{profile.primaryEmail ?? "—"}</dd>
            <dt>Role</dt>
            <dd>{profile.role ?? "—"}</dd>
            <dt>Current employer</dt>
            <dd>{profile.currentEmployer ?? "—"}</dd>
            <dt>Background</dt>
            <dd>{profile.background ?? "—"}</dd>
          </dl>
        </div>

        {!current.mergedInto && (
          <div className="card">
            <h2>Correct facts</h2>
            <p className="muted">
              A correction appends a new revision; the superseded snapshot stays readable.
            </p>
            <form onSubmit={(event) => void submitCorrection(event)}>
              <div className="field-row">
                <label htmlFor="correct-full-name">Full name</label>
                <input
                  id="correct-full-name"
                  autoComplete="off"
                  value={correction.fullName}
                  onChange={(event) =>
                    setCorrection({ ...correction, fullName: event.target.value })
                  }
                />
              </div>
              {repairableFactFields.map(({ key, label, control }) => {
                const id = `correct-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
                return (
                  <RepairFactControl
                    key={key}
                    id={id}
                    label={label}
                    control={control}
                    value={correction[key]}
                    onChange={(value) => setCorrection({ ...correction, [key]: value })}
                    clear={{
                      checked: clearCorrection[key],
                      label: `Clear ${label.toLowerCase()}`,
                      onChange: (checked) =>
                        setClearCorrection({ ...clearCorrection, [key]: checked }),
                    }}
                  />
                );
              })}
              <div className="field-row">
                <label htmlFor="correct-profile-urls">Profile URLs</label>
                <textarea
                  id="correct-profile-urls"
                  rows={3}
                  autoComplete="off"
                  placeholder="linkedin.com/in/someone, x.com/someone, their site"
                  aria-describedby="correct-profile-urls-hint"
                  value={correction.profileUrls}
                  onChange={(event) =>
                    setCorrection({ ...correction, profileUrls: event.target.value })
                  }
                />
                <p id="correct-profile-urls-hint" className="muted">
                  One per line or comma-separated; a stated list replaces the current one. Public
                  evidence matches on a name alone only at medium confidence, and role, employer and
                  social profiles are drawn from high-confidence matches — so these are what let a
                  search populate the Profile. Handles are derived from the URLs.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={clearCorrection.profileUrls}
                    onChange={(event) =>
                      setClearCorrection({ ...clearCorrection, profileUrls: event.target.checked })
                    }
                  />{" "}
                  Clear profile URLs
                </label>
              </div>
              <div className="field-row">
                <label htmlFor="correct-note">What was wrong?</label>
                <input
                  id="correct-note"
                  autoComplete="off"
                  value={correction.note}
                  onChange={(event) => setCorrection({ ...correction, note: event.target.value })}
                />
              </div>
              <div className="field-row">
                <button type="submit" className="primary" aria-disabled={busy}>
                  {busy ? "Working…" : "Append correction"}
                </button>
              </div>
            </form>
          </div>
        )}

        {!current.mergedInto && (
          <div className="card">
            <h2>Merge a duplicate</h2>
            <p className="muted">
              Merges another Profile into this one through an audited decision; conflicting facts
              must be resolved explicitly and the duplicate stays readable as a redirect.
            </p>
            <form onSubmit={(event) => void submitMerge(event)}>
              <div className="field-row">
                <label htmlFor="merge-search">Find duplicate person</label>
                <input
                  id="merge-search"
                  value={duplicateQuery}
                  onChange={(event) => setDuplicateQuery(event.target.value)}
                  placeholder="Name, email or employer"
                />
                <label htmlFor="merge-duplicate">Duplicate person</label>
                <select
                  id="merge-duplicate"
                  required
                  value={mergeForm.duplicateId}
                  onChange={(event) =>
                    setMergeForm({ ...mergeForm, duplicateId: event.target.value })
                  }
                >
                  <option value="">Choose a person from search results</option>
                  {duplicates.map((person) => (
                    <option value={person.id} key={person.id}>
                      {person.fullName ?? "Unnamed"} —{" "}
                      {person.primaryEmail ?? person.currentEmployer ?? "No employer recorded"}
                    </option>
                  ))}
                </select>
              </div>
              {mergeRepairFactFields.map(({ key, label, control }) => {
                const id = `merge-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
                return (
                  <RepairFactControl
                    key={key}
                    id={id}
                    label={`Resolved ${label.toLowerCase()}`}
                    control={control}
                    value={mergeForm[key]}
                    onChange={(value) => setMergeForm({ ...mergeForm, [key]: value })}
                  />
                );
              })}
              <div className="field-row">
                <label htmlFor="merge-note">Merge note</label>
                <input
                  id="merge-note"
                  autoComplete="off"
                  value={mergeForm.note}
                  onChange={(event) => setMergeForm({ ...mergeForm, note: event.target.value })}
                />
              </div>
              <div className="field-row">
                <button type="submit" className="primary" aria-disabled={busy}>
                  {busy ? "Working…" : "Merge profile"}
                </button>
              </div>
            </form>
          </div>
        )}

        {!current.mergedInto && detachableEvidence.length > 0 && (
          <div className="card">
            <h2>Detach evidence</h2>
            <p className="muted">
              Removes one evidence record from this Profile and marks the old attribution invalid;
              optionally re-attributes it to the correct Profile.
            </p>
            <form onSubmit={(event) => void submitDetach(event)}>
              <div className="field-row">
                <label htmlFor="detach-evidence">Evidence</label>
                <select
                  id="detach-evidence"
                  required
                  value={detachForm.evidenceId}
                  onChange={(event) =>
                    setDetachForm({ ...detachForm, evidenceId: event.target.value })
                  }
                >
                  <option value="">Choose evidence…</option>
                  {detachableEvidence.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label htmlFor="detach-to">Move to profile id (optional)</label>
                <input
                  id="detach-to"
                  autoComplete="off"
                  value={detachForm.toProfileId}
                  onChange={(event) =>
                    setDetachForm({ ...detachForm, toProfileId: event.target.value })
                  }
                />
              </div>
              <div className="field-row">
                <label htmlFor="detach-note">Detach note</label>
                <input
                  id="detach-note"
                  autoComplete="off"
                  value={detachForm.note}
                  onChange={(event) => setDetachForm({ ...detachForm, note: event.target.value })}
                />
              </div>
              <div className="field-row">
                <button type="submit" className="primary" aria-disabled={busy}>
                  {busy ? "Working…" : "Detach evidence"}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="card">
          <h2>Identity signals</h2>
          {signals.length === 0 ? (
            <p className="muted">No identity signals recorded.</p>
          ) : (
            <ul>
              {signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Sites</h2>
          {profile.websites.length === 0 &&
          profile.feeds.length === 0 &&
          profile.socialProfiles.length === 0 ? (
            <p className="muted">No sites recorded.</p>
          ) : (
            <>
              {profile.websites.length > 0 && (
                <ul>
                  {profile.websites.map((url) => (
                    <li key={url}>
                      <a href={url}>{url}</a>
                    </li>
                  ))}
                </ul>
              )}
              {profile.feeds.length > 0 && (
                <ul>
                  {profile.feeds.map((feed) => (
                    <li key={feed.url}>
                      <a href={feed.url}>{feed.title ?? feed.url}</a> (feed)
                    </li>
                  ))}
                </ul>
              )}
              {profile.socialProfiles.length > 0 && (
                <ul>
                  {profile.socialProfiles.map((social) => (
                    <li key={social.url}>
                      <a href={social.url}>{social.handle ?? social.platform}</a> ({social.platform}
                      )
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="card">
          <h2>Publications</h2>
          {profile.publications.length === 0 ? (
            <p className="muted">No publications recorded.</p>
          ) : (
            <ul>
              {profile.publications.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong> — {item.summary}
                  <br />
                  <span className="muted">
                    Source: <a href={item.url}>{item.url}</a>
                    {item.publishedAt ? ` · published ${item.publishedAt.slice(0, 10)}` : ""} ·{" "}
                    {CONFIDENCE_LABELS[item.matchConfidence]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Evidence</h2>
          {profile.evidence.length === 0 ? (
            <p className="muted">No evidence recorded.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Title</th>
                    <th scope="col">Claims</th>
                    <th scope="col">Provenance</th>
                    <th scope="col">Match confidence</th>
                    <th scope="col">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.evidence.map((item) => (
                    <tr key={item.id}>
                      <td>{item.kind}</td>
                      <td>{item.title}</td>
                      <td>
                        {[
                          item.claims.fullName,
                          item.claims.role,
                          item.claims.currentEmployer,
                          item.claims.background,
                        ]
                          .filter((claim) => claim !== undefined)
                          .join(" · ") || "—"}
                      </td>
                      <td>
                        {item.source}:{" "}
                        <a href={item.url} rel="noreferrer">
                          {item.url}
                        </a>
                      </td>
                      <td>{CONFIDENCE_LABELS[item.matchConfidence]}</td>
                      <td>{item.observedAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Diagnostics</h2>
          {profile.sourceDiagnostics.length === 0 ? (
            <p className="muted">No enrichment diagnostics recorded.</p>
          ) : (
            <ul>
              {profile.sourceDiagnostics.map((diagnostic) => (
                <li key={`${diagnostic.source}-${diagnostic.status}`}>
                  {diagnostic.source}: {diagnostic.status} — {diagnostic.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Identity repairs</h2>
          {(current.invalidations ?? []).length === 0 ? (
            <p className="muted">No corrections, merges, or detaches recorded.</p>
          ) : (
            <ul>
              {(current.invalidations ?? []).map((record) => (
                <li key={record.id}>
                  <strong>{REPAIR_LABELS[record.kind]}</strong> — revision {record.affectedRevision}{" "}
                  superseded · {record.detail}
                  {record.mergedInto && (
                    <>
                      {" "}
                      · merged into{" "}
                      <Link to={`/people/${record.mergedInto}`}>{record.mergedInto}</Link>
                    </>
                  )}
                  {record.mergedFrom && (
                    <>
                      {" "}
                      · merged from{" "}
                      <Link to={`/people/${record.mergedFrom}`}>{record.mergedFrom}</Link>
                    </>
                  )}
                  {record.movedTo && (
                    <>
                      {" "}
                      · evidence moved to{" "}
                      <Link to={`/people/${record.movedTo}`}>{record.movedTo}</Link>
                    </>
                  )}
                  {record.movedFrom && (
                    <>
                      {" "}
                      · evidence re-attributed from{" "}
                      <Link to={`/people/${record.movedFrom}`}>{record.movedFrom}</Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Revision history</h2>
          <ul>
            {revisions.map((revision) => (
              <li key={revision}>
                {/* Every row opens the exact recorded revision, the current one
                  included: reading what was true then is always one click. */}
                <button
                  type="button"
                  className="linklike"
                  onClick={() => setSearchParams({ revision: String(revision) })}
                >
                  Revision {revision}
                  {revision === current.revision ? " (current)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Lifecycle</h2>
          <p className="muted">
            {current.archivedAt
              ? "This Profile is archived: no consumer can newly select it. Restoring makes the same canonical identity available again."
              : "Archiving stops new selection and consumption without destroying history. It is reversible."}
          </p>
          <div className="field-row">
            <button
              type="button"
              className="primary"
              aria-disabled={busy}
              onClick={() =>
                void runLifecycle(() =>
                  current.archivedAt
                    ? client.restorePersonProfile(profileId)
                    : client.archivePersonProfile(profileId),
                )
              }
            >
              {busy ? "Working…" : current.archivedAt ? "Restore profile" : "Archive profile"}
            </button>
          </div>

          <h3>Dependent configuration</h3>
          {lifecycle === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <DependentConfigurationDisclosure lifecycle={lifecycle} />
          )}

          <h3>Privacy delete</h3>
          <p className="muted">
            Privacy deletion is the explicit, audited exception to otherwise immutable local
            history. It removes the canonical Profile, its revisions, evidence, aliases, candidates,
            learned mappings, structured identity decisions, active consumer links, and
            person-specific derived snapshots. It cannot be undone, and it never deletes remote
            provider data.
          </p>
          {!deleteOpen ? (
            <div className="field-row">
              <button type="button" onClick={() => setDeleteOpen(true)}>
                Privacy delete this profile…
              </button>
            </div>
          ) : (
            /* Spec #117: the confirmation surface lists the residual source
             artifacts before anything is deleted, and says where a separate
             source deletion exists. */
            <form onSubmit={submitPrivacyDelete}>
              <h4>Source documents that will remain</h4>
              <ResidualSourceDisclosure artifacts={lifecycle?.residualSourceArtifacts ?? []} />
              <div className="field-row">
                <label htmlFor="privacy-delete-confirmation">
                  Type {PERSON_PROFILE_PRIVACY_DELETE_CONFIRMATION} to confirm
                </label>
                <input
                  id="privacy-delete-confirmation"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </div>
              <div className="field-row">
                <button type="submit" className="primary" aria-disabled={busy}>
                  {busy ? "Working…" : "Permanently delete this profile"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeleteOpen(false);
                    setConfirmation("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </details>
    </>
  );
}
