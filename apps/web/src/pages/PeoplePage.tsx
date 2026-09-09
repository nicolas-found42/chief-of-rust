import { PersonDossierSearch } from "./PersonDossierSearch";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * The Person Profiles product area's landing surface (spec #117 IA): a
 * searchable list over active Profiles, with archived state one explicit
 * toggle away. Profiles open on their stable detail route.
 */
export function PeoplePage({ client = peopleApi }: { client?: PeopleClient }) {
  useTitle("Person Profiles");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [profiles, setProfiles] = useState<PersonProfile[] | null>(null);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await client.people(query, includeArchived));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [client, includeArchived, query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        Person Profiles
      </h1>
      <p className="muted">
        Durable, evidence-backed records of people, owned by the Workspace rather than by the
        workflow that first met them.
      </p>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <div className="field-row runs-toolbar">
        <label htmlFor="people-search">Search</label>
        <input
          id="people-search"
          type="search"
          value={query}
          placeholder="Name, email, employer, site…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label htmlFor="people-archived">
          <input
            id="people-archived"
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />{" "}
          Include archived
        </label>
        <Link className="action-button primary" to="/people/new">
          New profile
        </Link>
        <Link className="action-button" to="/people/review">
          Review queue
        </Link>
      </div>
      <PersonDossierSearch profiles={profiles ?? []} />
      {profiles === null ? (
        <p className="muted">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="muted">
          {query ? "No Profiles match that search." : "No Profiles yet — create the first one."}
        </p>
      ) : (
        <div className="table-scroll">
          {/* Stacks below 640px (.stacked-sm); the roles are stated because
              that rule changes `display`, and each cell names its column. */}
          <table className="stacked-sm" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Current employer</th>
                <th scope="col">Revision</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {profiles.map((profile) => (
                <tr role="row" key={profile.id}>
                  <td role="cell" data-label="Name">
                    <Link to={`/people/${encodeURIComponent(profile.id)}`}>
                      {profile.fullName ?? "(unnamed)"}
                    </Link>
                  </td>
                  <td role="cell" data-label="Email">
                    {profile.primaryEmail ?? "—"}
                  </td>
                  <td role="cell" data-label="Role">
                    {profile.role ?? "—"}
                  </td>
                  <td role="cell" data-label="Current employer">
                    {profile.currentEmployer ?? "—"}
                  </td>
                  <td role="cell" data-label="Revision">
                    {profile.revision}
                  </td>
                  <td role="cell" data-label="State">
                    {/* Archive state is a classified state, not a word in a
                        cell: an archived Profile reads as one at a glance. */}
                    <span
                      className={`status-badge ${profile.archivedAt ? "status-skipped" : "status-active"}`}
                    >
                      {profile.archivedAt ? "Archived" : "Active"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
