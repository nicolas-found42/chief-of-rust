import { Link, useLocation } from "react-router-dom";
import { connectionNotice } from "../connectionNotice";
import { useGoogleConnection } from "../useGoogleConnection";

/**
 * The Google connection's standing warning, on every page (ADR-0011).
 *
 * It used to live in `RunsPage`, which owned `/` — so it reached the one Module
 * that happened to be built first and nowhere else. The Shell renders it now,
 * once, because the connection is a Shell concern.
 *
 * The `role="status"` region is **always rendered and empty when there is
 * nothing to say**. That is load-bearing: a live region only announces what
 * arrives after it is mounted, so a conditionally-mounted one would re-announce
 * on every navigation and rebuild the repetition that hoisting this fixed.
 * `role="status"` rather than `"alert"`, because a standing condition the user
 * may have chosen is not an event.
 */
export function ConnectionBanner() {
  const { status } = useGoogleConnection();
  const { pathname } = useLocation();

  /* Suppressed on Settings, the one route where it has nothing to add and a
     duplicate warning to subtract: it would sit directly above a card that says
     the same thing in detail. The region itself stays mounted, or leaving
     Settings would announce the banner as if it were news. */
  const notice = pathname === "/settings" ? null : connectionNotice(status);

  return (
    <div role="status">
      {notice && (
        <div className="banner banner-warn">
          <span>{notice.text}</span>
          <Link className="step-link" to="/settings">
            {notice.action}
          </Link>
        </div>
      )}
    </div>
  );
}
