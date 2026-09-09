/**
 * PROTOTYPE — throwaway data layer for the Person Profile `?variant=` exploration.
 *
 * The question: a Person Profile is an automatically researched, citation-backed
 * dossier whose defining property is that it knows what it does not know
 * (issue #204's rule, reviewed in docs/research/person-dossier-acceptance.md).
 * Today that shows as ten tabs of identical grey cards with "status · nature ·
 * date" in muted text. What should it look like instead?
 *
 * Variants read the real dossier when the Workspace has one. When it does not —
 * research needs web access and budget, so a dev Workspace usually has nothing —
 * they fall back to the DEMO corpus below so four variants can actually be told
 * apart. The corpus is the repo's own fictional acceptance fixture
 * (tests/fixtures/person-dossiers/comprehensive.json, "Maya Chen"), widened with
 * the dates its own source text states and split across six source documents so
 * provenance has structure. It is entirely fictional and every surface says so.
 *
 * Delete with the losing variants.
 */
import { useEffect, useState } from "react";
import type { PersonClaim, PersonDossier, PersonSourceDocument } from "@chief-of-staff-demo/shared";
import { request } from "../client";

type Mode = "live" | "demo";

/* ---------------------------------------------------------------- sources -- */

const source = (
  id: string,
  title: string,
  family: string,
  sourceClass: PersonSourceDocument["sourceClass"],
  extra: Partial<PersonSourceDocument> = {},
): PersonSourceDocument => ({
  schemaVersion: 1,
  id,
  url: `https://example.com/${id}`,
  title,
  author: null,
  publishedAt: null,
  retrievedAt: "2026-09-04",
  text: "",
  hash: "0".repeat(64),
  family,
  sourceClass,
  visibility: "public",
  completeness: "full",
  access: "retrieved",
  acquisition: "Fictional demo corpus — not retrieved.",
  ...extra,
});

const DEMO_SOURCES: PersonSourceDocument[] = [
  source(
    "northline-registry",
    "Northline Engineering Registry",
    "northline.example",
    "independent-account",
    {
      publishedAt: "2024-06-01",
    },
  ),
  source(
    "eastline-directory",
    "Eastline Staff Directory",
    "eastline.example",
    "independent-account",
    {
      publishedAt: "2025-02-01",
    },
  ),
  source(
    "atlas-postmortem",
    "Atlas mobile client postmortem",
    "northline.example",
    "primary-artifact",
    {
      publishedAt: "2024-11-12",
    },
  ),
  source(
    "nova-paper",
    "Nova: bounded queues and recovery predictability",
    "arxiv.example",
    "primary-artifact",
    {
      publishedAt: "2024-03-01",
      author: "M. Chen, D. Ortiz",
    },
  ),
  source("maya-site", "Personal site — about", "maya.example", "self-report", {
    publishedAt: "2026-01-04",
    completeness: "partial",
  }),
  source(
    "audit-board",
    "Northline Audit Board — 2024 recovery report",
    "auditboard.example",
    "independent-account",
    {
      publishedAt: "2024-09-30",
    },
  ),
];

/* ----------------------------------------------------------------- claims -- */

const claim = (
  id: string,
  section: PersonClaim["section"],
  statement: string,
  status: PersonClaim["status"],
  citations: { sourceId: string; quote: string }[],
  extra: Partial<PersonClaim> = {},
): PersonClaim => ({
  id,
  section,
  statement,
  status,
  nature: "statement",
  matchConfidence: "high",
  effectiveFrom: null,
  effectiveTo: null,
  citations,
  supports: [],
  supersedes: [],
  changeReason: null,
  ...extra,
});

const cite = (sourceId: string, quote: string) => ({ sourceId, quote });

const DEMO_CLAIMS: PersonClaim[] = [
  claim(
    "build",
    "work",
    "Maya Chen designed the Atlas scheduler; the Northline team built its user interface.",
    "supported",
    [
      cite(
        "northline-registry",
        "Maya Chen designed the Atlas scheduler; the Northline team built its user interface.",
      ),
      cite("atlas-postmortem", "Scheduler design was owned by M. Chen."),
    ],
    { effectiveFrom: "2023-02-01", effectiveTo: "2025-01-01" },
  ),
  claim(
    "scale",
    "work",
    "Atlas served 200 deployment sites in 2024; Maya managed its eight-person runtime team.",
    "supported",
    [
      cite(
        "northline-registry",
        "Atlas served 200 deployment sites in 2024; Maya managed its eight-person runtime team.",
      ),
      cite("audit-board", "Deployment count at review: 200 sites."),
    ],
    { effectiveFrom: "2024-01-01" },
  ),
  claim(
    "authority",
    "work",
    "Maya recommended the scheduler architecture and executed its implementation; budget approval belonged to Daniel Ortiz.",
    "supported",
    [
      cite(
        "northline-registry",
        "Maya recommended the scheduler architecture and executed its implementation; budget approval belonged to Daniel.",
      ),
      cite("maya-site", "I proposed the architecture and wrote the first implementation."),
    ],
    { effectiveFrom: "2023-02-01" },
  ),
  claim(
    "constraints",
    "work",
    "Atlas ran under a 256 MB memory ceiling and audited safety-critical release controls.",
    "supported",
    [
      cite(
        "atlas-postmortem",
        "Atlas had a 256 MB memory ceiling and operated under audited safety-critical release controls.",
      ),
      cite("audit-board", "The release process met the audited safety-critical controls."),
    ],
    { effectiveFrom: "2023-02-01" },
  ),
  claim(
    "failure",
    "work",
    "The Atlas mobile client was shut down in 2024 after a public postmortem documented excessive memory use.",
    "supported",
    [
      cite(
        "atlas-postmortem",
        "The Atlas mobile client was shut down in 2024 after a public postmortem documented excessive memory use.",
      ),
    ],
    { effectiveFrom: "2024-11-12" },
  ),
  claim(
    "after",
    "work",
    "After Maya left Atlas in 2025, the operator reported the system remained active at 200 sites.",
    "supported",
    [
      cite(
        "northline-registry",
        "After Maya left Atlas in 2025, the operator reported that the system remained active at 200 sites.",
      ),
      cite("eastline-directory", "Previously: Northline, to January 2025."),
    ],
    { effectiveFrom: "2025-01-01" },
  ),
  claim(
    "focus",
    "career",
    "Maya researched scheduling in 2021, deployed Atlas in 2023, and began safety policy work in 2025.",
    "supported",
    [
      cite(
        "northline-registry",
        "Maya researched scheduling in 2021, deployed Atlas in 2023, and began safety policy work in 2025.",
      ),
      cite("maya-site", "2021 scheduling research · 2023 Atlas · 2025 safety policy"),
    ],
    { effectiveFrom: "2021-01-01" },
  ),
  claim(
    "boundary",
    "career",
    "Maya moved from university research to Northline product engineering in 2022, then to safety policy in 2025.",
    "supported",
    [
      cite(
        "northline-registry",
        "Maya moved from university research to Northline product engineering in 2022, then to safety policy in 2025.",
      ),
    ],
    { effectiveFrom: "2022-01-01" },
  ),
  claim(
    "cadence",
    "career",
    "The observed record contains an Atlas release in February 2023 and the Nova paper in March 2024; private work is not indexed.",
    "supported",
    [
      cite(
        "northline-registry",
        "The observed record contains an Atlas release in February 2023 and the Nova paper in March 2024; private work is not indexed.",
      ),
    ],
    { effectiveFrom: "2023-02-01", nature: "interpretation" },
  ),
  claim(
    "writing",
    "ideas",
    "Maya's 2024 paper Nova argues that bounded queues improve recovery predictability; publication does not document a deployed product.",
    "supported",
    [
      cite("nova-paper", "We argue that bounded queues improve recovery predictability."),
      cite("maya-site", "Writing: Nova (2024), on bounded queues."),
    ],
    { effectiveFrom: "2024-03-01" },
  ),
  claim("expertise", "expertise", "Maya lists Rust as a skill.", "claimed", [
    cite("maya-site", "Skills: Rust, distributed systems, scheduling."),
  ]),
  claim(
    "collaborator",
    "connections",
    "Maya and Daniel Ortiz co-authored Atlas in 2023 and Nova in 2024.",
    "supported",
    [
      cite("nova-paper", "M. Chen, D. Ortiz"),
      cite(
        "northline-registry",
        "Maya and Daniel Ortiz co-authored Atlas in 2023 and Nova in 2024.",
      ),
    ],
    { effectiveFrom: "2023-01-01" },
  ),
  claim(
    "repeat",
    "connections",
    "Maya and Daniel worked together again on Nova after both moved from Northline to Eastline.",
    "supported",
    [cite("nova-paper", "Both authors are now affiliated with Eastline.")],
    { effectiveFrom: "2024-03-01", nature: "interpretation" },
  ),
  claim(
    "verifier",
    "recognition",
    "The Northline Audit Board independently verified Atlas recovery tests in its 2024 report.",
    "supported",
    [
      cite("audit-board", "The Board verified the Atlas recovery test results reported for 2024."),
      cite("atlas-postmortem", "Recovery tests were reviewed by the Audit Board."),
    ],
    { effectiveFrom: "2024-09-30" },
  ),
  claim(
    "credit",
    "recognition",
    "The Nova acknowledgment names Maya for identifying a recovery race; whether the credit was solicited is unknown.",
    "supported",
    [cite("nova-paper", "We thank M. Chen for identifying a recovery race condition.")],
    { effectiveFrom: "2024-03-01" },
  ),
  claim(
    "governance",
    "context",
    "Maya held an Eastline advisory seat from 2024 to 2025; the Field Fund financed Nova.",
    "supported",
    [cite("eastline-directory", "Advisory seat, 2024–2025. Nova financed by the Field Fund.")],
    { effectiveFrom: "2024-01-01", effectiveTo: "2025-12-31" },
  ),
  claim("constraints-now", "context", "Maya publicly lists English and UTC-5.", "claimed", [
    cite("maya-site", "English · UTC-5"),
  ]),
  claim(
    "conflict",
    "context",
    "One directory calls Maya an advisor; another calls her a director. Neither account supplies an effective date.",
    "contested",
    [
      cite("northline-registry", "Maya Chen — Advisor"),
      cite("eastline-directory", "Maya Chen — Director, Platform Safety"),
    ],
    { fact: { field: "role", value: "Advisor / Director (contested)" } },
  ),
  claim(
    "unknown-restrictions",
    "context",
    "Availability, IP terms, noncompetes and clearance are undocumented.",
    "unknown",
    [cite("maya-site", "English · UTC-5")],
  ),
  claim(
    "unknown-comp",
    "work",
    "No source separates Maya's individual contribution from team output on Nova.",
    "unknown",
    [cite("nova-paper", "M. Chen, D. Ortiz")],
  ),
  claim(
    "stale-employer",
    "career",
    "Northline lists Maya as current staff.",
    "stale",
    [cite("northline-registry", "Current staff: M. Chen, runtime.")],
    { effectiveFrom: "2023-02-01", effectiveTo: "2025-01-01" },
  ),
];

/* ------------------------------------------------------------ the dossier -- */

const DEMO_DOSSIER: PersonDossier = {
  schemaVersion: 1,
  profileId: "demo",
  revision: 4,
  updatedAt: "2026-09-04T09:12:00.000Z",
  sourceIds: DEMO_SOURCES.map((s) => s.id),
  claims: DEMO_CLAIMS,
  works: [
    {
      id: "atlas",
      title: "Atlas",
      url: "https://example.com/atlas",
      kind: "release",
      startedAt: "2023-02-01",
      endedAt: "2025-01-01",
      claimIds: ["build"],
      contribution: { text: "Designed the scheduler", claimIds: ["build"] },
      teamContribution: { text: "The team built the user interface", claimIds: ["build"] },
      authority: [
        { role: "recommended", claimIds: ["authority"] },
        { role: "executed", claimIds: ["authority"] },
      ],
      scale: [
        { value: 200, unit: "sites", scope: "Atlas deployment", date: "2024", claimIds: ["scale"] },
        {
          value: 8,
          unit: "people",
          scope: "Maya's runtime team",
          date: "2024",
          claimIds: ["scale"],
        },
      ],
      constraints: [
        {
          text: "256 MB memory ceiling; audited safety-critical release controls",
          claimIds: ["constraints"],
        },
      ],
      outcomes: [
        {
          text: "Active at 200 sites after departure",
          date: "2025",
          afterDeparture: true,
          unsuccessful: false,
          claimIds: ["after"],
        },
        {
          text: "Mobile client shut down for excessive memory use",
          date: "2024",
          afterDeparture: false,
          unsuccessful: true,
          claimIds: ["failure"],
        },
      ],
    },
    {
      id: "nova",
      title: "Nova",
      url: "https://example.com/nova",
      kind: "paper",
      startedAt: "2024-03-01",
      endedAt: null,
      claimIds: ["writing"],
      contribution: null,
      teamContribution: null,
      authority: [],
      scale: [],
      constraints: [],
      outcomes: [],
    },
    {
      id: "policy",
      title: "Safety policy programme",
      url: null,
      kind: "other",
      startedAt: "2025-01-01",
      endedAt: null,
      claimIds: ["focus"],
      contribution: null,
      teamContribution: null,
      authority: [],
      scale: [],
      constraints: [],
      outcomes: [],
    },
  ],
  expertise: [
    {
      category: "distributed scheduling",
      originalWording: "distributed scheduling work",
      support: "demonstrated",
      workIds: ["atlas"],
      claimIds: ["build"],
    },
    {
      category: "safety regulation",
      originalWording: "audited safety-critical release controls",
      support: "demonstrated",
      workIds: ["atlas"],
      claimIds: ["constraints"],
    },
    {
      category: "rust",
      originalWording: "lists Rust as a skill",
      support: "claimed",
      workIds: [],
      claimIds: ["expertise"],
    },
  ],
  connections: [
    {
      id: "daniel",
      counterparty: "Daniel Ortiz",
      profileId: null,
      kind: "co-authored",
      direction: "undirected",
      from: "2023",
      to: null,
      workIds: ["atlas", "nova"],
      claimIds: ["collaborator", "repeat"],
    },
    {
      id: "fund",
      counterparty: "Field Fund",
      profileId: null,
      kind: "funded",
      direction: "incoming",
      from: "2024",
      to: null,
      workIds: ["nova"],
      claimIds: ["governance"],
    },
    {
      id: "board",
      counterparty: "Northline Audit Board",
      profileId: null,
      kind: "credited",
      direction: "incoming",
      from: "2024",
      to: null,
      workIds: ["atlas"],
      claimIds: ["verifier"],
    },
    {
      id: "eastline",
      counterparty: "Eastline",
      profileId: null,
      kind: "advised",
      direction: "outgoing",
      from: "2024",
      to: "2025",
      workIds: [],
      claimIds: ["governance"],
    },
  ],
  sections: [
    {
      key: "overview",
      summary:
        "A distributed-systems engineer moving from scheduling implementation into safety policy. The current role is contested between two directories.",
      claimIds: ["build", "focus", "conflict"],
      updatedAt: "2026-09-04",
      state: "incomplete",
      gaps: ["Current employer is unresolved between two independent accounts."],
    },
    {
      key: "career",
      summary:
        "Research in 2021, product engineering from 2022, Atlas from 2023, safety policy from 2025.",
      claimIds: ["focus", "boundary", "cadence"],
      updatedAt: "2026-09-04",
      state: "current",
      gaps: ["No source dates the move from Northline to Eastline."],
    },
    {
      key: "work",
      summary:
        "Designed the Atlas scheduler under audited release controls; the team built its interface. One documented failure and one documented after-departure outcome.",
      claimIds: ["build", "scale", "authority", "constraints", "failure", "after"],
      updatedAt: "2026-09-04",
      state: "current",
      gaps: [
        "Nova's individual/team split is undocumented.",
        "No magnitude is recorded for the safety policy work.",
      ],
    },
    {
      key: "expertise",
      summary:
        "Distributed scheduling and safety regulation are demonstrated through Atlas. Rust is claimed only.",
      claimIds: ["build", "constraints", "expertise"],
      updatedAt: "2026-09-04",
      state: "incomplete",
      gaps: ["No artifact demonstrates the Rust claim."],
    },
    {
      key: "ideas",
      summary: "One 2024 paper argues bounded queues improve recovery predictability.",
      claimIds: ["writing"],
      updatedAt: "2026-09-04",
      state: "incomplete",
      gaps: ["No talks, posts or public commentary were found."],
    },
    {
      key: "connections",
      summary:
        "One repeated collaborator across two distinct works; one funder; one verifying body.",
      claimIds: ["collaborator", "repeat", "governance"],
      updatedAt: "2026-09-04",
      state: "current",
      gaps: ["No reporting line is documented for any employer."],
    },
    {
      key: "recognition",
      summary:
        "Independently verified by the Northline Audit Board; acknowledged in Nova for identifying a recovery race.",
      claimIds: ["verifier", "credit"],
      updatedAt: "2026-09-04",
      state: "current",
      gaps: ["Whether the Nova credit was solicited is unknown."],
    },
    {
      key: "context",
      summary:
        "An Eastline advisory seat 2024–2025, financed work through the Field Fund, and a contested current role.",
      claimIds: ["governance", "constraints-now", "conflict"],
      updatedAt: "2026-09-04",
      state: "incomplete",
      gaps: [
        "Availability, IP terms, noncompetes and clearance are undocumented.",
        "Neither directory dates its role claim.",
      ],
    },
  ],
};

/* -------------------------------------------------------------- the hook -- */

export interface DossierView {
  dossier: PersonDossier;
  sources: PersonSourceDocument[];
  mode: Mode;
  name: string;
}

/**
 * Read-only. Asks the Workspace for the real dossier and falls back to the demo
 * corpus when there is none — a prototype that renders four empty pages teaches
 * nothing.
 */
export function usePrototypeDossier(
  profileId: string,
  name: string,
  enabled: boolean,
): DossierView | null {
  const [view, setView] = useState<DossierView | null>(null);
  useEffect(() => {
    /* Inert unless a variant is actually being viewed: the throwaway prototype
       must not add a request to the route every real reader loads. */
    if (!enabled) return;
    let live = true;
    const fallback: DossierView = {
      dossier: DEMO_DOSSIER,
      sources: DEMO_SOURCES,
      mode: "demo",
      name: "Maya Chen",
    };
    void request<{ dossier: PersonDossier | null }>(
      `/api/people/${encodeURIComponent(profileId)}/dossier`,
    )
      .then(async (payload) => {
        const real = payload.dossier;
        /* One liveness check, read after the awaits rather than before them:
           two checks in the same closure narrow the flag and the second reads
           as dead code. */
        if (!real || real.claims.length === 0) {
          if (live) setView(fallback);
          return;
        }
        const sources = await Promise.all(
          real.sourceIds.map((id) =>
            request<PersonSourceDocument>(
              `/api/people/${encodeURIComponent(profileId)}/sources/${encodeURIComponent(id)}`,
            ).catch(() => null),
          ),
        );
        if (!live) return;
        setView({
          dossier: real,
          sources: sources.filter((x): x is PersonSourceDocument => x !== null),
          mode: "live",
          name,
        });
      })
      .catch(() => {
        if (live) setView(fallback);
      });
    return () => {
      live = false;
    };
  }, [profileId, name, enabled]);
  return view;
}

/* ------------------------------------------------------------- selectors -- */

export function activeClaims(dossier: PersonDossier): PersonClaim[] {
  return dossier.claims.filter((c) => c.status !== "superseded");
}

/** Claims whose every citation comes from one source family. */
export function singleFamily(claim: PersonClaim, sources: PersonSourceDocument[]): boolean {
  const families = new Set(
    claim.citations.map((c) => sources.find((s) => s.id === c.sourceId)?.family ?? c.sourceId),
  );
  return families.size <= 1;
}

export function year(date: string | null | undefined): number | null {
  if (!date) return null;
  const parsed = Number(date.slice(0, 4));
  return Number.isFinite(parsed) && parsed > 1900 ? parsed : null;
}

/** Every gap the record states about itself, with the section that owns it. */
export function gaps(dossier: PersonDossier): { key: string; section: string; text: string }[] {
  return dossier.sections.flatMap((s) =>
    s.gaps.map((text, i) => ({ key: `${s.key}-${i}`, section: s.key, text })),
  );
}
