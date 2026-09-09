/**
 * PROTOTYPE — throwaway variant switcher, not production UI.
 * Shared by every `?variant=` exploration, so each host page passes its own
 * variant list rather than forking the bar:
 *   Home       `/`         current | a | b | c   (Airy Bento / Command Deck / Editorial Warmth)
 *   Meetings   `/meetings` current | a | b | c   (Quiet Rail / Day Spine / Editorial Ledger)
 *   Profile    `/people/:id` current | a | b | c | d
 *              (Critical Edition / Spine / Provenance / Prep Sheet)
 * Delete with the losing variants when one wins; never ship to prod
 * (returns null under Vite production builds).
 */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export interface PrototypeVariant {
  key: string;
  name: string;
}

/** Home's set, kept as the default so its call sites stay unchanged. */
const HOME_VARIANTS: PrototypeVariant[] = [
  { key: "current", name: "Current" },
  { key: "a", name: "Airy Bento" },
  { key: "b", name: "Command Deck" },
  { key: "c", name: "Editorial Warmth" },
];

export function PrototypeSwitcher({
  current,
  variants = HOME_VARIANTS,
}: {
  current: string;
  variants?: PrototypeVariant[];
}) {
  // Hidden in production builds so a stray merge can't ship the bar.
  if (import.meta.env.PROD) return null;
  return <PrototypeSwitcherInner current={current} variants={variants} />;
}

function PrototypeSwitcherInner({
  current,
  variants,
}: {
  current: string;
  variants: PrototypeVariant[];
}) {
  const [, setSearchParams] = useSearchParams();
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const go = (dir: 1 | -1) => {
    const next = variants[(index + dir + variants.length) % variants.length]!;
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("variant", next.key);
        return p;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [index]);

  const label = variants[index]!;
  return (
    <div
      className="prototype-switcher"
      role="toolbar"
      aria-label="Prototype variant switcher (throwaway)"
    >
      <button type="button" onClick={() => go(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="prototype-switcher-label">
        {label.key} ({label.name})
      </span>
      <button type="button" onClick={() => go(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
