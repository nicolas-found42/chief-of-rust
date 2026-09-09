import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * The router key of the history entry this document was loaded on, captured on
 * the app's first render.
 *
 * react-router labels an entry it never navigated to `"default"`, and comparing
 * against that string looks like it identifies the loaded entry — but it only
 * identifies a *never-navigated* one. A client-side navigation writes its own
 * key into `history.state`, and `history.state` survives a reload: refresh a run
 * you reached by clicking and the router hands back the key that pushState gave
 * it, not `"default"`. Refresh is one of the three ways users arrive at a run
 * URL, so the string comparison would have left the bug in place for it.
 */
let loadedEntry: string | null = null;

/**
 * True while the app is showing the history entry the browser itself loaded.
 *
 * `App` calls this so the capture happens on the first render whatever route
 * matched, rather than depending on every page remembering to ask.
 */
export function useIsLoadedEntry(): boolean {
  const { key } = useLocation();
  loadedEntry ??= key;
  return key === loadedEntry;
}

/**
 * Moves focus to the page heading when the app navigates to a route, so
 * keyboard and screen reader users continue from the new page instead of being
 * left on the link they just activated with nothing announced (WCAG 2.4.3).
 *
 * Attach the returned ref to an `<h1 tabIndex={-1}>`.
 *
 * The entry the browser loaded is left alone: focus already sits at the top of
 * the document there, ahead of the skip link, and moving it would put that link
 * permanently out of reach. RunDetailPage keeps its own copy of this pattern —
 * its heading has to wait for the run to load and must not be re-focused by the
 * 3s poll — and shares useIsLoadedEntry so the two cannot drift apart.
 */
export function usePageFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const { key } = useLocation();
  const loaded = useIsLoadedEntry();
  useEffect(() => {
    if (!loaded) {
      ref.current?.focus();
    }
    // `key` stays in the deps: moving between two navigated entries leaves
    // `loaded` false throughout, and each arrival still needs its heading.
  }, [key, loaded]);
  return ref;
}
