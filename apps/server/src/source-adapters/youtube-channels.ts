/**
 * Turning a pasted URL into something Google can answer for.
 *
 * Three of YouTube's four channel URL forms carry an identifier the Data API
 * accepts. The fourth — `/c/Name` — does not: Google documents no route from a
 * custom URL to a channel id, and the only fallback is the search endpoint,
 * whose separate hundred-calls-a-day bucket would make this Module fragile in a
 * way that stays invisible until it is tracking the wrong channel. So it is
 * refused, out loud, naming the forms that work.
 */
export type ChannelRef =
  | { kind: "handle"; value: string }
  | { kind: "id"; value: string }
  | { kind: "username"; value: string };

export class ChannelUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelUrlError";
  }
}

const FORMS =
  "Paste the channel's handle URL (youtube.com/@name) or its id URL (youtube.com/channel/UC…).";

function pathSegments(input: string): string[] {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ChannelUrlError(`That is not a URL. ${FORMS}`);
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname) && !/(^|\.)youtu\.be$/i.test(url.hostname)) {
    throw new ChannelUrlError(`That is not a YouTube URL. ${FORMS}`);
  }
  return url.pathname.split("/").filter((part) => part !== "");
}

/** What to ask Google about, or a refusal a person can act on. */
export function parseChannelUrl(input: string): ChannelRef {
  const segments = pathSegments(input);
  const first = segments[0];
  if (first === undefined) {
    throw new ChannelUrlError(`That URL names no channel. ${FORMS}`);
  }
  if (first.startsWith("@") && first.length > 1) {
    return { kind: "handle", value: first };
  }
  if (first === "channel") {
    const id = segments[1];
    if (id === undefined) {
      throw new ChannelUrlError(`That URL names no channel. ${FORMS}`);
    }
    return { kind: "id", value: id };
  }
  if (first === "user") {
    const name = segments[1];
    if (name === undefined) {
      throw new ChannelUrlError(`That URL names no channel. ${FORMS}`);
    }
    return { kind: "username", value: name };
  }
  if (first === "c") {
    throw new ChannelUrlError(
      `A youtube.com/c/… URL cannot be looked up: Google publishes no way to turn a custom URL into a channel id. Open the channel on YouTube and copy the address bar there instead — it will be a handle or an id. ${FORMS}`,
    );
  }
  throw new ChannelUrlError(`That is not a channel URL. ${FORMS}`);
}
