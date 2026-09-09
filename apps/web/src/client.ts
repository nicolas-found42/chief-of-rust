/**
 * Transport only: the one fetch adapter and the error vocabulary every client
 * shares. The endpoint vocabulary lives in the per-product-area clients under
 * clients/ — Meeting Wizard (clients/meetings), Content (clients/content),
 * Person Profiles (clients/people) — and the Shell's own namespaces in
 * clients/workspace. No product-specific endpoint belongs in this file.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /* Some failures are disclosures, not just a message: a refused Profile
       lifecycle operation answers with the configurations and residual source
       documents the operator has to act on. Keep the parsed body so the
       surface can render it instead of only its first sentence. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let parsed: unknown;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      parsed = body;
      if (body.message) {
        message = body.message;
      } else if (body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message, parsed);
  }
  return (await response.json()) as T;
}

export async function requestText(path: string, init?: RequestInit): Promise<string> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body; keep the status text.
    }
    throw new ApiError(response.status, message);
  }
  return await response.text();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
