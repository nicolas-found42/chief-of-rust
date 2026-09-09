import { JSDOM } from "jsdom";
import { retryAfterMilliseconds } from "../http.js";
import type { PublicSearchResult } from "../search.js";
import { ProviderRefusedError, type SearchProvider, type SearchProviderIo } from "./types.js";

const MAX_RESULTS = 8;

/**
 * Mojeek (ADR-0049, layer 2) — an independent UK index answered by a plain
 * keyless GET (per the ddgs `mojeek.py` engine; no tokens). Mojeek's
 * anti-bot gate is intermittent and volume-based, not UA-fingerprinted —
 * live 2026-09-02: the same UA was challenged under probe bursts and passed
 * when quiet, whatever the header set (see
 * docs/research/anti-bot-keyless-search.md) — so the descriptive default UA
 * rides the composite's transport and a challenge page classifies as a
 * captcha cooldown; no retries. One caveat the research doc live-verified:
 * Mojeek's index has a coverage gap for `site:linkedin.com/in` queries —
 * route LinkedIn-scoped questions elsewhere.
 */
export function createMojeekProvider(): SearchProvider {
  return {
    name: "mojeek",
    async search(query: string, io: SearchProviderIo): Promise<PublicSearchResult[]> {
      const response = await io.fetch(
        `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
        {
          timeoutMs: io.timeoutMs,
        },
      );
      if (response.status !== 200) {
        if (response.status === 429 || response.status === 503) {
          throw new ProviderRefusedError(
            "rate-limited",
            `Mojeek is rate-limited: the search page answered ${String(response.status)}.`,
            retryAfterMilliseconds(response.retryAfter, new Date()),
          );
        }
        throw new ProviderRefusedError(
          "error",
          `Mojeek search failed: the search page answered ${String(response.status)}.`,
        );
      }
      if (/captcha|are you a robot|verify you are human/i.test(response.body)) {
        throw new ProviderRefusedError(
          "captcha",
          "Mojeek search failed: the search page answered with an anti-bot challenge.",
        );
      }
      const document = new JSDOM(response.body, { url: response.url }).window.document;
      const list = document.querySelector("ul.results");
      // Without the results list this is not the search page we know — a
      // layout change or an interstitial — and answering [] would misreport
      // a failure as evidence that nothing exists.
      if (!list) {
        throw new ProviderRefusedError(
          "error",
          "Mojeek search failed: the page had no results list to parse.",
        );
      }
      const results: PublicSearchResult[] = [];
      for (const row of [...list.querySelectorAll("li")].slice(0, MAX_RESULTS)) {
        const anchor = row.querySelector<HTMLAnchorElement>("h2 a[href]");
        if (!anchor) continue;
        // A result without a usable URL is dropped, never invented.
        let resolved: URL;
        try {
          resolved = new URL(anchor.getAttribute("href") ?? "", response.url);
        } catch {
          continue;
        }
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
        const snippet = row.querySelector("p.s")?.textContent.trim() ?? "";
        results.push({
          title: anchor.textContent.trim().slice(0, 200),
          url: resolved.toString(),
          snippet: snippet.slice(0, 400),
        });
      }
      return results;
    },
  };
}
