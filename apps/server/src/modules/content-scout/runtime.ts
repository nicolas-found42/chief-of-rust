import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContentScoutRuntimeCapability } from "@chief-of-staff-demo/shared";
import type { RuntimeInspector } from "./ports.js";

const execFileAsync = promisify(execFile);

export type RuntimeCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

interface RuntimeDefinition {
  id: string;
  category: ContentScoutRuntimeCapability["category"];
  command: string | null;
  args: string[];
  pinnedVersion?: string;
  expectedVersionFragment?: string;
  requiredBy: string[];
}

const DEFINITIONS: RuntimeDefinition[] = [
  {
    id: "browser.chromium",
    category: "browser",
    command: "chromium",
    args: ["--version"],
    pinnedVersion: "153.0.8010.12",
    expectedVersionFragment: "153.0.8010.12",
    requiredBy: ["Website JavaScript fallback"],
  },
  {
    id: "python.interpreter",
    category: "python",
    command: "python3",
    args: ["--version"],
    pinnedVersion: "3.12.3",
    expectedVersionFragment: "3.12.3",
    requiredBy: ["Public transcript and Experimental adapter workers"],
  },
  {
    id: "python.youtube-transcript-api",
    category: "python",
    command: "python3",
    args: [
      "-c",
      "import importlib.metadata; print(importlib.metadata.version('youtube-transcript-api'))",
    ],
    pinnedVersion: "1.2.2",
    expectedVersionFragment: "1.2.2",
    requiredBy: ["YouTube public transcript fallback"],
  },
  {
    id: "python.instaloader",
    category: "python",
    command: "instaloader",
    args: ["--version"],
    pinnedVersion: "4.14.2",
    expectedVersionFragment: "4.14.2",
    requiredBy: ["Instagram Experimental public-profile route"],
  },
  {
    id: "python.pyktok",
    category: "python",
    command: null,
    args: [],
    requiredBy: ["TikTok Experimental enrichment"],
  },
  {
    id: "media.ffmpeg",
    category: "media",
    command: "ffmpeg",
    args: ["-version"],
    pinnedVersion: "6.1.1-3ubuntu5",
    expectedVersionFragment: "6.1.1-3ubuntu5",
    requiredBy: ["Bounded public media extraction"],
  },
  {
    id: "media.yt-dlp",
    category: "media",
    command: "yt-dlp",
    args: ["--version"],
    pinnedVersion: "2025.08.22",
    expectedVersionFragment: "2025.08.22",
    requiredBy: ["Known public media URL fallback"],
  },
  {
    id: "transcription.whisper-cpp",
    category: "transcription",
    command: "/bin/cat",
    args: ["/usr/local/share/content-scout/whisper-cpp-version"],
    pinnedVersion: "v1.7.6",
    expectedVersionFragment: "1.7.6",
    requiredBy: ["Optional bounded local transcription"],
  },
];

const defaultRunner: RuntimeCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

/** Production command seam; every invocation is argv-based and performs no network access. */
export class ExternalRuntimeInspector implements RuntimeInspector {
  private cached: Promise<ContentScoutRuntimeCapability[]> | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly run: RuntimeCommandRunner = defaultRunner,
  ) {}

  inspect(): Promise<ContentScoutRuntimeCapability[]> {
    this.cached ??= Promise.all(DEFINITIONS.map((definition) => this.inspectOne(definition)));
    return this.cached;
  }

  private async inspectOne(definition: RuntimeDefinition): Promise<ContentScoutRuntimeCapability> {
    const checkedAt = this.now().toISOString();
    if (!definition.command) {
      return {
        id: definition.id,
        category: definition.category,
        state: "unsupported",
        version: null,
        ...(definition.pinnedVersion ? { pinnedVersion: definition.pinnedVersion } : {}),
        requiredBy: definition.requiredBy,
        diagnostic: {
          classification: "runtime_unsupported",
          command: "not installed by the approved production image",
          checkedAt,
          causeChain: ["This optional enrichment runtime is intentionally unsupported."],
        },
      };
    }
    const invocation = [definition.command, ...definition.args].join(" ");
    try {
      const output = await this.run(definition.command, definition.args);
      const version = `${output.stdout}\n${output.stderr}`
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      if (
        definition.expectedVersionFragment &&
        !`${output.stdout}\n${output.stderr}`.includes(definition.expectedVersionFragment)
      ) {
        return {
          id: definition.id,
          category: definition.category,
          state: "unavailable",
          version: version ?? null,
          ...(definition.pinnedVersion ? { pinnedVersion: definition.pinnedVersion } : {}),
          requiredBy: definition.requiredBy,
          diagnostic: {
            classification: "runtime_unavailable",
            command: invocation,
            checkedAt,
            causeChain: [
              `Installed version does not match the approved ${definition.pinnedVersion ?? "runtime"} pin.`,
            ],
          },
        };
      }
      return {
        id: definition.id,
        category: definition.category,
        state: "available",
        version: version ?? "available",
        ...(definition.pinnedVersion ? { pinnedVersion: definition.pinnedVersion } : {}),
        requiredBy: definition.requiredBy,
        diagnostic: {
          classification: "runtime_available",
          command: invocation,
          checkedAt,
          causeChain: [],
        },
      };
    } catch (error) {
      return {
        id: definition.id,
        category: definition.category,
        state: "unavailable",
        version: null,
        ...(definition.pinnedVersion ? { pinnedVersion: definition.pinnedVersion } : {}),
        requiredBy: definition.requiredBy,
        diagnostic: {
          classification: "runtime_unavailable",
          command: invocation,
          checkedAt,
          causeChain: [error instanceof Error ? error.message : String(error)],
        },
      };
    }
  }
}
