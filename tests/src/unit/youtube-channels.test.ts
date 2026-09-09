import { describe, expect, it } from "vitest";
import {
  ChannelUrlError,
  parseChannelUrl,
} from "../../../apps/server/src/source-adapters/youtube-channels";

/**
 * The paste is checked while the operator is still looking at it, so what this
 * function refuses is what they read. Every refusal has to name the forms that
 * work — a typo must be their problem now rather than a silent gap in
 * tomorrow's data.
 */
describe("parseChannelUrl", () => {
  it("reads a handle URL, with or without a scheme, path tail or query", () => {
    expect(parseChannelUrl("https://www.youtube.com/@found42")).toEqual({
      kind: "handle",
      value: "@found42",
    });
    expect(parseChannelUrl("youtube.com/@found42")).toEqual({ kind: "handle", value: "@found42" });
    expect(parseChannelUrl("https://youtube.com/@found42/videos?view=0")).toEqual({
      kind: "handle",
      value: "@found42",
    });
  });

  it("reads a channel-id URL", () => {
    expect(parseChannelUrl("https://www.youtube.com/channel/UCabc123")).toEqual({
      kind: "id",
      value: "UCabc123",
    });
  });

  it("reads a legacy user URL", () => {
    expect(parseChannelUrl("https://www.youtube.com/user/Found42")).toEqual({
      kind: "username",
      value: "Found42",
    });
  });

  it("refuses a /c/ URL, saying why and which forms work", () => {
    /* Google publishes no route from a custom URL to a channel id, and the
       search fallback has its own tiny quota — a fragility invisible until the
       Module is tracking the wrong channel. */
    expect(() => parseChannelUrl("https://www.youtube.com/c/Found42")).toThrow(ChannelUrlError);
    try {
      parseChannelUrl("https://www.youtube.com/c/Found42");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("youtube.com/@name");
      expect(message).toContain("youtube.com/channel/UC");
    }
  });

  it("refuses anything that is not a YouTube channel URL", () => {
    for (const bad of [
      "",
      "not a url at all",
      "https://vimeo.com/@found42",
      "https://www.youtube.com/",
      "https://www.youtube.com/watch?v=abc",
      "https://www.youtube.com/channel/",
    ]) {
      expect(() => parseChannelUrl(bad), bad).toThrow(ChannelUrlError);
    }
  });
});
