import { useEffect } from "react";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useMotionValue,
  useSpring,
  useTransform,
  type Variants,
} from "motion/react";
import { Link } from "react-router-dom";
import { formatTime, relativeTime } from "../display";

// PROTOTYPE — throwaway Home UI exploration (?variant=a|b|c). Delete with losers.
interface HomePrototypeData {
  sentence: string;
  identity: string | null;
  rows: { id: string; text: string; cta: string; to: string }[];
  feed: { id: string; title: string; outcome: string; at: string; to: string }[];
  areas: readonly { id: string; path: string; label: string; description: string }[];
  activeCount: number;
  runCount: number;
}

function StateLine({ variant, data }: { variant: string; data: HomePrototypeData }) {
  return (
    <p className="proto-state" aria-label="Prototype state">
      variant={variant} · runs={data.runCount} · active={data.activeCount} · attention=
      {data.rows.length} · feed={data.feed.length}
    </p>
  );
}

/* ---------------------------------- A ---------------------------------- */

/* Round-2 motion budget: entrance = 0.45s easeOut rise with 50ms stagger;
   interaction = 180ms hover lift, no bouncy springs (valhead 150–300ms rule). */
const containerA: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};
const itemA: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" } },
};
const hoverLift = { y: -2, transition: { duration: 0.18, ease: "easeOut" as const } };

/** Stable decorative series from a seed (LCG) — sparklines are look, not data. */
function seededSeries(seed: string, n: number): number[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out: number[] = [];
  let s = h >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(0.35 + (s / 0xffffffff) * 0.65);
  }
  return out;
}

/** Dependency-free inline SVG sparkline (opencode pattern): line + 14% area,
    currentColor, flat-line guard when min === max. Decorative only. */
function Sparkline({ values, height = 28 }: { values: number[]; height?: number }) {
  const v = values.slice(-14);
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pts = v.map((val, i) => ({
    x: 2 + (i / Math.max(1, v.length - 1)) * 96,
    y: min === max ? 14 : 24 - ((val - min) / (max - min)) * 20,
  }));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `M${pts[0]!.x.toFixed(1)} 26 ${pts
    .map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ")} L${pts[pts.length - 1]!.x.toFixed(1)} 26 Z`;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <path d={area} fill="currentColor" opacity="0.14" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** KPI number tween (context-awesome pick #3: "number-tween for KPI metrics"). */
function TweenedNumber({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 80, damping: 24 });
  const text = useTransform(spring, (v) => Math.round(v).toString());
  useEffect(() => {
    mv.set(value);
  }, [mv, value]);
  return <motion.span>{text}</motion.span>;
}

const RAIL_CODES: Record<string, string> = {
  "content-engine": "CE",
  "content-research": "CR",
  "person-profiles": "PP",
  "meeting-wizard": "MW",
};

/**
 * VariantA — "Airy Bento", refined per round-2 research: true 4-col bento with
 * a 2×2 hero, hairline shadow-borders instead of grey borders, single blue
 * accent, KPI strip with tweened numerals + sparklines, activity rows capped at
 * 5 with 6% dividers, product tiles with hover lift, `:has()` focus dimming on
 * the tile row.
 */
export function VariantA({ data }: { data: HomePrototypeData }) {
  const primary = data.rows[0];
  const heroCta = primary
    ? { to: primary.to, label: `${primary.cta}: ${primary.text}` }
    : data.areas[0]
      ? { to: data.areas[0].path, label: `Open ${data.areas[0].label}` }
      : null;
  return (
    <MotionConfig reducedMotion="user">
      <div className="home-proto proto-a">
        <div className="proto-a-topbar">
          <span className="proto-a-mark">Found42</span>
          <span className="proto-a-search" aria-hidden="true">
            Search or jump… <kbd>⌘K</kbd>
          </span>
          <span className="proto-a-avatar" aria-hidden="true" />
        </div>
        <div className="proto-a-body">
          <nav className="proto-a-rail" aria-label="Prototype products">
            {data.areas.map((a) => (
              <Link key={a.id} to={a.path} title={a.label} className="proto-a-rail-link">
                {RAIL_CODES[a.id] ?? a.label.slice(0, 2).toUpperCase()}
              </Link>
            ))}
            <Link to="/settings" title="Settings" className="proto-a-rail-link proto-a-rail-alt">
              SE
            </Link>
          </nav>
          <motion.div
            variants={containerA}
            initial="hidden"
            animate="show"
            className="proto-a-main"
          >
            <div className="proto-a-bento">
              {/* Hero: one 2×2 cell, one job, one CTA (craft sheet §3). */}
              <motion.section variants={itemA} className="proto-a-card proto-a-hero">
                <p className="proto-a-eyebrow">Where things stand</p>
                <p className="proto-a-sentence">{data.sentence}</p>
                {data.identity && <p className="proto-a-identity">{data.identity}</p>}
                {heroCta && (
                  <Link to={heroCta.to} className="proto-a-cta">
                    {heroCta.label} →
                  </Link>
                )}
              </motion.section>

              <motion.section
                variants={itemA}
                className="proto-a-card proto-a-kpi proto-a-kpi-live"
              >
                <p className="proto-a-cap">
                  <span className="proto-a-dot proto-a-dot-live" aria-hidden="true" /> active runs
                </p>
                <p className="proto-a-num">
                  <TweenedNumber value={data.activeCount} />
                </p>
                <div className="proto-a-spark proto-a-spark-blue">
                  <Sparkline values={seededSeries("active", 14)} />
                </div>
              </motion.section>
              <motion.section
                variants={itemA}
                className="proto-a-card proto-a-kpi proto-a-kpi-need"
              >
                <p className="proto-a-cap">
                  <span className="proto-a-dot proto-a-dot-warn" aria-hidden="true" /> need you
                </p>
                <p className="proto-a-num">
                  <TweenedNumber value={data.rows.length} />
                </p>
                <div className="proto-a-spark proto-a-spark-amber">
                  <Sparkline values={seededSeries("attention", 14)} />
                </div>
              </motion.section>

              {/* Pulse: wide decorative cell under the KPI pair. */}
              <motion.section variants={itemA} className="proto-a-card proto-a-pulse">
                <div className="proto-a-pulse-head">
                  <h2>Activity pulse</h2>
                  <span className="proto-a-hint">decorative preview</span>
                </div>
                <div className="proto-a-spark proto-a-spark-big proto-a-spark-blue">
                  <Sparkline values={seededSeries("pulse", 14)} height={56} />
                </div>
              </motion.section>

              {/* Attention: capped rows, 6% dividers, honest overflow line. */}
              <motion.section variants={itemA} className="proto-a-card proto-a-list">
                <h2>Needs your attention</h2>
                {data.rows.length > 0 ? (
                  <>
                    <ul>
                      {data.rows.slice(0, 4).map((r) => (
                        <li key={r.id}>
                          <span>{r.text}</span>
                          <Link to={r.to} className="proto-a-cta">
                            {r.cta} →
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {data.rows.length > 4 && (
                      <p className="proto-a-more">+{data.rows.length - 4} more waiting</p>
                    )}
                  </>
                ) : (
                  <div className="proto-a-empty">
                    <span className="proto-a-empty-chip" aria-hidden="true">
                      ✓
                    </span>
                    <p className="proto-a-empty-title">All clear</p>
                    <p>Pick a product below to get moving.</p>
                  </div>
                )}
              </motion.section>

              {/* Recent activity: 44–52px rows, max 5, no competing hero. */}
              <motion.section variants={itemA} className="proto-a-card proto-a-list">
                <h2>Recent activity</h2>
                {data.feed.length > 0 ? (
                  <ul>
                    {data.feed.map((e) => (
                      <motion.li
                        key={e.id}
                        className="proto-a-feed-row"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                      >
                        <Link to={e.to} className="proto-a-feed-title">
                          {e.title}
                        </Link>
                        <span className="proto-a-feed-meta">
                          {e.outcome} ·{" "}
                          <time dateTime={e.at} title={formatTime(e.at)}>
                            {relativeTime(e.at)}
                          </time>
                        </span>
                      </motion.li>
                    ))}
                  </ul>
                ) : (
                  <p className="proto-a-more">Nothing finished yet — quiet is fine.</p>
                )}
              </motion.section>

              {/* Products: clickable 1×1 tiles — hover lift on the clickable
                  cells only (craft sheet §4). */}
              {data.areas.map((a) => (
                <motion.div
                  variants={itemA}
                  key={a.id}
                  whileHover={hoverLift}
                  className="proto-a-prod"
                >
                  <Link to={a.path} className="proto-a-prod-link">
                    <span className="proto-a-prod-chip" aria-hidden="true">
                      {RAIL_CODES[a.id] ?? a.label.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="proto-a-prod-label">{a.label}</span>
                    <span className="proto-a-prod-desc">{a.description}</span>
                  </Link>
                </motion.div>
              ))}
            </div>
            <StateLine variant="a" data={data} />
          </motion.div>
        </div>
      </div>
    </MotionConfig>
  );
}

/* ---------------------------------- B ---------------------------------- */

/** VariantB — "Command Deck": dark-first, keyboard-first, dense table-first. */
export function VariantB({ data }: { data: HomePrototypeData }) {
  const [first, ...rest] = data.areas;
  return (
    <MotionConfig reducedMotion="user">
      <div className="home-proto proto-b">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 35, duration: 0.18 }}
          className="proto-b-palette"
        >
          <span className="proto-b-dot" aria-hidden="true" />
          <span>Ask / jump / run…</span>
          <kbd>⌘K</kbd>
        </motion.div>
        <div className="proto-b-body">
          <nav className="proto-b-side" aria-label="Prototype products">
            {data.areas.map((a) => (
              <Link key={a.id} to={a.path} className="proto-b-side-link">
                <span>{a.label}</span>
                <kbd>⌘{data.areas.indexOf(a) + 1}</kbd>
              </Link>
            ))}
            <Link to="/settings" className="proto-b-side-link proto-b-muted">
              <span>Settings</span>
              <kbd>⌘S</kbd>
            </Link>
          </nav>
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="proto-b-main"
          >
            <p className="proto-b-sentence">{data.sentence}</p>
            <motion.table
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="proto-b-table"
            >
              <thead>
                <tr>
                  <th>Attention</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length > 0 ? (
                  data.rows.map((r) => (
                    <motion.tr
                      key={r.id}
                      whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
                      transition={{ duration: 0.12 }}
                    >
                      <td>{r.text}</td>
                      <td>
                        <Link to={r.to} className="proto-b-cta">
                          {r.cta} ↵
                        </Link>
                      </td>
                    </motion.tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={2} className="proto-b-muted">
                      Queue empty — nothing needs you.
                    </td>
                  </tr>
                )}
              </tbody>
            </motion.table>
            <div className="proto-b-split">
              <div className="proto-b-detail">
                <AnimatePresence mode="wait" initial={false}>
                  {first && (
                    <motion.div
                      key={first.id}
                      initial={{ opacity: 0, x: 24 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.16 }}
                    >
                      <p className="proto-b-eyebrow">Selected</p>
                      <h2>
                        <Link to={first.path}>{first.label}</Link>
                      </h2>
                      <p className="proto-b-muted">{first.description}</p>
                      <ul className="proto-b-rest">
                        {rest.map((a) => (
                          <li key={a.id}>
                            <Link to={a.path}>{a.label}</Link>
                          </li>
                        ))}
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div className="proto-b-log" aria-label="Live activity">
                <p className="proto-b-eyebrow">Live activity</p>
                {data.feed.length > 0 ? (
                  data.feed.map((e) => (
                    <p key={e.id}>
                      <code>{relativeTime(e.at)}</code> <Link to={e.to}>{e.title}</Link>{" "}
                      <span className="proto-b-muted">{e.outcome}</span>
                    </p>
                  ))
                ) : (
                  <p className="proto-b-muted">No finished runs on the wire.</p>
                )}
              </div>
            </div>
            <StateLine variant="b" data={data} />
          </motion.main>
        </div>
      </div>
    </MotionConfig>
  );
}

/* ---------------------------------- C ---------------------------------- */

const containerC = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const lineC = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" as const } },
};

/** VariantC — "Editorial Warmth": warm paper, serif masthead, digest + ledger. */
export function VariantC({ data }: { data: HomePrototypeData }) {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        variants={containerC}
        initial="hidden"
        animate="show"
        className="home-proto proto-c"
      >
        <motion.header variants={lineC} className="proto-c-masthead">
          <p className="proto-c-wordmark">Found42 · Chief of Staff</p>
          <p className="proto-c-dateline">
            {today}
            {data.identity ? ` · ${data.identity}` : ""}
          </p>
        </motion.header>
        <motion.section variants={lineC} className="proto-c-hero">
          <h1>The brief</h1>
          <p className="proto-c-lede">
            {data.sentence}{" "}
            <span className="proto-c-figures">
              {data.activeCount} active · {data.rows.length} awaiting · {data.feed.length} recent
            </span>
          </p>
          {data.rows[0] ? (
            <Link to={data.rows[0].to} className="proto-c-cta">
              {data.rows[0].cta}: {data.rows[0].text} →
            </Link>
          ) : (
            firstAreaCta(data)
          )}
        </motion.section>
        <div className="proto-c-digest">
          <motion.section variants={lineC} className="proto-c-col">
            <h2>Decisions</h2>
            {data.rows.length > 0 ? (
              <ol>
                {data.rows.map((r, i) => (
                  <li key={r.id}>
                    <span className="proto-c-ordinal">{String(i + 1).padStart(2, "0")}</span>
                    <span>{r.text} </span>
                    <Link to={r.to}>{r.cta}</Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p>Nothing awaiting a decision. The desk is clear.</p>
            )}
          </motion.section>
          <motion.section variants={lineC} className="proto-c-col">
            <h2>Products</h2>
            <ol>
              {data.areas.map((a, i) => (
                <li key={a.id}>
                  <span className="proto-c-ordinal">{String(i + 1).padStart(2, "0")}</span>
                  <Link to={a.path}>{a.label}</Link>
                  <p>{a.description}</p>
                </li>
              ))}
            </ol>
          </motion.section>
          <motion.section variants={lineC} className="proto-c-col">
            <h2>Numbers</h2>
            {data.feed.length > 0 ? (
              <ol>
                {data.feed.map((e) => (
                  <li key={e.id}>
                    <Link to={e.to}>{e.title}</Link>
                    <p>
                      {e.outcome} ·{" "}
                      <time dateTime={e.at} title={formatTime(e.at)}>
                        {relativeTime(e.at)}
                      </time>
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No recent finishes to record.</p>
            )}
          </motion.section>
        </div>
        <StateLine variant="c" data={data} />
      </motion.div>
    </MotionConfig>
  );
}

function firstAreaCta(data: HomePrototypeData) {
  const first = data.areas[0];
  if (!first) return null;
  return (
    <Link to={first.path} className="proto-c-cta">
      Open {first.label} →
    </Link>
  );
}
