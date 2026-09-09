/**
 * PROTOTYPE — throwaway Person Profile UI exploration (?variant=a|b|c|d).
 *
 * Four structurally opposed answers to "what should a citation-backed dossier
 * that knows its own gaps look like?". They disagree about the organising axis,
 * not about colour:
 *
 *   A  Critical Edition — organised by TRUST. Strata from established to
 *      unknown; citations live in a margin apparatus. No tabs, no cards.
 *   B  Spine — organised by TIME. One year axis, everything as lanes against
 *      it, and an Undated gutter that shows the cost of an unanchored record.
 *   C  Provenance — organised by EVIDENCE TOPOLOGY. Sources and claims joined
 *      by arcs; retract a source and watch which claims stop standing.
 *   D  Prep Sheet — organised by the MEETING. The gaps are the agenda; what is
 *      known is the sidebar so you don't ask what the record already answers.
 *
 * Delete with the losers.
 */
import { useMemo, useState, type Ref } from "react";
import "./personProfilePrototype.css";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import type { PersonClaim, PersonSourceDocument } from "@chief-of-staff-demo/shared";
import {
  activeClaims,
  gaps,
  singleFamily,
  year,
  type DossierView,
} from "./personProfilePrototypeData";

/* --------------------------------------------------------------- shared -- */

/** Each variant renders the route's only <h1>, so it takes the focus target
    usePageFocus hands out (WCAG 2.4.3) rather than the host page growing a
    second heading beside the design being judged. */
export interface VariantProps {
  view: DossierView;
  headingRef?: Ref<HTMLHeadingElement>;
}

/** Rule 5: every variant prints the state it is rendering from. */
function StateLine({ variant, view }: { variant: string; view: DossierView }) {
  const claims = activeClaims(view.dossier);
  const byStatus = STATUSES.map((s) => `${s}=${claims.filter((c) => c.status === s).length}`).join(
    " ",
  );
  return (
    <p className="pp-state" aria-label="Prototype state">
      variant={variant} · corpus={view.mode} · claims={claims.length} · {byStatus} · works=
      {view.dossier.works.length} · sources={view.sources.length} · gaps={gaps(view.dossier).length}
    </p>
  );
}

const STATUSES: PersonClaim["status"][] = ["supported", "claimed", "contested", "stale", "unknown"];

const STATUS_WORD: Record<string, string> = {
  supported: "Established",
  claimed: "Claimed only",
  contested: "Contested",
  stale: "Stale",
  unknown: "Not known",
  superseded: "Superseded",
};

function DemoNotice({ view }: { view: DossierView }) {
  if (view.mode === "live") return null;
  return (
    <p className="pp-demo" role="status">
      <strong>Fictional demo corpus.</strong> This Workspace has no researched dossier, so the
      variants render the repo&rsquo;s own acceptance fixture. No claim refers to a real person.
    </p>
  );
}

const sourceOf = (sources: PersonSourceDocument[], id: string) =>
  sources.find((s) => s.id === id) ?? null;

/* ============================== A — Critical Edition ====================== */
/* Organising axis: TRUST. The page is stratified by how far each statement can
   be taken, so the reader never has to decode a status word in a metadata line —
   position on the page is the status. Citations sit in a right-hand apparatus,
   the way a critical edition carries its own evidence. */

export function VariantA({ view, headingRef }: VariantProps) {
  const claims = activeClaims(view.dossier);
  const [open, setOpen] = useState<{ claimId: string; index: number } | null>(null);
  const strata = STATUSES.map((status) => ({
    status,
    items: claims.filter((c) => c.status === status),
  })).filter((s) => s.items.length > 0);
  const openClaim = claims.find((c) => c.id === open?.claimId) ?? null;
  const openCitation = openClaim && open ? openClaim.citations[open.index] : null;
  const openSource = openCitation ? sourceOf(view.sources, openCitation.sourceId) : null;
  const total = claims.length || 1;

  return (
    <MotionConfig reducedMotion="user">
      <div className="pp-proto ppa">
        <DemoNotice view={view} />
        <header className="ppa-head">
          <h1 ref={headingRef} tabIndex={-1}>
            {view.name}
          </h1>
          <p className="ppa-sub">
            Revision {view.dossier.revision} · researched {view.dossier.updatedAt.slice(0, 10)}
          </p>
          {/* The first thing the reader gets is how far the record can be taken. */}
          <div
            className="ppa-ribbon"
            role="img"
            aria-label={STATUSES.map(
              (s) => `${claims.filter((c) => c.status === s).length} ${STATUS_WORD[s]}`,
            ).join(", ")}
          >
            {STATUSES.map((s) => {
              const n = claims.filter((c) => c.status === s).length;
              if (n === 0) return null;
              return (
                <span
                  key={s}
                  className={`ppa-ribbon-seg is-${s}`}
                  style={{ flexGrow: n }}
                  title={`${n} ${STATUS_WORD[s]}`}
                />
              );
            })}
          </div>
          <ol className="ppa-key">
            {STATUSES.map((s) => {
              const n = claims.filter((c) => c.status === s).length;
              if (n === 0) return null;
              return (
                <li key={s}>
                  <span className={`ppa-dot is-${s}`} /> {n} {STATUS_WORD[s]}
                  <span className="ppa-pct"> {Math.round((n / total) * 100)}%</span>
                </li>
              );
            })}
          </ol>
        </header>

        <div className="ppa-body">
          <div className="ppa-text">
            {strata.map(({ status, items }) => (
              <section key={status} className={`ppa-stratum is-${status}`}>
                <h2>{STATUS_WORD[status]}</h2>
                {status === "contested"
                  ? items.map((c) => (
                      <article key={c.id} className="ppa-contest">
                        <p className="ppa-contest-q">{c.statement}</p>
                        <div className="ppa-contest-split">
                          {c.citations.map((cit, i) => {
                            const src = sourceOf(view.sources, cit.sourceId);
                            return (
                              <blockquote key={i}>
                                <p>&ldquo;{cit.quote}&rdquo;</p>
                                <footer>
                                  {src?.title ?? cit.sourceId}
                                  <span className="ppa-class">
                                    {" "}
                                    · {src?.sourceClass ?? "unknown"}
                                  </span>
                                </footer>
                              </blockquote>
                            );
                          })}
                        </div>
                        <p className="ppa-contest-note">
                          Neither account is preferred and the Profile&rsquo;s own factual record is
                          not overwritten.
                        </p>
                      </article>
                    ))
                  : items.map((c) => (
                      <p key={c.id} className="ppa-claim">
                        {c.statement}
                        {c.nature === "interpretation" && (
                          <span className="ppa-interp" title="Interpretation, not a stated fact">
                            {" "}
                            inferred
                          </span>
                        )}
                        {singleFamily(c, view.sources) && c.status === "supported" && (
                          <span
                            className="ppa-single"
                            title="Every citation comes from one source family"
                          >
                            {" "}
                            one family only
                          </span>
                        )}
                        {c.citations.map((_, i) => (
                          <button
                            key={i}
                            type="button"
                            className={
                              open?.claimId === c.id && open.index === i
                                ? "ppa-mark is-open"
                                : "ppa-mark"
                            }
                            aria-label={`Show citation ${i + 1} for this statement`}
                            onClick={() =>
                              setOpen(
                                open?.claimId === c.id && open.index === i
                                  ? null
                                  : { claimId: c.id, index: i },
                              )
                            }
                          >
                            {i + 1}
                          </button>
                        ))}
                      </p>
                    ))}
              </section>
            ))}

            {/* The record's own account of what it does not have. Given the same
                weight as what it does — that is the whole discipline of #204. */}
            <section className="ppa-stratum is-gap">
              <h2>What the record does not have</h2>
              <ul className="ppa-gaps">
                {gaps(view.dossier).map((g) => (
                  <li key={g.key}>
                    <span className="ppa-gap-sec">{g.section}</span> {g.text}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* The apparatus. Empty until a marker is pressed, and it says so. */}
          <aside className="ppa-margin" aria-live="polite">
            <AnimatePresence mode="wait">
              {openCitation ? (
                <motion.div
                  key={`${open?.claimId}-${open?.index}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="ppa-apparatus"
                >
                  <p className="ppa-quote">&ldquo;{openCitation.quote}&rdquo;</p>
                  <p className="ppa-src">{openSource?.title ?? openCitation.sourceId}</p>
                  <dl className="ppa-meta">
                    <dt>Class</dt>
                    <dd>{openSource?.sourceClass ?? "—"}</dd>
                    <dt>Family</dt>
                    <dd>{openSource?.family ?? "—"}</dd>
                    <dt>Completeness</dt>
                    <dd>{openSource?.completeness ?? "—"}</dd>
                    <dt>Published</dt>
                    <dd>{openSource?.publishedAt ?? "undated"}</dd>
                  </dl>
                </motion.div>
              ) : (
                <motion.p
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="ppa-idle"
                >
                  Every statement above carries its sources as numbered marks. Press one to read the
                  passage it rests on.
                </motion.p>
              )}
            </AnimatePresence>
          </aside>
        </div>
        <StateLine variant="a" view={view} />
      </div>
    </MotionConfig>
  );
}

/* ==================================== B — Spine =========================== */
/* Organising axis: TIME. One year scale; works, career and ties are lanes
   against it. Anything the record cannot place in time falls into the Undated
   gutter, which is deliberately large — an unanchored record should look
   unanchored. Picking a year reconstructs what was true then. */

export function VariantB({ view, headingRef }: VariantProps) {
  const { dossier } = view;
  const claims = activeClaims(dossier);
  const [focus, setFocus] = useState<number | null>(null);

  const years = useMemo(() => {
    const found: number[] = [];
    for (const c of claims) {
      const y = year(c.effectiveFrom);
      if (y) found.push(y);
    }
    for (const w of dossier.works) {
      const a = year(w.startedAt);
      const b = year(w.endedAt);
      if (a) found.push(a);
      if (b) found.push(b);
    }
    for (const n of dossier.connections) {
      const a = year(n.from);
      if (a) found.push(a);
    }
    const now = new Date().getFullYear();
    const min = found.length ? Math.min(...found) : now - 4;
    const max = Math.max(now, ...(found.length ? found : [now]));
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }, [claims, dossier]);

  const first = years[0]!;
  const span = years.length;
  const col = (y: number | null, fallback: number) =>
    Math.min(Math.max((y ?? fallback) - first + 1, 1), span);

  const undatedClaims = claims.filter((c) => year(c.effectiveFrom) === null);
  const undatedWorks = dossier.works.filter((w) => year(w.startedAt) === null);

  /* What the record says was true in the focused year: a claim counts when its
     effective range covers it. This is the payoff of storing ranges at all. */
  const asOf = focus
    ? claims.filter((c) => {
        const from = year(c.effectiveFrom);
        if (from === null || from > focus) return false;
        const to = year(c.effectiveTo);
        return to === null || to >= focus;
      })
    : [];

  const dim = (y: number | null, to: number | null) => {
    if (focus === null) return false;
    if (y === null) return true;
    return y > focus || (to !== null && to < focus);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="pp-proto ppb">
        <DemoNotice view={view} />
        <header className="ppb-head">
          <div>
            <h1 ref={headingRef} tabIndex={-1}>
              {view.name}
            </h1>
            <p className="ppb-sub">
              {span} years of record · {undatedClaims.length + undatedWorks.length} entries the
              record cannot place in time
            </p>
          </div>
          <div className="ppb-focus">
            {focus ? (
              <>
                <strong>As of {focus}</strong>
                <button type="button" className="ppb-clear" onClick={() => setFocus(null)}>
                  Clear
                </button>
              </>
            ) : (
              <span className="ppb-hint">Pick a year to rebuild what was true then</span>
            )}
          </div>
        </header>

        <div className="ppb-scroll">
          <div className="ppb-grid" style={{ ["--span" as string]: span }}>
            {/* axis */}
            <div className="ppb-axis" style={{ gridColumn: `1 / span ${span}` }}>
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  className={y === focus ? "ppb-year is-on" : "ppb-year"}
                  aria-pressed={y === focus}
                  onClick={() => setFocus(y === focus ? null : y)}
                >
                  {y}
                </button>
              ))}
            </div>

            <p className="ppb-lane-label" style={{ gridColumn: `1 / span ${span}` }}>
              Work
            </p>
            {dossier.works.map((w) => {
              const a = year(w.startedAt);
              const b = year(w.endedAt);
              if (a === null) return null;
              const start = col(a, first);
              const end = col(b, years[span - 1]!);
              return (
                <motion.div
                  key={w.id}
                  layout
                  className={`ppb-bar is-${w.kind}`}
                  animate={{ opacity: dim(a, b) ? 0.22 : 1 }}
                  transition={{ duration: 0.18 }}
                  style={{ gridColumn: `${start} / span ${Math.max(end - start + 1, 1)}` }}
                >
                  <span className="ppb-bar-title">{w.title}</span>
                  <span className="ppb-bar-kind">{w.kind}</span>
                  {b === null && <span className="ppb-open">ongoing</span>}
                  <span className="ppb-outcomes">
                    {w.outcomes.map((o, i) => (
                      <span
                        key={i}
                        className={
                          o.unsuccessful
                            ? "ppb-out is-bad"
                            : o.afterDeparture
                              ? "ppb-out is-after"
                              : "ppb-out"
                        }
                        title={`${o.text} (${o.date ?? "undated"})`}
                      >
                        {o.unsuccessful
                          ? "ended badly"
                          : o.afterDeparture
                            ? "outlived them"
                            : "outcome"}
                      </span>
                    ))}
                  </span>
                </motion.div>
              );
            })}

            <p className="ppb-lane-label" style={{ gridColumn: `1 / span ${span}` }}>
              Career
            </p>
            {claims
              .filter((c) => c.section === "career" && year(c.effectiveFrom) !== null)
              .map((c) => {
                const a = year(c.effectiveFrom)!;
                const b = year(c.effectiveTo);
                const start = col(a, first);
                const end = col(b, years[span - 1]!);
                return (
                  <motion.div
                    key={c.id}
                    layout
                    className={`ppb-note is-${c.status}`}
                    animate={{ opacity: dim(a, b) ? 0.22 : 1 }}
                    transition={{ duration: 0.18 }}
                    style={{ gridColumn: `${start} / span ${Math.max(end - start + 1, 1)}` }}
                  >
                    {c.statement}
                    {c.status === "stale" && <span className="ppb-flag">stale</span>}
                  </motion.div>
                );
              })}

            <p className="ppb-lane-label" style={{ gridColumn: `1 / span ${span}` }}>
              Ties
            </p>
            {dossier.connections
              .filter((n) => year(n.from) !== null)
              .map((n) => {
                const a = year(n.from)!;
                const b = year(n.to);
                const start = col(a, first);
                const end = col(b, years[span - 1]!);
                return (
                  <motion.div
                    key={n.id}
                    layout
                    className="ppb-tie"
                    animate={{ opacity: dim(a, b) ? 0.22 : 1 }}
                    transition={{ duration: 0.18 }}
                    style={{ gridColumn: `${start} / span ${Math.max(end - start + 1, 1)}` }}
                  >
                    <strong>{n.counterparty}</strong> <span>{n.kind.replace("-", " ")}</span>
                  </motion.div>
                );
              })}
          </div>
        </div>

        <div className="ppb-foot">
          {/* The honest cost of an unanchored record, given its own real estate
              rather than hidden in a metadata line. */}
          <section className="ppb-gutter">
            <h2>Cannot be placed in time</h2>
            <p className="ppb-gutter-count">{undatedClaims.length + undatedWorks.length} entries</p>
            <ul>
              {undatedWorks.map((w) => (
                <li key={w.id}>
                  <span className="ppb-gutter-kind">work</span> {w.title}
                </li>
              ))}
              {undatedClaims.map((c) => (
                <li key={c.id}>
                  <span className="ppb-gutter-kind">{c.status}</span> {c.statement}
                </li>
              ))}
            </ul>
          </section>
          <section className="ppb-asof">
            <h2>{focus ? `What the record says was true in ${focus}` : "Reconstruction"}</h2>
            {focus === null ? (
              <p className="ppb-hint">
                Pick a year on the axis. Claims carry effective ranges, so the record can be
                replayed at any point rather than only read at today.
              </p>
            ) : asOf.length === 0 ? (
              <p className="ppb-hint">Nothing in the record covers {focus}.</p>
            ) : (
              <ul>
                {asOf.map((c) => (
                  <li key={c.id}>
                    <span className={`ppb-chip is-${c.status}`}>{STATUS_WORD[c.status]}</span>{" "}
                    {c.statement}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <StateLine variant="b" view={view} />
      </div>
    </MotionConfig>
  );
}

/* ================================ C — Provenance ========================== */
/* Organising axis: EVIDENCE TOPOLOGY. Sources on the left, claims on the right,
   citation arcs between. The quality projection counts single-source claims as a
   number; here it is a shape you can see — and you can retract a source and
   watch which statements stop standing. Deterministic layout, fixed row
   heights, so no measurement and no force simulation. */

const ROW_S = 58;
const ROW_C = 30;

export function VariantC({ view, headingRef }: VariantProps) {
  const claims = activeClaims(view.dossier);
  const [retracted, setRetracted] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<{ type: "source" | "claim"; id: string } | null>(null);

  /* Sources the dossier actually cites, in citation order, so the map has no
     rows that no arc reaches. */
  const cited = useMemo(() => {
    const ids: string[] = [];
    for (const c of claims)
      for (const cit of c.citations) if (!ids.includes(cit.sourceId)) ids.push(cit.sourceId);
    return ids;
  }, [claims]);

  const standing = (c: PersonClaim) => c.citations.some((cit) => !retracted.has(cit.sourceId));
  const survivors = claims.filter(standing).length;

  /** Claims that would stop standing if this one source went away. */
  const soleSupport = (sourceId: string) =>
    claims.filter(
      (c) =>
        c.citations.some((cit) => cit.sourceId === sourceId) &&
        c.citations.every((cit) => cit.sourceId === sourceId || retracted.has(cit.sourceId)),
    ).length;

  const sy = (i: number) => i * ROW_S + ROW_S / 2;
  const cy = (i: number) => i * ROW_C + ROW_C / 2;
  const height = Math.max(cited.length * ROW_S, claims.length * ROW_C);
  const sOffset = (height - cited.length * ROW_S) / 2;
  const cOffset = (height - claims.length * ROW_C) / 2;

  const lit = (sourceId: string, claimId: string) => {
    if (!picked) return true;
    if (picked.type === "source") return picked.id === sourceId;
    return picked.id === claimId;
  };

  const pickedClaim = picked?.type === "claim" ? claims.find((c) => c.id === picked.id) : null;
  const pickedSource = picked?.type === "source" ? sourceOf(view.sources, picked.id) : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="pp-proto ppc">
        <DemoNotice view={view} />
        <header className="ppc-head">
          <h1 ref={headingRef} tabIndex={-1}>
            {view.name}
          </h1>
          <div className="ppc-scoreboard">
            <div className={survivors < claims.length ? "ppc-score is-hurt" : "ppc-score"}>
              <strong>
                {survivors} of {claims.length}
              </strong>
              <span>claims still stand</span>
            </div>
            <div className="ppc-score">
              <strong>{claims.filter((c) => singleFamily(c, view.sources)).length}</strong>
              <span>rest on a single source family</span>
            </div>
            <div className="ppc-score">
              <strong>{new Set(view.sources.map((s) => s.family)).size}</strong>
              <span>independent families</span>
            </div>
            {retracted.size > 0 && (
              <button type="button" className="ppc-reset" onClick={() => setRetracted(new Set())}>
                Restore {retracted.size} retracted
              </button>
            )}
          </div>
          <p className="ppc-hint">
            Press a source or a claim to isolate its arcs. <strong>Retract</strong> a source to see
            what the record would lose without it.
          </p>
        </header>

        <div className="ppc-map">
          <ul className="ppc-col ppc-sources" style={{ paddingTop: sOffset }}>
            {cited.map((id) => {
              const src = sourceOf(view.sources, id);
              const gone = retracted.has(id);
              const sole = soleSupport(id);
              return (
                <li
                  key={id}
                  className={gone ? "ppc-source is-gone" : "ppc-source"}
                  style={{ height: ROW_S }}
                >
                  <button
                    type="button"
                    className="ppc-source-btn"
                    aria-pressed={picked?.type === "source" && picked.id === id}
                    onClick={() =>
                      setPicked(
                        picked?.type === "source" && picked.id === id
                          ? null
                          : { type: "source", id },
                      )
                    }
                  >
                    <span className="ppc-source-title">{src?.title ?? id}</span>
                    <span className={`ppc-class is-${src?.sourceClass ?? "unknown"}`}>
                      {(src?.sourceClass ?? "unknown").replace("-", " ")}
                    </span>
                    {sole > 0 && !gone && <span className="ppc-sole">{sole} would fall</span>}
                  </button>
                  <button
                    type="button"
                    className="ppc-retract"
                    onClick={() =>
                      setRetracted((prev) => {
                        const next = new Set(prev);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  >
                    {gone ? "restore" : "retract"}
                  </button>
                </li>
              );
            })}
          </ul>

          <svg
            className="ppc-wires"
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            height={height}
            aria-hidden="true"
          >
            {claims.map((c, ci) =>
              c.citations.map((cit, i) => {
                const si = cited.indexOf(cit.sourceId);
                if (si < 0) return null;
                const y1 = sy(si) + sOffset;
                const y2 = cy(ci) + cOffset;
                const dead = retracted.has(cit.sourceId);
                return (
                  <path
                    key={`${c.id}-${i}`}
                    d={`M 0 ${y1} C 45 ${y1}, 55 ${y2}, 100 ${y2}`}
                    className={
                      dead
                        ? "ppc-wire is-dead"
                        : lit(cit.sourceId, c.id)
                          ? "ppc-wire"
                          : "ppc-wire is-dim"
                    }
                  />
                );
              }),
            )}
          </svg>

          <ul className="ppc-col ppc-claims" style={{ paddingTop: cOffset }}>
            {claims.map((c) => {
              const stands = standing(c);
              return (
                <li key={c.id} style={{ height: ROW_C }}>
                  <button
                    type="button"
                    className={`ppc-claim is-${c.status} ${stands ? "" : "is-fallen"}`}
                    aria-pressed={picked?.type === "claim" && picked.id === c.id}
                    onClick={() =>
                      setPicked(
                        picked?.type === "claim" && picked.id === c.id
                          ? null
                          : { type: "claim", id: c.id },
                      )
                    }
                  >
                    <span className={`ppc-bullet is-${c.status}`} />
                    <span className="ppc-claim-text">{c.statement}</span>
                    {c.citations.length === 1 && <span className="ppc-thin">1 source</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <section className="ppc-detail" aria-live="polite">
          <AnimatePresence mode="wait">
            {pickedClaim ? (
              <motion.div
                key={pickedClaim.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <h2>{pickedClaim.statement}</h2>
                <p className="ppc-detail-meta">
                  {STATUS_WORD[pickedClaim.status]} · {pickedClaim.nature} ·{" "}
                  {pickedClaim.effectiveFrom ?? "undated"}
                  {pickedClaim.effectiveTo ? ` to ${pickedClaim.effectiveTo}` : ""}
                </p>
                {pickedClaim.citations.map((cit, i) => {
                  const src = sourceOf(view.sources, cit.sourceId);
                  return (
                    <blockquote key={i} className={retracted.has(cit.sourceId) ? "is-gone" : ""}>
                      <p>&ldquo;{cit.quote}&rdquo;</p>
                      <footer>
                        {src?.title ?? cit.sourceId} · {src?.family ?? "unknown family"}
                      </footer>
                    </blockquote>
                  );
                })}
              </motion.div>
            ) : pickedSource ? (
              <motion.div
                key={pickedSource.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                <h2>{pickedSource.title}</h2>
                <dl className="ppc-srcmeta">
                  <dt>Class</dt>
                  <dd>{pickedSource.sourceClass}</dd>
                  <dt>Family</dt>
                  <dd>{pickedSource.family}</dd>
                  <dt>Access</dt>
                  <dd>{pickedSource.access}</dd>
                  <dt>Completeness</dt>
                  <dd>{pickedSource.completeness}</dd>
                  <dt>Visibility</dt>
                  <dd>{pickedSource.visibility}</dd>
                  <dt>Published</dt>
                  <dd>{pickedSource.publishedAt ?? "undated"}</dd>
                </dl>
                <p className="ppc-hint">
                  Supports{" "}
                  {
                    claims.filter((c) => c.citations.some((x) => x.sourceId === pickedSource.id))
                      .length
                  }{" "}
                  claims; {soleSupport(pickedSource.id)} of them rest on nothing else.
                </p>
              </motion.div>
            ) : (
              <motion.p
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="ppc-hint"
              >
                Nothing selected. The map shows every citation in the dossier as an arc.
              </motion.p>
            )}
          </AnimatePresence>
        </section>
        <StateLine variant="c" view={view} />
      </div>
    </MotionConfig>
  );
}

/* ================================ D — Prep Sheet ========================== */
/* Organising axis: THE MEETING. The dossier's gaps are not a defect to bury,
   they are the agenda — the questions only the person can answer. What is
   already established becomes the sidebar, so the half hour is not spent asking
   what the record answers. Primary affordance is taking the questions with you. */

const ASK: Record<string, string> = {
  overview: "Who are you now, and what should I have known before this call?",
  career: "How did you get from there to what you are doing now?",
  work: "What was yours in that, and what was the team's?",
  expertise: "Where have you actually shipped that, rather than listed it?",
  ideas: "What have you changed your mind about lately?",
  connections: "Who did you build that with, and who did you report to?",
  recognition: "Who outside the team checked that work?",
  context: "What are you free to take on, and what are you not?",
};

export function VariantD({ view, headingRef }: VariantProps) {
  const claims = activeClaims(view.dossier);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const established = claims.filter((c) => c.status === "supported");
  const contested = claims.filter((c) => c.status === "contested");
  const unknown = claims.filter((c) => c.status === "unknown" || c.status === "stale");

  const agenda = useMemo(() => {
    const items: { id: string; ask: string; why: string; tag: string }[] = [];
    for (const c of contested) {
      const [a, b] = c.citations;
      items.push({
        id: `c-${c.id}`,
        ask:
          a && b
            ? `Two records disagree about this. Which is current?`
            : (ASK[c.section] ?? "Can you clarify this?"),
        why: c.statement,
        tag: "contested",
      });
    }
    for (const c of unknown) {
      items.push({
        id: `u-${c.id}`,
        ask: ASK[c.section] ?? "Can you fill this in?",
        why: c.statement,
        tag: c.status,
      });
    }
    for (const g of gaps(view.dossier)) {
      items.push({
        id: `g-${g.key}`,
        ask: ASK[g.section] ?? "Can you fill this in?",
        why: g.text,
        tag: "gap",
      });
    }
    return items;
  }, [contested, unknown, view.dossier]);

  const brief = established.slice(0, 3);
  const thinnest = claims.filter((c) => singleFamily(c, view.sources)).length;

  const copy = () => {
    const text = [
      `${view.name} — questions the record cannot answer`,
      "",
      ...agenda.map((a, i) => `${i + 1}. ${a.ask}\n   (record says: ${a.why})`),
    ].join("\n");
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="pp-proto ppd">
        <DemoNotice view={view} />
        <header className="ppd-head">
          <p className="ppd-kicker">Before you meet</p>
          <h1 ref={headingRef} tabIndex={-1}>
            {view.name}
          </h1>
          <div className="ppd-brief">
            {brief.map((c) => (
              <p key={c.id}>{c.statement}</p>
            ))}
          </div>
          <p className="ppd-risk">
            <strong>Read this carefully:</strong>{" "}
            {contested.length > 0
              ? `${contested.length} fact${contested.length > 1 ? "s are" : " is"} contested between independent accounts, `
              : ""}
            {thinnest} of {claims.length} statements rest on a single source family. Treat the
            sidebar as a starting point, not as verified.
          </p>
        </header>

        <div className="ppd-body">
          <section className="ppd-agenda">
            <div className="ppd-agenda-head">
              <h2>
                {agenda.length} questions only they can answer
                <span className="ppd-progress">
                  {done.size}/{agenda.length} covered
                </span>
              </h2>
              <button type="button" className="ppd-copy" onClick={copy}>
                {copied ? "Copied" : "Copy the list"}
              </button>
            </div>
            <ol>
              {agenda.map((item, i) => {
                const isDone = done.has(item.id);
                return (
                  <motion.li key={item.id} layout className={isDone ? "is-done" : ""}>
                    <button
                      type="button"
                      className="ppd-check"
                      aria-pressed={isDone}
                      aria-label={isDone ? "Mark as still to ask" : "Mark as covered"}
                      onClick={() =>
                        setDone((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      {isDone ? "✓" : i + 1}
                    </button>
                    <div>
                      <p className="ppd-ask">{item.ask}</p>
                      <p className="ppd-why">
                        <span className={`ppd-tag is-${item.tag}`}>{item.tag}</span> {item.why}
                      </p>
                    </div>
                  </motion.li>
                );
              })}
            </ol>
          </section>

          <aside className="ppd-known">
            <h2>Don&rsquo;t ask — the record has this</h2>
            <ul>
              {established.map((c) => (
                <li key={c.id}>
                  {c.statement}
                  <span className="ppd-srccount">
                    {c.citations.length} source{c.citations.length > 1 ? "s" : ""}
                  </span>
                </li>
              ))}
            </ul>
            {contested.length > 0 && (
              <>
                <h2>Do not assume</h2>
                <ul className="ppd-contested">
                  {contested.map((c) => (
                    <li key={c.id}>{c.statement}</li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
        <StateLine variant="d" view={view} />
      </div>
    </MotionConfig>
  );
}
