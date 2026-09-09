import type {
  BrandProfileRevision,
  BrandProfileScanPage,
  RankedOpportunity,
  SourceItem,
  SourceTarget,
  SourceSuggestion,
  SourceStoryGroup,
  ContentScoutRuntimeCapability,
} from "@chief-of-staff-demo/shared";

export interface OpportunityRanker {
  rank(input: {
    brandProfile: BrandProfileRevision;
    items: SourceItem[];
    storyGroups: SourceStoryGroup[];
    limit: number;
  }): Promise<RankedOpportunity[]>;
}

export interface SourceDiscoverer {
  discover(input: {
    brandProfile: BrandProfileRevision;
    approvedTargets: SourceTarget[];
  }): Promise<
    Omit<SourceSuggestion, "id" | "state" | "discoveredAt" | "decisionReason" | "sourceTargetId">[]
  >;
}

export interface BrandProfileCrawler {
  crawl(input: { websiteUrl: string; maxPages: 25; maxDepth: 2 }): Promise<BrandProfileScanPage[]>;
}

export interface BrandProfileProposer {
  propose(input: { pages: BrandProfileScanPage[] }): Promise<string>;
}

export interface RuntimeInspector {
  inspect(): Promise<ContentScoutRuntimeCapability[]>;
}
