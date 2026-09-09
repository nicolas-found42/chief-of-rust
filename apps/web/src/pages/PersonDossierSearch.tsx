import { useState } from "react";
import type {
  PersonDossierQueryResult,
  PersonProfile,
  PersonConnectionStep,
} from "@chief-of-staff-demo/shared";
import { request, errorMessage } from "../client";

export function PersonDossierSearch({ profiles = [] }: { profiles?: PersonProfile[] }) {
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState("");
  const [constraints, setConstraints] = useState("");
  const [scale, setScale] = useState("");
  const [unit, setUnit] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [fromPerson, setFromPerson] = useState("");
  const [toPerson, setToPerson] = useState("");
  const [path, setPath] = useState<PersonConnectionStep[] | null>(null);
  const [result, setResult] = useState<PersonDossierQueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details className="card">
      <summary>Find expertise and work across Profiles</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void request<PersonDossierQueryResult>("/api/people/dossier-query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query,
              constraints: constraints
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              ...(scale && unit ? { scale: { minimum: Number(scale), unit } } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
              categories: categories
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean),
            }),
          })
            .then((value) => {
              setResult(value);
              setError("");
            })
            .catch((error) => setError(errorMessage(error)))
            .finally(() => setBusy(false));
        }}
      >
        <label style={{ display: "block" }}>
          Work or evidence text{" "}
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="scheduler, deployment, safety…"
          />
        </label>
        <label style={{ display: "block" }}>
          Capabilities required together{" "}
          <input
            value={categories}
            onChange={(event) => setCategories(event.target.value)}
            placeholder="deployment, regulation"
          />
        </label>
        <details>
          <summary>Work constraints, scale and dates</summary>
          <label style={{ display: "block" }}>
            Documented constraints{" "}
            <input
              value={constraints}
              onChange={(event) => setConstraints(event.target.value)}
              placeholder="safety-critical, memory"
            />
          </label>
          <label style={{ display: "block" }}>
            Minimum operating scale{" "}
            <input type="number" value={scale} onChange={(event) => setScale(event.target.value)} />
          </label>
          <label style={{ display: "block" }}>
            Scale unit{" "}
            <input
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              placeholder="sites, users, people"
            />
          </label>
          <label style={{ display: "block" }}>
            Work started from{" "}
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label style={{ display: "block" }}>
            Work started through{" "}
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </details>
        <button type="submit" disabled={busy}>
          {busy ? "Searching dossiers…" : "Search dossiers"}
        </button>
      </form>
      <details>
        <summary>Documented connection paths</summary>
        <label>
          From person{" "}
          <select value={fromPerson} onChange={(event) => setFromPerson(event.target.value)}>
            <option value="">Choose a person</option>
            {profiles.map((person) => (
              <option value={person.id} key={person.id}>
                {person.fullName ?? person.primaryEmail ?? "Unnamed"}
              </option>
            ))}
          </select>
        </label>
        <label>
          To person{" "}
          <select value={toPerson} onChange={(event) => setToPerson(event.target.value)}>
            <option value="">Choose a person</option>
            {profiles.map((person) => (
              <option value={person.id} key={person.id}>
                {person.fullName ?? person.primaryEmail ?? "Unnamed"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!fromPerson || !toPerson}
          onClick={() =>
            void request<{ path: PersonConnectionStep[] }>(
              `/api/people/connection-path?from=${encodeURIComponent(fromPerson)}&to=${encodeURIComponent(toPerson)}`,
            )
              .then((result) => setPath(result.path))
              .catch((error) => setError(errorMessage(error)))
          }
        >
          Find documented path
        </button>
        {path && (
          <>
            <p>
              Documented relationships only; a path does not establish access, an introduction,
              willingness or availability.
            </p>
            {path.length ? (
              path.map((edge, index) => (
                <article className="card" key={index}>
                  <p>
                    {profiles.find((person) => person.id === edge.fromProfileId)?.fullName ??
                      "Person"}{" "}
                    — {edge.kind} ({edge.direction}) —{" "}
                    {profiles.find((person) => person.id === edge.toProfileId)?.fullName ??
                      "Person"}
                  </p>
                  <p>
                    {edge.from ?? "Start unknown"} — {edge.to ?? "End unknown"}
                  </p>
                  <p>Shared work records: {edge.workIds.join(", ") || "none documented"}</p>
                  {edge.citations.map((citation, i) => (
                    <blockquote key={i}>
                      {citation.quote}
                      <a
                        href={`/people/${encodeURIComponent(edge.fromProfileId)}?source=${encodeURIComponent(citation.sourceId)}`}
                      >
                        Inspect evidence
                      </a>
                    </blockquote>
                  ))}
                </article>
              ))
            ) : (
              <p>No supported path found within four connections.</p>
            )}
          </>
        )}
      </details>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>
            {result.coverage.researchedProfiles} of {result.coverage.activeProfiles} active Profiles
            have researched evidence. {result.coverage.demonstrated} demonstrated matches;{" "}
            {result.coverage.claimedOnly} claimed-only matches.
          </p>
          <p className="muted">{result.scope}</p>
          {(["demonstrated", "claimed"] as const).map((group) => (
            <section key={group}>
              <h3>
                {group === "demonstrated"
                  ? "Demonstrated in work"
                  : "Claimed-only or undocumented contribution"}
              </h3>
              {result[group].length ? (
                result[group].map((person) => (
                  <article className="card" key={person.profileId}>
                    <a
                      href={`/people/${encodeURIComponent(person.profileId)}?dossierRevision=${person.dossierRevision}`}
                    >
                      {person.name}
                    </a>
                    <p>
                      Evidence at dossier revision {person.dossierRevision}. Work records:{" "}
                      {person.workIds.join(", ") || "none"}. Claims:{" "}
                      {person.claimIds.join(", ") || "none"}.
                    </p>
                    {person.gaps.map((gap) => (
                      <p key={gap}>{gap}</p>
                    ))}
                    {person.citations.map((citation, i) => (
                      <blockquote key={i}>
                        {citation.quote}
                        <br />
                        <a
                          href={`/people/${encodeURIComponent(person.profileId)}?dossierRevision=${person.dossierRevision}&source=${encodeURIComponent(citation.sourceId)}`}
                        >
                          Inspect source in Profile
                        </a>
                      </blockquote>
                    ))}
                  </article>
                ))
              ) : (
                <p>No matches in the researched evidence.</p>
              )}
            </section>
          ))}
        </>
      )}
    </details>
  );
}
