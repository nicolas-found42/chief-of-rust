import { describe, expect, it } from "vitest";
import type { GoogleConnectionState, GoogleStatus } from "@chief-of-staff-demo/shared";
import { connectionNotice } from "../../../apps/web/src/connectionNotice";

/**
 * The one value the Shell banner renders and Home's sentence tests for
 * emptiness. Unit-tested because the connected states cannot be reached end to
 * end: the e2e workspace has no way to obtain a real Google sign-in.
 */
function status(state: GoogleConnectionState, over: Partial<GoogleStatus> = {}): GoogleStatus {
  return {
    state,
    email: state === "connected" ? "nicolas@found42.com" : null,
    redirectUri: "http://localhost:4317/api/google/callback",
    scopes: [],
    lastConnectedAt: null,
    expiresAbout: null,
    ...over,
  };
}

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe("the Shell's connection notice", () => {
  it("says nothing before the first status arrives", () => {
    // A banner that flashes "not signed in" and then vanishes is worse than
    // silence.
    expect(connectionNotice(null)).toBeNull();
  });

  it("names Tasks and Gmail, and never a Module's pipeline", () => {
    expect(connectionNotice(status("unconfigured"))).toEqual({
      text: "Google is not set up, so nothing can be created in Tasks or Gmail.",
      action: "Set up Google",
    });
    expect(connectionNotice(status("disconnected"))).toEqual({
      text: "Google is not signed in, so nothing can be created in Tasks or Gmail.",
      action: "Sign in with Google",
    });
    expect(connectionNotice(status("expired"))).toEqual({
      text: "The saved Google sign-in has expired as expected. Reconnect to keep creating in Tasks or Gmail.",
      action: "Reconnect Google",
    });
  });

  it("is silent on a working connection with no expiry in sight", () => {
    // `expiresAbout` stays null until Google has actually refused this grant
    // once, so a healthy Internal consent screen never warns.
    expect(connectionNotice(status("connected", { lastConnectedAt: inHours(-48) }))).toBeNull();
    expect(
      connectionNotice(
        status("connected", { lastConnectedAt: inHours(-48), expiresAbout: inHours(72) }),
      ),
    ).toBeNull();
  });

  it("speaks inside a day of the estimate, in the Settings card's own words", () => {
    const notice = connectionNotice(
      status("connected", { lastConnectedAt: inHours(-6), expiresAbout: inHours(12) }),
    );
    expect(notice?.action).toBe("Sign in with Google");
    expect(notice?.text).toMatch(/^You signed in today, so Google will probably ask again around /);
  });

  it("stays silent when there is a near expiry but nothing to report", () => {
    // No recorded sign-in means no note, and a warning with no fact behind it is
    // worse than none.
    expect(connectionNotice(status("connected", { expiresAbout: inHours(1) }))).toBeNull();
  });
});
