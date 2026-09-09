import { chromium, type Page } from "playwright-core";
import { assertPublicHttpUrl } from "./http.js";

export interface BrowserRenderResult {
  url: string;
  contentType: string;
  status: number;
  body: string;
}

export type BrowserRenderer = (url: string) => Promise<BrowserRenderResult>;

const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
const BROWSER_COLLECTION_LIMIT_BYTES = 5_000_000;

function renderingTimeout(): Error {
  return Object.assign(
    new Error(`Browser rendering timed out after ${BROWSER_NAVIGATION_TIMEOUT_MS / 1000} seconds.`),
    { name: "AbortError" },
  );
}

async function readLandingDocument(page: Page, deadline: number): Promise<string> {
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw renderingTimeout();
    await page.waitForLoadState("domcontentloaded", { timeout: remaining });
    try {
      return await page.content();
    } catch (error) {
      // A client-side redirect can destroy the document after DOMContentLoaded.
      // Retry that race only, without giving each redirect a fresh time budget.
      if (
        !(error instanceof Error) ||
        !error.message.includes(
          "Unable to retrieve content because the page is navigating and changing the content.",
        )
      )
        throw error;
    }
  }
}

/**
 * The bounded public browser route behind the Website Source Adapter. It
 * renders exactly one public URL in a fresh anonymous headless Chromium
 * context: no cookies, no persisted storage state, no authentication, no
 * CAPTCHA handling and no stealth flags. Launching and closing a browser per
 * request keeps the fallback isolated from every other adapter and bounded in
 * time and body size.
 */
export function playwrightBrowserRenderer(): BrowserRenderer {
  return async (value) => {
    const url = assertPublicHttpUrl(value);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const deadline = Date.now() + BROWSER_NAVIGATION_TIMEOUT_MS;
      try {
        const navigation = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
        });
        const body = await readLandingDocument(page, deadline);
        if (Buffer.byteLength(body, "utf8") > BROWSER_COLLECTION_LIMIT_BYTES) {
          throw new Error("Rendered page exceeded the 5 MB collection limit.");
        }
        return {
          url: page.url(),
          contentType: "text/html",
          status: navigation?.status() ?? 200,
          body,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw renderingTimeout();
        }
        throw error;
      }
    } finally {
      await browser.close();
    }
  };
}
