import { createContext, useContext } from "react";
import type { GoogleStatus } from "@chief-of-staff-demo/shared";

/**
 * The Google connection, held once for the whole Shell.
 *
 * Three consumers need the same value — the Shell banner, Home's identity line,
 * and the Settings card, which *mutates* it. Independent copies are the "two
 * vocabularies" failure ADR-0008 exists to have fixed, so Settings refreshes
 * through here rather than keeping a status of its own.
 *
 * Read ADR-0011 before changing when this refreshes: polling
 * `/api/google/status` looks like the scheduled proving ADR-0008 forbids and is
 * not, because that endpoint never calls Google.
 */
interface GoogleConnectionValue {
  /** null until the first request answers — nothing renders before then. */
  status: GoogleStatus | null;
  refresh: () => Promise<void>;
}

export const GoogleConnectionContext = createContext<GoogleConnectionValue | null>(null);

export function useGoogleConnection(): GoogleConnectionValue {
  const value = useContext(GoogleConnectionContext);
  if (!value) {
    throw new Error("useGoogleConnection must be used inside GoogleConnectionProvider");
  }
  return value;
}
