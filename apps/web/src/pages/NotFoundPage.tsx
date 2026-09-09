import { Link } from "react-router-dom";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Catch-all for unmatched paths. The server serves index.html for every route,
 * so a mistyped URL or a stale bookmark lands here rather than 404ing — without
 * this, <main> renders empty under the previous route's document title, which
 * is what a screen reader announces on arrival (WCAG 2.4.2).
 */
export function NotFoundPage() {
  useTitle("Page not found");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Page not found
      </h1>
      <p className="muted">
        That address doesn&rsquo;t match a run or a settings page. It may be a mistyped link, or a
        run that has since been removed.
      </p>
      <p>
        {/* Home, not the runs list: the address matched nothing, so the app
            cannot know which Module the visitor wanted. The arrow is
            decorative — exposed, it is read as "left arrow" ahead of the link
            text (WCAG 1.3.1). */}
        <Link to="/" className="back-link">
          <span aria-hidden="true">&larr;</span> Home
        </Link>
      </p>
    </div>
  );
}
