import { fromPartial } from "@total-typescript/shoehorn";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import type {
  ContentEngineDraftGenerator,
  PlatformOutlineGenerator,
} from "../../../apps/server/src/content-projects/generation";

/** Fixtures shared by the Content Project generation suites (#131, #132). */

export const NOW = new Date("2026-08-31T18:00:00.000Z");

export const SOURCE_ITEM: SourceItem = fromPartial<SourceItem>({
  id: "source_1",
  externalId: "article-1",
  targetId: "target_1",
  adapterId: "website",
  canonicalUrl: "https://evidence.example/article",
  author: "Researcher",
  title: "Evidence-backed content",
  body: "Reviewed public evidence.",
  publishedAt: "2026-08-30T12:00:00.000Z",
  discoveredAt: "2026-08-31T17:00:00.000Z",
});

export const SOURCE_ITEM_2: SourceItem = fromPartial<SourceItem>({
  ...SOURCE_ITEM,
  id: "source_2",
  externalId: "article-2",
  canonicalUrl: "https://evidence.example/article-2",
  title: "Additional frozen evidence",
});

export const DIAGNOSTIC: AdapterDiagnostic = fromPartial<AdapterDiagnostic>({
  classification: "items_found",
  route: "https://evidence.example/article",
  status: 200,
  contentType: "text/html",
  parserStage: "readability",
  responseHash: "response-hash",
  adapterVersion: "1",
  startedAt: "2026-08-31T17:00:00.000Z",
  finishedAt: "2026-08-31T17:00:01.000Z",
  retries: 0,
  affectedCapabilities: ["body"],
  causeChain: [],
});

/**
 * Generation stubs for suites that never reach Outline or Draft generation:
 * any call fails loudly instead of answering with invented content.
 */
export function stubOutlineGenerator(): PlatformOutlineGenerator {
  return {
    async generate() {
      throw new Error("This suite does not wire Outline generation.");
    },
  };
}

export function stubDraftGenerator(): ContentEngineDraftGenerator {
  return {
    async generate() {
      throw new Error("This suite does not wire Draft generation.");
    },
  };
}
