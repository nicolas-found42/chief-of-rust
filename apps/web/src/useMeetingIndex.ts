import { useCallback, useEffect, useState } from "react";
import type { MeetingBriefIndex } from "@chief-of-staff-demo/shared";
import { errorMessage } from "./client";
import { meetingsApi } from "./clients/meetings";

/**
 * The read projection both Meeting Wizard surfaces render: one refresh /
 * Prepare-now / poll loop over the Cross-Run index (ADR-0005). The polling
 * predicate is the two pages' shared contract — any pending delivery or any
 * upcoming preparation keeps the projection live.
 *
 * Pass a stable fetcher (module-level or useCallback) so the initial refresh
 * effect does not re-run every render.
 */
export function useMeetingIndex(
  fetch: () => Promise<MeetingBriefIndex>,
  prepare: (occurrenceKey: string) => Promise<unknown> = meetingsApi.prepareMeetingBriefNow,
) {
  const [index, setIndex] = useState<MeetingBriefIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setIndex(await fetch());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [fetch]);

  /** The Module's manual Run: prepare an occurrence now, then re-project. */
  const prepareNow = useCallback(
    async (occurrenceKey: string) => {
      setBusy(true);
      setError(null);
      try {
        await prepare(occurrenceKey);
        setIndex(await fetch());
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [fetch, prepare],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!index) return;
    const hasPending = index.briefs.some((b) => b.delivery?.status === "pending");
    if (!hasPending && index.upcoming.length === 0) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [index, refresh]);

  return { index, error, busy, refresh, prepareNow };
}
