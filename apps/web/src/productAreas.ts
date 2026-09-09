/**
 * The five top-level product areas (spec: Navigation and onboarding #1;
 * Implementation Decision 1), as an explicit list rather than something
 * derived from the Module registry (ADR-0043, ADR-0052): Person Profiles and
 * Tasks are Workspace resources with their own product surfaces, not Modules,
 * and Meeting Wizard presents two Modules under one tab. The header nav and
 * Home's cards both render from here, so the two cannot disagree about what
 * exists.
 */
export interface ProductArea {
  /** Stable identity. Survives a route rename; never derived from `path`. */
  id: string;
  /** Where the nav and Home's card link. Presentation — expected to change. */
  path: string;
  /**
   * Other route prefixes this area presents, beyond its own `path`. An area
   * may own a surface that does not sit under it — Meeting Wizard presents the
   * Debrief journey at `/meeting-debrief` — and the nav has to know, or those
   * pages show no current product at all.
   */
  alsoOwns?: readonly string[];
  /** The nav's text, e.g. "Person Profiles". */
  label: string;
  /** One line, for Home's card. */
  description: string;
}

/* Array order is display order, in the nav and on Home alike. */
export const PRODUCT_AREAS: readonly ProductArea[] = [
  {
    id: "content-engine",
    path: "/content-scout",
    label: "Content Engine",
    description: "Evidence-backed platform outlines, and one finished Draft at a time on request.",
  },
  {
    id: "content-research",
    path: "/content-research",
    label: "Content Research",
    description:
      "Watches confirmed people and reports opportunities, watch reports, and YouTube Trends.",
  },
  {
    id: "person-profiles",
    path: "/people",
    label: "Person Profiles",
    description:
      "The Workspace's canonical people resource — evidence-backed identity, review, and corrections.",
  },
  {
    id: "meeting-wizard",
    path: "/meetings",
    label: "Meeting Wizard",
    description: "Prospective Brief and retrospective Debrief, presented as sibling workflows.",
    alsoOwns: ["/meeting-debrief"],
  },
  {
    id: "tasks",
    path: "/tasks",
    label: "Tasks",
    description:
      "The canonical record of accepted work, and the Action Items a Meeting Debrief proposed.",
  },
];

/**
 * Whether one product area is the one the reader is inside. Its own path, or
 * any route it also presents; a prefix only counts at a segment boundary, so
 * `/people` never claims `/peoples`.
 */
export function isCurrentArea(area: ProductArea, pathname: string): boolean {
  const covers = (prefix: string): boolean =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
  return covers(area.path) || (area.alsoOwns ?? []).some(covers);
}
