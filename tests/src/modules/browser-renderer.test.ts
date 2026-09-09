import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playwrightBrowserRenderer } from "../../../apps/server/src/source-adapters/browser";

const browser = vi.hoisted(() => ({ close: vi.fn(), newPage: vi.fn() }));
vi.mock("../../../apps/server/node_modules/playwright-core", () => ({
  chromium: { launch: async () => browser },
}));
const navigationError = () =>
  new Error(
    "page.content: Unable to retrieve content because the page is navigating and changing the content.",
  );

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

function pageFixture() {
  const page = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForLoadState: vi.fn(async () => undefined),
    content: vi.fn(async () => "<html><body>Ready</body></html>"),
    url: () => "https://example.com/landing",
  };
  browser.newPage.mockResolvedValue(page);
  return page;
}

describe("public browser rendering", () => {
  it("reads the landing document when a navigation interrupts the first snapshot", async () => {
    const page = pageFixture();
    page.content.mockRejectedValueOnce(navigationError());

    await expect(playwrightBrowserRenderer()("https://example.com")).resolves.toMatchObject({
      url: "https://example.com/landing",
      status: 200,
      body: "<html><body>Ready</body></html>",
    });
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.content).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("stops repeated navigations at the original rendering deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const page = pageFixture();
    page.content.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      throw navigationError();
    });

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(page.content).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("uses only the remaining navigation budget when waiting for the landing page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const page = pageFixture();
    page.goto.mockImplementation(async () => {
      vi.setSystemTime(12_000);
      return { status: () => 200 };
    });
    page.waitForLoadState.mockRejectedValue(
      Object.assign(new Error("Timed out"), { name: "TimeoutError" }),
    );

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: 3_000 });
    expect(page.content).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated snapshot failures", async () => {
    const page = pageFixture();
    page.content.mockRejectedValue(new Error("Browser closed"));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toThrow(
      "Browser closed",
    );
    expect(page.content).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("reports a load timeout as an aborted collection and closes the browser", async () => {
    const page = pageFixture();
    page.goto.mockRejectedValue(Object.assign(new Error("Timed out"), { name: "TimeoutError" }));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("still rejects an oversized rendered document", async () => {
    const page = pageFixture();
    page.content.mockResolvedValue("x".repeat(5_000_001));

    await expect(playwrightBrowserRenderer()("https://example.com")).rejects.toThrow("5 MB");
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
