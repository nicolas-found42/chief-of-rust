import {
  CONTENT_PROJECT_GATES,
  type ContentProjectGate,
  type ContentProjectReadiness,
} from "@chief-of-staff-demo/shared";

export interface ContentProjectGateNotice {
  gate: ContentProjectGate;
  /** What is missing, in the owner's words rather than the token's. */
  label: string;
  /** Where it is satisfied, so an unmet gate is one click from being fixed. */
  href: string | null;
  hrefLabel: string | null;
}

/**
 * A Content Project's readiness as the page states it (spec #147).
 *
 * Derived from `CONTENT_PROJECT_GATES` rather than a hand-kept list, so a gate
 * added to the domain cannot silently render as nothing. Kept a pure function
 * for the same reason Home's status sentence is one: several of these states
 * are awkward to reach end to end, and they still need asserting somewhere.
 */
const GATE_PRESENTATION: Record<
  ContentProjectGate,
  { label: string; href: string | null; hrefLabel: string | null }
> = {
  "canonical-owner": {
    label: "The workspace owner Profile is not confirmed.",
    href: "/settings",
    hrefLabel: "Confirm it in Settings",
  },
  "brand-voice": {
    label: "No Brand Voice revision has been accepted.",
    href: "/content-scout",
    hrefLabel: "Accept one in Brand Profile",
  },
  "author-authority": {
    label: "The Authorized Author is not authorized to be represented.",
    href: "/people",
    hrefLabel: "Open Person Profiles",
  },
  "content-voice": {
    label: "The Authorized Author has no approved Content Voice.",
    href: null,
    hrefLabel: null,
  },
  "research-mode": {
    label: "The Project states no research mode.",
    href: null,
    hrefLabel: null,
  },
  "evidence-review": {
    label: "The Project's evidence has not been reviewed and frozen.",
    href: null,
    hrefLabel: null,
  },
  "no-research-acknowledgement": {
    label: "Generating without external research has not been acknowledged.",
    href: null,
    hrefLabel: null,
  },
  target: {
    label: "The Project names no publication target.",
    href: null,
    hrefLabel: null,
  },
};

export function contentProjectGateNotices(
  readiness: ContentProjectReadiness,
): ContentProjectGateNotice[] {
  const missing = new Set(readiness.missingGates);
  /* Ordered by the domain's own list, not by the order the refusal happened to
     report them, so the same Project always reads the same way. */
  return CONTENT_PROJECT_GATES.filter((gate) => missing.has(gate)).map((gate) => ({
    gate,
    ...GATE_PRESENTATION[gate],
  }));
}

/** The one-line standing a list row shows. */
export function contentProjectReadinessLabel(readiness: ContentProjectReadiness): string {
  if (readiness.ready) return "Ready to generate";
  const count = readiness.missingGates.length;
  return count === 1 ? "1 gate to clear" : `${count} gates to clear`;
}
