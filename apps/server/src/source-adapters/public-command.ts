import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { AdapterDiagnostic, SourceItem } from "@chief-of-staff-demo/shared";
import type { SourceCollectionResult } from "./source-adapter.js";

const execFileAsync = promisify(execFile);

interface PublicCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

export type PublicCommandRunner = (args: string[]) => Promise<PublicCommandResult>;

export function publicCommandRunner(input: {
  executable: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): PublicCommandRunner {
  return async (args) => {
    try {
      const result = await execFileAsync(input.executable, args, {
        timeout: input.timeoutMs,
        maxBuffer: input.maxOutputBytes,
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as { code?: number | string; stderr?: string; message?: string };
      const timedOut = (error as { killed?: boolean }).killed === true;
      return {
        stdout: "",
        stderr: failure.stderr ?? failure.message ?? String(error),
        code: typeof failure.code === "number" ? failure.code : 1,
        timedOut,
      };
    }
  };
}

export function checkpointOf(items: SourceItem[]): string {
  return createHash("sha256")
    .update(items.map((item) => item.externalId).join("\n"))
    .digest("hex");
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ClassifiedPublicCommandFailure {
  outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"];
  affectedCapabilities: AdapterDiagnostic["affectedCapabilities"];
  message: string;
}

export function commandAdapterResults(input: {
  adapterVersion: string;
  parserStage: AdapterDiagnostic["parserStage"];
  now: () => Date;
}): {
  diagnostic: (
    classification: AdapterDiagnostic["classification"],
    route: string,
    startedAt: string,
    affectedCapabilities: AdapterDiagnostic["affectedCapabilities"],
    causeChain: string[],
  ) => AdapterDiagnostic;
  failure: (
    outcome: Extract<SourceCollectionResult, { kind: "failed" }>["outcome"],
    route: string,
    startedAt: string,
    affectedCapabilities: AdapterDiagnostic["affectedCapabilities"],
    causeChain: string[],
  ) => SourceCollectionResult;
} {
  const diagnostic = (
    classification: AdapterDiagnostic["classification"],
    route: string,
    startedAt: string,
    affectedCapabilities: AdapterDiagnostic["affectedCapabilities"],
    causeChain: string[],
  ): AdapterDiagnostic => ({
    classification,
    route,
    status: null,
    contentType: "application/json",
    parserStage: input.parserStage,
    responseHash: "",
    adapterVersion: input.adapterVersion,
    startedAt,
    finishedAt: input.now().toISOString(),
    retries: 0,
    affectedCapabilities,
    causeChain,
  });

  return {
    diagnostic,
    failure: (outcome, route, startedAt, affectedCapabilities, causeChain) => ({
      kind: "failed",
      outcome,
      items: [],
      checkpoint: null,
      diagnostic: diagnostic(outcome, route, startedAt, affectedCapabilities, causeChain),
    }),
  };
}

export function classifyPublicCommandFailure(
  stderr: string,
  platform: "Instagram" | "TikTok",
  timedOut = false,
): ClassifiedPublicCommandFailure {
  const text = stderr.toLowerCase();
  const firstLine =
    stderr
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  if (timedOut) {
    return {
      outcome: "timeout",
      affectedCapabilities: ["items"],
      message: firstLine || `The command boundary could not reach ${platform} in time.`,
    };
  }
  if (/log in|login|sign in|authenticate|authentication|cookie/i.test(text)) {
    return {
      outcome: "blocked_access",
      affectedCapabilities: ["items", "comments"],
      message: firstLine || `${platform} is requiring authentication for this public target.`,
    };
  }
  if (/rate|too many requests|\b429\b|temporarily unavailable/i.test(text)) {
    return {
      outcome: "rate_limit",
      affectedCapabilities: ["items"],
      message: firstLine || `${platform} is rate limiting anonymous collection.`,
    };
  }
  if (/unsupported url|unsupported site|no supported extractor/i.test(text)) {
    return {
      outcome: "unsupported_capability",
      affectedCapabilities: ["source_target"],
      message: firstLine || `yt-dlp has no supported ${platform} extractor for this target.`,
    };
  }
  if (/unavailable|private|removed|not found|\b404\b/i.test(text)) {
    return {
      outcome: "blocked_access",
      affectedCapabilities: ["items"],
      message: firstLine || `${platform} reports this public target as unavailable.`,
    };
  }
  if (/timed out|timeout|econnreset|eai_again/i.test(text)) {
    return {
      outcome: "timeout",
      affectedCapabilities: ["items"],
      message: firstLine || `The command boundary could not reach ${platform} in time.`,
    };
  }
  return {
    outcome: "internal_failure",
    affectedCapabilities: ["items"],
    message: firstLine || stderr.trim() || "The command boundary exited without a diagnostic.",
  };
}
