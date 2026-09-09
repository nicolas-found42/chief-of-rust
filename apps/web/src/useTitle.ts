import { useEffect } from "react";

/**
 * The Shell's name, so every route is titled after the application rather than
 * after one of the Modules it hosts. It was "Transcript → Tasks" — which is a
 * Module, and still the name of its tab in the header nav — so every page in
 * the app announced itself as that one workflow, Content Scout and Settings
 * included. Must stay identical to the <title> in index.html: that is what a
 * browser shows before React runs, and what the null branch below falls back to.
 */
const SUFFIX = "Chief of Staff";

/** Sets document.title for the current route (WCAG 2.4.2 Page Titled). */
export function useTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
}
