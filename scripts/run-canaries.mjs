#!/usr/bin/env node
/**
 * Run public canaries outside merge CI using the normal Source Adapter
 * diagnostic contract. This is the scheduled canary seam: it collects the
 * same small envelope as the Daily Intake (adapter.collect) and persists
 * results by adapter version, target, capability, route, and time, but a
 * failure here never fails the repository check gate.
 *
 * Intended to be invoked by `.github/workflows/canary.yml` (scheduled) and
 * locally via `node ./scripts/run-canaries.mjs`. Network access is required
 * for the live canaries; any failure is logged but the process exits 0 so
 * that a public-route change is visible without blocking other work.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== undefined && mode !== "--check")) {
  throw new Error("Usage: node scripts/run-canaries.mjs [--check]");
}

const { ContentScoutCanaryRunner, ContentScoutCanaryStore } =
  await import("../apps/server/dist/modules/content-scout/canary.js");
const { contentScoutProductionAdapters } =
  await import("../apps/server/dist/modules/content-scout/adapters/production.js");
const { playwrightBrowserRenderer } =
  await import("../apps/server/dist/source-adapters/browser.js");

// Prefer the real workspace when available, otherwise use a temporary directory
// so the script remains hermetic in CI containers that start without a workspace.
const workspaceDir = process.env.WORKSPACE_DIR ?? "./workspace";
mkdirSync(join(workspaceDir, "content-scout"), { recursive: true });

const adapters = contentScoutProductionAdapters({
  workspaceDir,
  renderBrowser: playwrightBrowserRenderer(),
  getYouTubeAccess: () => ({ ok: false, state: "disconnected" }),
});

// Import and compose every adapter without querying external sites. The image
// gate runs this against a clean build so stale local dist files cannot hide
// a moved module or a missing production dependency.
if (mode === "--check") {
  console.log(`[canary] Composed ${adapters.length} production adapters; no external calls made.`);
  process.exit(0);
}

const store = new ContentScoutCanaryStore(workspaceDir, () => new Date());
const runner = new ContentScoutCanaryRunner({ adapters, store, now: () => new Date() });

console.log(`[canary] Running ${adapters.length} adapters × canary targets (outside merge CI)...`);
let receipts;
try {
  receipts = await runner.runOnce();
} catch (error) {
  console.warn("[canary] Runner threw, recording as degraded (not failing CI):", error);
  receipts = store.list().slice(-10);
}

// Always succeed as a process: legitimate-empty is also not success for canaries,
// but it must not fail CI, and a site change must not block merges.
for (const receipt of receipts) {
  const ok = receipt.outcome === "items_found" && receipt.itemsFound > 0;
  console.log(
    `[canary] ${receipt.adapterId} ${receipt.adapterVersion} ${receipt.target.label} → ${receipt.outcome} (${receipt.itemsFound} items) route:${receipt.route} cap:${receipt.capability} ${ok ? "ok" : "degraded"}`,
  );
}

// Persist a flat copy for artifact upload when running outside the workspace layout.
try {
  const flatPath = join(process.cwd(), "canary-receipts.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(flatPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  console.log(
    `[canary] Wrote ${receipts.length} receipts to ${flatPath} and ${join(workspaceDir, "content-scout", "canary-state.json")}`,
  );
} catch (error) {
  console.warn("[canary] Could not write flat receipts artifact:", error);
}
process.exit(0);
