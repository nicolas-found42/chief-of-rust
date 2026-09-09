import type { PeopleSuggestionShape } from "@chief-of-staff-demo/shared";
import { ResonanceHookShapeSchema, PeopleSuggestionShapeSchema } from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { parseResultShape } from "../../llm/failure.js";
import type { HookExtractor, PeopleDiscoveryInput } from "./ports.js";

/* The ports own these shapes; the model functions are the implementations, so
   they take their input from the port rather than restating it. */
export type HookExtractorFn = HookExtractor["extract"];

export type PeopleSuggestorFn = (input: PeopleDiscoveryInput) => Promise<PeopleSuggestionShape>;

export function createHookExtractor(getCompleteJson: () => CompleteJson): HookExtractorFn {
  return async (input) => {
    const prompt = [
      `Explain why ${input.personName}'s content is resonating right now.`,
      `You see only the top evidence (title, excerpt, transcript when present):`,
      JSON.stringify(input.items),
      `Return one hook: the reason it lands, grounded in that evidence and in nothing else.`,
      `Optionally quote one verbatim line as evidenceQuote.`,
    ].join("\n");
    const raw = await getCompleteJson()({
      system: "You extract resonance hooks. Return JSON with hook and optional evidenceQuote.",
      user: prompt,
      schema: ResonanceHookShapeSchema,
    });
    return parseResultShape("ResonanceHookShape", ResonanceHookShapeSchema, raw);
  };
}

export function createPeopleDiscoverer(getCompleteJson: () => CompleteJson): PeopleSuggestorFn {
  return async (input) => {
    const prompt = [
      input.brandProfile
        ? `The workspace's Brand Profile:\n${input.brandProfile.markdown.slice(0, 2000)}`
        : "No Brand Profile is configured.",
      `People already watched: ${input.approvedPeople.map((p) => p.name).join(", ") || "none"}.`,
      `Recently collected public items (title, author, url) — co-mentions, citations, and outbound links in these are the signals:`,
      JSON.stringify(input.recentItems.slice(0, 50)),
      input.searchResults.length > 0
        ? `Public search results for the watchlist, for co-mentions and related accounts:\n${JSON.stringify(input.searchResults)}`
        : "Public search returned nothing for the watchlist.",
      `Propose at most three new people worth watching. Every supportingUrl must be copied verbatim from the collected items or the search results; never invent a URL.`,
    ].join("\n");
    const raw = await getCompleteJson()({
      system: "You propose Person Suggestions. Return JSON with candidates array.",
      user: prompt,
      schema: PeopleSuggestionShapeSchema,
    });
    return parseResultShape("PeopleSuggestionShape", PeopleSuggestionShapeSchema, raw);
  };
}
