import type { GoogleStatus } from "@chief-of-staff-demo/shared";

/**
 * What the Shell has to say about the Google connection, in Shell vocabulary.
 *
 * One function, not a boolean beside the banner: the banner renders this value
 * and Home's sentence tests it for emptiness (ADR-0010, ADR-0011). A separate
 * predicate would be a second thing that can disagree with what is on screen.
 *
 * The wording names Tasks and Gmail but never a Module's pipeline. The string
 * this replaced — "runs will extract tasks but have nowhere to put them" —
 * described Transcript's stages, which is the Module leaking into a Shell
 * concern; Tasks and Gmail are Google surfaces, and the connection is the
 * Shell's only route to them.
 */
export interface ConnectionNotice {
  text: string;
  /** Label for the link to Settings, which is where every one of these is fixed. */
  action: string;
}

/** Whole days: the expiry is an estimate, and worth no more precision than that. */
function daysAgo(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** Date without a time, for the same reason. */
const DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/**
 * One fact, and a prediction only when there is one to make. `expiresAbout` is
 * null until Google has actually refused this grant once, because an Internal
 * consent screen never expires and guessing otherwise would announce a weekly
 * event that never happens. So the fact stands alone until the app has evidence.
 *
 * One expiry vocabulary for the whole app: the Settings card and the Shell
 * banner both call this. They used to be two functions predicting the same
 * event in different words — a `RunsPage` local that said "within a day" and
 * this one, which names the day.
 */
export function expiryNote(status: GoogleStatus): string | null {
  if (!status.lastConnectedAt) {
    return null;
  }
  const days = daysAgo(status.lastConnectedAt);
  const signedIn =
    days <= 0
      ? "You signed in today"
      : days === 1
        ? "You signed in yesterday"
        : `You signed in ${days} days ago`;
  if (!status.expiresAbout) {
    return `${signedIn}.`;
  }
  const due = new Date(status.expiresAbout);
  if (due.getTime() <= Date.now()) {
    return `${signedIn}, so Google may ask you to sign in again at any time.`;
  }
  return `${signedIn}, so Google will probably ask again around ${DAY.format(due)}.`;
}

/**
 * Inside a day of the estimate, and silent before that. Someone who only ever
 * operates the app would otherwise meet the weekly expiry as a failed Run
 * rather than as a warning.
 */
function expiryNear(status: GoogleStatus): boolean {
  return (
    status.expiresAbout !== null &&
    new Date(status.expiresAbout).getTime() - Date.now() < 86_400_000
  );
}

/**
 * The notice for a connection state, or null when there is nothing to say.
 *
 * Null for a `null` status as well: nothing renders before the first status
 * arrives, because a banner that flashes "not signed in" and then vanishes is
 * worse than silence.
 */
export function connectionNotice(status: GoogleStatus | null): ConnectionNotice | null {
  if (!status) {
    return null;
  }
  switch (status.state) {
    case "unconfigured":
      return {
        text: "Google is not set up, so nothing can be created in Tasks or Gmail.",
        action: "Set up Google",
      };
    case "disconnected":
      return {
        text: "Google is not signed in, so nothing can be created in Tasks or Gmail.",
        action: "Sign in with Google",
      };
    case "expired":
      return {
        text: "The saved Google sign-in has expired as expected. Reconnect to keep creating in Tasks or Gmail.",
        action: "Reconnect Google",
      };
    case "connected": {
      /* A working connection about to lapse still has something to say, and it
         says it in the same words the Settings card uses. The note is what
         carries the date, so a near expiry with nothing to report — no recorded
         sign-in — stays silent rather than warning without a reason. */
      const note = expiryNear(status) ? expiryNote(status) : null;
      return note ? { text: note, action: "Sign in with Google" } : null;
    }
  }
}
