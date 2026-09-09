import type { SourceAdapter } from "../source-adapters/source-adapter.js";
import { ContentScoutRetention } from "../modules/content-scout/retention.js";
import { ExternalRuntimeInspector } from "../modules/content-scout/runtime.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import { RssSourceAdapter } from "../source-adapters/rss.js";
import { WebsiteSourceAdapter } from "../source-adapters/website.js";
import { YouTubeSourceAdapter, type YouTubeSourceAccess } from "../source-adapters/youtube.js";
import { RedditSourceAdapter } from "../source-adapters/reddit.js";
import { HnAlgoliaSourceAdapter } from "../modules/content-research/adapters/hn.js";

/*
 * Why this portfolio lives here and Content Scout's lives with Content Scout.
 *
 * The collectors both Modules use — RSS, website, YouTube, Reddit, and the
 * browser and command seams under them — are Workspace-owned and live in
 * `source-adapters/`, so neither Module owns what the other borrows (issue
 * #118). Content Scout keeps the adapters only it has: Instagram, TikTok,
 * Substack, LinkedIn, and its experimental lane.
 *
 * What remains feature-specific is the *arrangement*. A portfolio is a policy
 * decision — which platforms this Module watches, on which routes, under whose
 * credentials — and the two Modules answer it differently: Content Research
 * takes six shared collectors and no login, Content Scout takes those plus its
 * own. Content Scout's factory therefore stays with Content Scout, and this one
 * sits in the composition layer with the bootstrap that calls it, because a
 * portfolio assembled inside `source-adapters/` would put a policy decision in
 * the shared layer, where the next Module would inherit it by accident.
 */

/**
 * Content Research's V1 portfolio (spec #116): RSS (Substack native feeds on
 * the shared RSS route), website enrichment, YouTube on the Shell Google
 * connection, polite anonymous Reddit, keyless HN Algolia, and Google News —
 * which publishes search results as an ordinary RSS feed, so the shared RSS
 * route collects it under its own platform id. No LinkedIn, no login, no
 * imported cookies, no new secret.
 */
export function contentResearchProductionAdapters(input: {
  workspaceDir: string;
  renderBrowser: BrowserRenderer;
  getYouTubeAccess: () => YouTubeSourceAccess;
  now?: () => Date;
}): SourceAdapter[] {
  const now = input.now ?? (() => new Date());
  return [
    new RssSourceAdapter(undefined, now),
    new RssSourceAdapter(undefined, now, { id: "news" }),
    new WebsiteSourceAdapter(undefined, now, input.renderBrowser),
    new YouTubeSourceAdapter(input.getYouTubeAccess, now, {
      runtimeInspector: new ExternalRuntimeInspector(now),
      retention: new ContentScoutRetention(input.workspaceDir, now),
    }),
    new RedditSourceAdapter(undefined, now),
    new HnAlgoliaSourceAdapter(undefined, now),
  ];
}
