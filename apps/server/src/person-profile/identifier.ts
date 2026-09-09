import type { PersonIdentitySignals } from "@chief-of-staff-demo/shared";
import { EMAIL_PATTERN } from "./profiles.js";
import { socialUrl } from "./sources.js";

/**
 * One typed identifier — an email address or a profile URL — turned into the
 * Identity Signals the resolver searches on, so a Profile can be started from
 * what the operator knows rather than only from a name a Module met.
 *
 * A LinkedIn address becomes a signal and a search term, never a fetch: the
 * public-web source reaches publicly indexed references only, and no imported
 * session or CAPTCHA bypass enters here.
 */
export class PersonIdentifierError extends Error {
  readonly code = "unrecognized-identifier";
}

export function parsePersonIdentifier(raw: string): PersonIdentitySignals {
  const value = raw.trim();
  if (!value)
    throw new PersonIdentifierError("Enter an email address or a profile URL to search for.");

  const signals: PersonIdentitySignals = {
    emails: [],
    fullNames: [],
    handles: {},
    profileUrls: [],
    employerHints: [],
  };

  if (EMAIL_PATTERN.test(value)) {
    signals.emails = [value.toLowerCase()];
    return signals;
  }

  /* A bare "linkedin.com/in/someone" is what people paste; the scheme is
     assumed rather than demanded, and anything that still will not parse as
     http(s) is refused by name. */
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new PersonIdentifierError(
      `Not an email address or a profile URL: ${value}. Enter something like "someone@example.com" or "linkedin.com/in/someone".`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new PersonIdentifierError(`Only http and https addresses can be searched: ${value}`);
  if (!url.hostname.includes("."))
    throw new PersonIdentifierError(
      `Not an email address or a profile URL: ${value}. Enter something like "someone@example.com" or "linkedin.com/in/someone".`,
    );

  signals.profileUrls = [url.toString()];
  const social = socialUrl(url.toString());
  if (social?.handle) signals.handles = { [social.platform]: [social.handle] };
  return signals;
}
