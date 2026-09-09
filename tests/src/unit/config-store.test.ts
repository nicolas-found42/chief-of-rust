import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../apps/server/src/config";

function workspaceWithConfig(label: string, config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), `config-store-${label}-`));
  writeFileSync(join(root, "config.json"), `${JSON.stringify(config)}\n`);
  return root;
}

describe("ConfigStore.load legacy tolerance", () => {
  it("loads a pre-cutover config carrying the retired content-scout Notion calendar block", () => {
    const root = workspaceWithConfig("notion-legacy", {
      provider: "anthropic",
      model: "fixture-model",
      apiKey: "fixture-key",
      modules: {
        "content-scout": {
          timeZone: "UTC",
          dailyTime: "08:00",
          weeklyDiscoveryDay: 1,
          weeklyDiscoveryTime: "09:00",
          shortlistSize: 5,
          canaryIntervalHours: 12,
          canaryDisabledAdapters: [],
          notion: {
            databaseId: "legacy-database",
            dataSourceId: "legacy-data-source",
            databaseUrl: "https://notion.test/db",
            mapping: {
              name: "Name",
              status: "Status",
              platform: "Platform",
              format: "Format",
              scheduledDate: "Scheduled date",
            },
          },
        },
      },
    });
    const store = new ConfigStore(join(root, "config.json"));
    const config = store.load();
    expect(Object.hasOwn(config.modules["content-scout"], "notion")).toBe(false);
  });

  it("still drops the fireflies and watch keys the pre-parse tolerance already removed", () => {
    const root = workspaceWithConfig("legacy-keys", {
      fireflies: { apiKey: "legacy" },
      watch: { id: "legacy" },
    });
    const store = new ConfigStore(join(root, "config.json"));
    expect(() => store.load()).not.toThrow();
  });
});
