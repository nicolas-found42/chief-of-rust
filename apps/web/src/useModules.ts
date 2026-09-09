/**
 * The Modules this Shell hosts, as one list rather than two.
 *
 * Since the product-area cutover (spec: Navigation and onboarding #1) the
 * header nav and Home's cards render the explicit four-area list in
 * productAreas.ts instead; this descriptor list remains what Run rendering
 * reads — a Run's label and its Module's own ResultView. It is not the
 * server-side registry of ADR-0002: it is the seam that registry can slot
 * behind later without either caller changing, which is why it is shaped as
 * what an endpoint would serve.
 *
 * A hook rather than an exported const for that same reason — the day this
 * becomes a fetch, a const forces both callers to become async, and that is the
 * callers changing.
 */
import type { ComponentType } from "react";
import type { RunDetail } from "@chief-of-staff-demo/shared";
import { ContentScoutResultView } from "./modules/content-scout/ResultView";
import { MeetingBriefResultView } from "./modules/meeting-brief/ResultView";

export interface ModuleDescriptor {
  /** Stable identity. Survives a route rename; never derived from `path`. */
  id: string;
  /** Where the Module's Runs surface links. Presentation — expected to change. */
  path: string;
  /** How the Module is named aloud, e.g. on a Run row. */
  label: string;
  /** One line, for contexts that summarize the Module. */
  description: string;
  /** A planned Module has no Runs yet (CONTEXT.md). */
  status: "live" | "planned";
  /**
   * The Module's own view of one of its Runs, rendered under the Shell's half
   * of the Run detail page. Absent is a real answer: a Module's first phase
   * gets the Shell's half and links to its files, which is what it needs. A
   * formatted dump of the result would be a permanent "we will design this
   * later" shipped to somebody who cannot read it.
   */
  resultView?: ComponentType<{ detail: RunDetail }>;
  /**
   * The Module whose product surface presents this one, when the Shell does
   * not present it as its own tab. The tab bar renders top-level Modules only;
   * a presented-under Module is announced on Home and entered from its
   * parent's page (spec: YouTube Trends at /content-research/trends).
   */
  parent?: string;
}

/* Array order is display order, wherever the list is rendered. */
const MODULES: ModuleDescriptor[] = [
  {
    id: "youtube-trends",
    path: "/content-research/trends",
    label: "YouTube Trends",
    parent: "content-research",
    description: "Every video on a channel, counted once a day, into a trend.",
    status: "live",
    /* No result view in phase 1, which is a real answer rather than a gap: the
       Shell's half of the Run detail page and the links to the Run's own files
       are what a first phase needs, and a formatted dump of the result would be
       a permanent "we will design this later". */
  },
  {
    id: "content-scout",
    path: "/content-scout",
    label: "Content Scout",
    description:
      "Public sources become a ranked shortlist; selecting an Opportunity starts one governed Content Project.",
    status: "live",
    resultView: ContentScoutResultView,
  },
  {
    id: "meeting-brief-generator",
    path: "/meetings/brief",
    label: "Meeting Brief Generator",
    description:
      "Prepare concise briefings for upcoming internal and external meetings — history, company, intelligence, and Person Profiles.",
    status: "live",
    resultView: MeetingBriefResultView,
  },
  {
    id: "meeting-debrief",
    path: "/meeting-debrief",
    label: "Meeting Debrief",
    description:
      "Every mined transcript gets a retrospective — decisions, action items, open questions, and coaching — waiting for review.",
    status: "live",
  },
  {
    id: "content-research",
    path: "/content-research",
    label: "Content Research",
    description: "Named people, what is resonating for them, and why — ranked by resonance.",
    status: "live",
  },
];

/**
 * How a Module's identity is spoken aloud. A Run whose Module is no longer
 * hosted keeps its raw identifier rather than vanishing: history does not
 * disappear because a Module was removed.
 */
export function useModuleLabel(): (id: string) => string {
  return (id: string) => MODULES.find((module) => module.id === id)?.label ?? id;
}

/** The Module that made a Run, when this Shell still hosts it. */
export function useModule(id: string | undefined): ModuleDescriptor | null {
  return MODULES.find((module) => module.id === id) ?? null;
}
