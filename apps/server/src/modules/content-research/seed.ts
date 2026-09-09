import type { WorkspacePersonProfiles } from "../../person-profile/profiles.js";
import type { ContentResearchHost } from "./host.js";

/**
 * The V1 watchlist (spec #116): the candidates verified by primary fetch on
 * the V1 surfaces during the grill. Verified feeds and channels carry explicit
 * discovered targets; the remaining platforms watch the person by name
 * (Reddit / Hacker News / Google News search) — the derivation in targets.ts.
 * Pieter Levels' YouTube presence is guest appearances, not an owned channel,
 * so no YouTube target is invented for him.
 *
 * Watches are Profile-backed (spec #134): the seed first makes sure each
 * watched person has a confirmed Person Profile in the Workspace, then watches
 * it. The V1 identities are public figures whose Profiles carry only public
 * identity input — no CRM or inferred claims.
 */
export function seedContentResearchV1(
  host: ContentResearchHost,
  people: WorkspacePersonProfiles,
): void {
  if (host.listAllPeople().length > 0) return;

  const ensureProfile = (fullName: string, primaryEmail: string): string => {
    const existing = people
      .search({ query: primaryEmail })
      .find((profile) => profile.emails.includes(primaryEmail));
    return (existing ?? people.create({ fullName, primaryEmail })).id;
  };

  host.addPerson({
    profileId: ensureProfile("Lenny Rachitsky", "lenny@lennysnewsletter.example"),
    handleHints: { blogRssHints: ["https://www.lennysnewsletter.com/feed"] },
    discoveredSourceTargets: [
      {
        adapterId: "rss",
        url: "https://www.lennysnewsletter.com/feed",
        label: "Lenny's Newsletter (Substack)",
      },
      {
        adapterId: "youtube",
        url: "https://www.youtube.com/@LennysPodcast",
        label: "Lenny's Podcast",
      },
    ],
  });
  host.addPerson({
    profileId: ensureProfile("Pieter Levels", "pieter@levelsio.example"),
    handleHints: { blogRssHints: ["https://levels.io/rss"] },
    discoveredSourceTargets: [
      { adapterId: "rss", url: "https://levels.io/rss", label: "@levelsio blog" },
    ],
  });
}
