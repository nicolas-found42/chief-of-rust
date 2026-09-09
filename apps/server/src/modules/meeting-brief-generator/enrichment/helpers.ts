/* oxlint-disable no-control-regex, typescript/no-unnecessary-condition -- helpers handle nullable provider errors and sanitization */
/**
 * Shared enrichment helpers — deduplicated from enrich.ts and publicIntelligence.ts
 * (sanitizeEvidence, readErrorStatus, readErrorCode, isProviderWideError, deduplicateEvidence)
 */

export function sanitizeEvidence(text: string): string {
  return text
    .slice(0, 500)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim();
}

/**
 * Artifact filenames interpolate the Calendar event version, but Google returns
 * `etag` as a quoted string (`"3576241611505950"`). Run artifact names are
 * restricted to /^[A-Za-z0-9][A-Za-z0-9._-]*$/, so the version is folded the
 * same way guest addresses and domains already are.
 */
export function sanitizeArtifactVersion(eventVersion: string): string {
  return eventVersion.replace(/[^A-Za-z0-9]/g, "_");
}

export function readErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const v = (error as Record<string, unknown>).status;
    if (typeof v === "number") return v;
  }
  if (error && typeof error === "object" && "code" in error) {
    const v = (error as Record<string, unknown>).code;
    if (typeof v === "number") return v;
  }
  if (error && typeof error === "object" && "httpStatus" in error) {
    const v = (error as Record<string, unknown>).httpStatus;
    if (typeof v === "number") return v;
  }
  if (error && typeof error === "object" && "diagnostics" in error) {
    const diag = (error as Record<string, unknown>).diagnostics;
    if (diag && typeof diag === "object" && "statusCode" in (diag as Record<string, unknown>)) {
      const v = (diag as Record<string, unknown>).statusCode;
      if (typeof v === "number") return v;
    }
  }
  if (error && typeof error === "object" && "response" in error) {
    const resp = (error as { response?: { status?: number } }).response;
    if (resp && typeof resp.status === "number") return resp.status;
  }
  return null;
}

export function readErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "category" in error) {
    const v = (error as Record<string, unknown>).category;
    if (typeof v === "string") return v;
  }
  if (error && typeof error === "object" && "code" in error) {
    const v = (error as Record<string, unknown>).code;
    if (typeof v === "string") return v;
  }
  if (error && typeof error === "object" && "reason" in error) {
    const v = (error as Record<string, unknown>).reason;
    if (typeof v === "string") return v;
  }
  if (error && typeof error === "object" && "errorCode" in error) {
    const v = (error as Record<string, unknown>).errorCode;
    if (typeof v === "string") return v;
  }
  const nested = (
    error as { response?: { data?: { error?: { errors?: Array<{ reason?: string }> } } } }
  )?.response?.data?.error?.errors?.[0]?.reason;
  if (typeof nested === "string") return nested;
  return null;
}

export function isProviderWideError(error: unknown): boolean {
  const maybe = error as { status?: number; code?: number; response?: { status?: number } };
  const status = maybe?.status ?? maybe?.code ?? maybe?.response?.status ?? readErrorStatus(error);
  const msg = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || status === 503) return true;
  // Providers declare outages with the `unavailable:` category (ADR-0030 classified facts), so a
  // 502/504 from the legacy profile provider or public search classifies provider-wide by message; other 4xx
  // statuses (404 empty, 429 rate-limited) stay per-source explicit gaps after retry (US69).
  if (
    /invalid_grant|insufficient authentication|ACCESS_TOKEN|accessNotConfigured|has not been used|is disabled|not configured|missing_configuration|rejected|unavailable|missing_authority/i.test(
      msg,
    )
  )
    return true;
  const code = readErrorCode(error);
  if (code && /rejected|missing_authority|unavailable|missing_configuration/i.test(code))
    return true;
  return false;
}

/** Per-source bounded retry policy (issue #80 US67/US68): two attempts; provider-wide failures abort immediately. */
export const PROVIDER_RETRY_ATTEMPTS = 2;

export async function withBoundedRetry<T>(options: {
  attempt: (attemptNumber: number, finalAttempt: boolean) => Promise<T>;
  onRetry?: (error: unknown, attempt: number) => void;
  /** Runs before a provider-wide error rethrows, so callers can persist resumable state. */
  onProviderWide?: (error: unknown) => void;
}): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  for (let attempt = 1; ; attempt += 1) {
    const finalAttempt = attempt === PROVIDER_RETRY_ATTEMPTS;
    try {
      return { ok: true, value: await options.attempt(attempt, finalAttempt) };
    } catch (error) {
      if (isProviderWideError(error)) {
        options.onProviderWide?.(error);
        throw error;
      }
      if (finalAttempt) return { ok: false, error };
      options.onRetry?.(error, attempt);
    }
  }
}

export function deduplicateEvidence(evidence: string[]): string[] {
  const seen = new Map<string, string>();
  for (const e of evidence) {
    const key = e.toLowerCase().trim().replace(/\s+/g, " ");
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}
