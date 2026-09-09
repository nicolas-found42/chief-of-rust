import type { SourceAdapter } from "../../../source-adapters/source-adapter.js";
import { ContentScoutRetention } from "../retention.js";
import { ExternalRuntimeInspector } from "../runtime.js";
import type { BrowserRenderer } from "../../../source-adapters/browser.js";
import { InstagramInstaloaderAdapter } from "./instagram.js";
import { LinkedInComingLaterAdapter } from "./linkedin.js";
import { RedditSourceAdapter } from "../../../source-adapters/reddit.js";
import { RssSourceAdapter } from "../../../source-adapters/rss.js";
import { SubstackEnrichmentAdapter } from "./substack.js";
import { TikTokYtDlpAdapter } from "./tiktok.js";
import { WebsiteSourceAdapter } from "../../../source-adapters/website.js";
import {
  YouTubeSourceAdapter,
  type YouTubeSourceAccess,
} from "../../../source-adapters/youtube.js";

export function contentScoutProductionAdapters(input: {
  workspaceDir: string;
  renderBrowser: BrowserRenderer;
  getYouTubeAccess: () => YouTubeSourceAccess;
  now?: () => Date;
}): SourceAdapter[] {
  const now = input.now ?? (() => new Date());
  return [
    new RssSourceAdapter(undefined, now),
    new RssSourceAdapter(undefined, now, { id: "substack" }),
    new WebsiteSourceAdapter(undefined, now, input.renderBrowser),
    new SubstackEnrichmentAdapter(undefined, now),
    new YouTubeSourceAdapter(input.getYouTubeAccess, now, {
      runtimeInspector: new ExternalRuntimeInspector(now),
      retention: new ContentScoutRetention(input.workspaceDir, now),
    }),
    new RedditSourceAdapter(undefined, now),
    new InstagramInstaloaderAdapter(undefined, undefined, now),
    new TikTokYtDlpAdapter(undefined, undefined, now),
    new LinkedInComingLaterAdapter(input.renderBrowser, now),
  ];
}
