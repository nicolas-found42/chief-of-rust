import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_ELIGIBILITY,
  type SourceAccessCost,
  type SourceEligibility,
} from "../../../apps/server/src/source-adapters/eligibility";
import { defaultProviders } from "../../../apps/server/src/source-adapters/providers/index";
import {
  createPublicSearch,
  PublicSearchUnavailableError,
} from "../../../apps/server/src/source-adapters/search";
import {
  RECORD_ROUTE_INDEXES,
  WAYBACK_CAPTURE_ROUTE,
} from "../../../apps/server/src/person-profile/research-readers";

/**
 * The whole configured research source collection, checked against #228's one
 * hard rule for data acquisition: no API key, no payment, no source sign-in, no
 * imported browser session, no paid proxy. A free tier that requires a key is a
 * key. The application's configurable LLM inference providers are a different
 * seam and are deliberately not in scope here.
 *
 * This is a prefactor. Every source-family ticket in #228 adds routes, and the
 * assertion living here means each one inherits it rather than re-arguing the
 * question a route at a time.
 */

const byRoute = new Map<string, SourceEligibility>(
  SOURCE_ELIGIBILITY.map((entry) => [entry.route, entry]),
);

/** Whatever a route costs beyond an anonymous request disqualifies it. */
const KEYED_OR_PAID: SourceAccessCost[] = [
  "api-key",
  "payment",
  "sign-in",
  "imported-session",
  "paid-proxy",
];

/**
 * Headers that would turn an anonymous request into an identified one. The
 * shared transport already sends `credentials: "omit"`, so a cookie could only
 * arrive by being written here on purpose.
 */
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
];

/** A stub for the global `fetch`, so curated per-provider transports are visible. */
function captureRequests(answer: () => Response | Promise<Response>): {
  calls: { url: string; headers: Record<string, string>; credentials: string | undefined }[];
} {
  const calls: { url: string; headers: Record<string, string>; credentials: string | undefined }[] =
    [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[name.toLowerCase()] = value;
    calls.push({
      url: input.toString(),
      headers,
      credentials: init?.credentials,
    });
    return answer();
  });
  return { calls };
}

const emptyJson = () =>
  new Response("[]", { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the configured research source collection", () => {
  it("declares every route the production research path can reach", () => {
    /* A SearXNG URL is supplied so the optional provider registers too: a
       route that only appears under configuration still has to be declared. */
    const registered = defaultProviders({ searxngUrl: "https://searx.example.com" }).map(
      (provider) => provider.name,
    );
    const undeclared = registered.filter((name) => !byRoute.has(name));
    expect(undeclared).toEqual([]);

    /* Reading a record is data acquisition too. Every index a page can be
       escalated to is claimed by a declared route. */
    const claimed = new Set(SOURCE_ELIGIBILITY.flatMap((entry) => entry.indexes ?? []));
    expect(RECORD_ROUTE_INDEXES.filter((index) => !claimed.has(index))).toEqual([]);

    /* So is retrieving an archived capture's content: a second endpoint and a
       second acquisition beyond the availability API the `wayback` entry
       covers, so the reader's own route name has to be declared with terms and
       an anonymous probe of its own (#253). */
    const capture = byRoute.get(WAYBACK_CAPTURE_ROUTE);
    expect([capture?.cost, capture?.status, !!capture?.probe, !!capture?.terms]).toEqual([
      "anonymous",
      "in-production",
      true,
      true,
    ]);
  });

  it("requires no key, payment, sign-in, imported session or paid proxy", () => {
    const costly = SOURCE_ELIGIBILITY.filter(
      (entry) => entry.status === "in-production" && entry.cost !== "anonymous",
    ).map((entry) => `${entry.route}: ${entry.cost}`);
    expect(costly).toEqual([]);
  });

  it("keeps no keyed or paid route reachable from the production bundle", () => {
    const registered = new Set(
      defaultProviders({ searxngUrl: "https://searx.example.com" }).map(
        (provider) => provider.name,
      ),
    );
    const reachable = SOURCE_ELIGIBILITY.filter(
      (entry) => KEYED_OR_PAID.includes(entry.cost) && registered.has(entry.route),
    ).map((entry) => entry.route);
    expect(reachable).toEqual([]);
  });

  it("sends no credential on any request the production search path makes", async () => {
    const { calls } = captureRequests(emptyJson);
    /* No injected fetch: the curated transports engage, so this sees the SEC's
       declared-contact agent and Marginalia's shared header as production
       sends them, not as a hermetic double would hide them. */
    const search = createPublicSearch(undefined, undefined, {
      searxngUrl: "https://searx.example.com",
    });
    await search("Ada Lovelace").catch(() => undefined);

    expect(calls.length).toBeGreaterThan(20);
    const identified = calls.filter((call) =>
      CREDENTIAL_HEADERS.some((header) => header in call.headers),
    );
    expect(identified.map((call) => call.url)).toEqual([]);
    /* Cookies cannot ride along either, whoever built the transport. */
    expect([...new Set(calls.map((call) => call.credentials))]).toEqual(["omit"]);

    /* Marginalia's documented anonymous path is a published constant, not a
       key issued to this operator. If that literal ever changes into something
       obtained, this is where it stops being anonymous. */
    const keyed = calls.filter((call) => "api-key" in call.headers);
    expect([...new Set(keyed.map((call) => call.headers["api-key"]))]).toEqual(["public"]);
  });

  it("reaches no undeclared host, and no new host after every anonymous route fails", async () => {
    const declaredHosts = (calls: { url: string }[]) =>
      [...new Set(calls.map((call) => new URL(call.url).hostname.replace(/^www\./, "")))].sort();

    const healthy = captureRequests(emptyJson);
    await createPublicSearch(undefined, undefined, { searxngUrl: "https://searx.example.com" })(
      "Ada Lovelace",
    ).catch(() => undefined);
    const reachedWhenHealthy = declaredHosts(healthy.calls);
    vi.unstubAllGlobals();

    /* Now refuse every anonymous route the way a wall would. Nothing may
       escalate: no keyed endpoint, no paid proxy, no second host at all. */
    const walled = captureRequests(
      () => new Response("no", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    await expect(
      createPublicSearch(undefined, undefined, { searxngUrl: "https://searx.example.com" })(
        "Ada Lovelace",
      ),
    ).rejects.toBeInstanceOf(PublicSearchUnavailableError);
    expect(
      declaredHosts(walled.calls).filter((host) => !reachedWhenHealthy.includes(host)),
    ).toEqual([]);
  });

  it("keeps an excluded or unavailable route visible with its reason", () => {
    const withoutReason = SOURCE_ELIGIBILITY.filter(
      (entry) => entry.status !== "in-production" && !entry.exclusion,
    ).map((entry) => entry.route);
    expect(withoutReason).toEqual([]);
    /* The record still names them: deleting a route we cannot read would turn
       "we cannot read this" into "there was nothing to read". */
    expect(
      SOURCE_ELIGIBILITY.filter((entry) => entry.status !== "in-production").length,
    ).toBeGreaterThan(0);
    /* The known gaps are pinned by name, not just counted: deleting one of
       them would still leave a non-zero count while turning "we cannot read
       this" into "there was nothing to read" (fault-proved for #230).
       Additions stay free; only silent removal fails. */
    expect(byRoute.get("podcastindex")?.status).toBe("excluded");
    expect(byRoute.get("linkedin")?.status).toBe("excluded");
    expect(byRoute.get("youtube-captions")?.status).toBe("unavailable");
    /* The known gaps pin their full reason, not just their status: silently
       rewriting a reason would pass a non-empty check while changing what
       "we cannot read this" means. Additions stay free; only silent removal
       or rewriting fails. */
    const gapReasonByRoute: Record<string, string | undefined> = Object.fromEntries(
      SOURCE_ELIGIBILITY.filter((entry) => entry.status !== "in-production").map((entry) => [
        entry.route,
        entry.exclusion,
      ]),
    );
    expect({
      podcastindex: gapReasonByRoute["podcastindex"],
      linkedin: gapReasonByRoute["linkedin"],
      "youtube-captions": gapReasonByRoute["youtube-captions"],
    }).toEqual({
      podcastindex: "A key is required, which #228 excludes even where the tier is free.",
      linkedin:
        "No keyless anonymous read exists. Research records a login-required failure for a LinkedIn URL rather than importing a session or using a paid proxy.",
      "youtube-captions":
        "Observed 2026-09-06: every listed track returned HTTP 200 with a zero-byte body in every format (srv1, srv3, json3, vtt, ttml). Research falls back to the publisher's video description and records the gap. Local transcription would be the next route and is not installed on this host.",
    });
  });

  it("does not let a catalogue label alone mark a route eligible", () => {
    const onDocumentationAlone = SOURCE_ELIGIBILITY.filter(
      (entry) => entry.status === "in-production" && !entry.probe && !entry.observed,
    ).map((entry) => entry.route);
    expect(onDocumentationAlone).toEqual([]);
    /* The documented terms and what a request was seen to do are separate
       fields, and one may never be filled in with the other. */
    expect(
      SOURCE_ELIGIBILITY.filter((entry) => entry.observed === entry.terms).map(
        (entry) => entry.route,
      ),
    ).toEqual([]);
  });
});
