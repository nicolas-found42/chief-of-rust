import { readFile } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type ProviderId,
  type ResultShapeBinding,
  type ModelAttemptEvent,
  type ModelBoundaryDiagnostic,
  DEFAULT_OLLAMA_BASE_URL,
  MODEL_REQUEST_TIMEOUT_MS,
  MODEL_SMALL_REQUEST_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_STREAM_MAX_ANSWER_CHARS,
  MODEL_STREAM_SILENT_TIMEOUT_MS,
  RESULT_SHAPE_BINDINGS,
} from "@chief-of-staff-demo/shared";
import {
  isUpstreamCapacityRefusal,
  modelBoundaryDiagnostic,
  modelBoundaryFailure,
  type AnswerContainer,
  type ModelBoundaryError,
  type ModelCall,
} from "./failure.js";

/**
 * Any Module's wire schema. Spelled without Zod's `any` generics so that
 * handing one to `zodToJsonSchema` stays type-safe.
 */
type WireSchema = ZodType<unknown, ZodTypeDef, unknown>;

export interface LlmConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Ollama only: where the local server listens. */
  baseUrl?: string;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /**
   * Request-local preference among bindings the OpenRouter model declares.
   * Honored only when both tools and tool_choice are declared; unknown or
   * unsupported preferences leave the strongest supported default intact.
   * Other providers retain their existing binding policy (ADR-0065).
   */
  preferredBinding?: "forced_tool_call";
  /** One bounded same-binding retry; recovered failures must remain observable. */
  retry?: {
    onAttempt: (event: ModelAttemptEvent) => void;
    /** Optional lifecycle fence, rechecked after backoff before another request. */
    canRetry?: () => boolean;
  };
  /**
   * This call's own absolute ceiling, in place of the seam's 300 s default.
   * Small structured calls — a bounded slice in, a bounded answer out — run
   * under `MODEL_SMALL_REQUEST_TIMEOUT_MS` so a slow-drip generation cannot
   * hold a slice of an operation's budget for five minutes (ADR-0074). The
   * stream ceilings inside it are unchanged.
   */
  absoluteCeilingMs?: number;
  /**
   * Sampling temperature. Omitted → the upstream's own default, exactly as
   * before; extraction Modules set 0 so a transcript yields one extraction,
   * not a fresh sample per run.
   */
  temperature?: number;
  /**
   * Requested thinking depth for providers that meter reasoning. Resolved
   * against the model's advertised efforts at send time: unlisted values,
   * and `none` on reasoning-mandatory models, are omitted rather than sent.
   * Omitted → `DEFAULT_REASONING_EFFORT`.
   */
  reasoningEffort?: string;
  /**
   * Best-effort sampling seed, sent only to providers whose wire accepts one
   * (the OpenAI family). Hosted inference stays non-deterministic even with
   * a seed; the recorded `systemFingerprint` names the backend that answered.
   */
  seed?: number;
  /**
   * The result shape this one call must return. Required, and deliberately so:
   * one Shell seam serves every Module, `strict: true` means the schema sent is
   * the schema obeyed, and a default here would hand a Module another Module's
   * shape without saying so. Every caller names its own.
   */
  schema: WireSchema;
  /**
   * Send the schema with abbreviated property names and restore the caller's
   * own names before validating.
   *
   * Measured on the person-extraction request: 21% fewer output tokens and 15%
   * less wall time, because a quarter to a third of every answer's characters
   * were field names repeated once per claim (#232). The caller's schema — the
   * contract — is untouched; only the wire representation shrinks, and the
   * boundary tells the model what the abbreviations mean. Opt-in, so a caller
   * whose prompt names its fields is not silently rewritten under it.
   */
  compactWireNames?: boolean;
  /**
   * Preferred minimum route throughput in tokens/second. OpenRouter only, and
   * a preference rather than a pin: routes below it are deprioritized, never
   * excluded, so a stale number degrades to today's order instead of failing.
   * Opt-in per request so each caller names the number its own measurements
   * justify — extraction asks from the #232 route survey (#233).
   */
  preferredMinThroughput?: number;
}

export type CompleteJson = (request: CompletionRequest) => Promise<unknown>;
/** The ceiling on one model call. Exported so a test can drive it deterministically. */
export const REQUEST_TIMEOUT_MS = MODEL_REQUEST_TIMEOUT_MS;

/** The silent-but-connected ceiling. Exported for the same reason. */
export const STREAM_SILENT_TIMEOUT_MS = MODEL_STREAM_SILENT_TIMEOUT_MS;

/** The streaming idle ceiling. Exported so a test can drive it deterministically. */
export const STREAM_IDLE_TIMEOUT_MS = MODEL_STREAM_IDLE_TIMEOUT_MS;

/** The most answer one streamed call may deliver. Exported so a test can reach it cheaply. */
export const STREAM_MAX_ANSWER_CHARS = MODEL_STREAM_MAX_ANSWER_CHARS;

/** The small-call absolute ceiling. Exported so a test can drive it deterministically. */
export const SMALL_REQUEST_TIMEOUT_MS = MODEL_SMALL_REQUEST_TIMEOUT_MS;

/**
 * An answer that will not finish, however it shows itself: repeating one short
 * unit, or running past the most one call may deliver. Both are the stream
 * saying the same thing, and both step to the next binding rather than riding
 * out the call's whole budget.
 */
const RUNAWAY_ANSWER = new Set<string>(["repetition_loop", "answer_overrun"]);

interface RequestDeadline {
  signal: AbortSignal;
  timeRemaining(): number;
  /* This call's effective absolute ceiling: the request's own override, or
     the seam default. Recovery paths name it when a ceiling fires. */
  absoluteCeilingMs: number;
  /* The seam stamps `attempt`, `binding` and who-answered centrally in
     `withinRequestCeiling`, so recovery paths below name what they tried
     without restating it per call site. */
  reportAttempt(event: Omit<ModelAttemptEvent, "attempt" | "binding" | "provider" | "model">): void;
  calling(call: ModelCall): void;
  /* The rest list sent on the most recently built wire attempt's body, or
     undefined when that attempt carried no rest. The loop assigns it at each
     body build and the central stamp reads it, so every reported attempt —
     including the outer success/failure reports that know no body — carries
     the routing it was actually sent with. */
  providerIgnore?: string[] | undefined;
  /* The thinking depth this call's wire attempts are sent with, or undefined
     when no effort level is sent. Assigned once per call beside the
     resolution above; the central stamp reads it like the rest list. */
  reasoningEffort?: string | undefined;
  /* Assigned by the provider on a succeeded wire response, before the
     central success report is written, so the succeeded attempt carries the
     token/cost/fingerprint facts the wire reported. */
  usage?: ModelUsageObservation | undefined;
  observed(response: { status: number; bodyBytes: number; upstreamServer?: string }): void;
}
/** Token, cost and serving-backend facts off one succeeded wire response. */
export interface ModelUsageObservation {
  provider: ProviderId;
  model: string;
  binding: ResultShapeBinding;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The provider's own charge in US dollars, when it names one. */
  costUsd: number | null;
  systemFingerprint: string | null;
}

let usageObserver: ((observation: ModelUsageObservation) => void) | null = null;

/**
 * Subscribe to every succeeded completion's usage facts, or clear the
 * subscription with null. One subscriber — the benchmark driver — because
 * the seam serves the whole app, and only a benchmark run wants a per-call
 * ledger.
 */
export function observeModelUsage(
  observer: ((observation: ModelUsageObservation) => void) | null,
): void {
  usageObserver = observer;
}

function usageInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function usageDollars(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageName(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

type UsageFacts = Omit<ModelUsageObservation, "provider" | "model" | "binding"> | null;

/** Attach the observation to the succeeded attempt and the subscriber. */
function fireUsage(deadline: RequestDeadline, call: ModelCall, facts: UsageFacts): void {
  if (facts === null) return;
  const observation: ModelUsageObservation = {
    provider: call.provider,
    model: call.model,
    binding: call.binding,
    ...facts,
  };
  deadline.usage = observation;
  usageObserver?.(observation);
}

/** OpenAI-family fields: `usage.prompt_tokens`/`completion_tokens`, OpenRouter's
 *  `usage.cost`, and the serving backend's fingerprint on the choice or root. */
function openAiUsage(payload: unknown): UsageFacts {
  const root = usageRecord(payload);
  const usage = usageRecord(root?.usage);
  const choices = isUnknownArray(root?.choices) ? root.choices : [];
  const choice = usageRecord(choices[0]);
  const inputTokens = usageInt(usage?.prompt_tokens);
  const outputTokens = usageInt(usage?.completion_tokens);
  const costUsd = usageDollars(usage?.cost);
  const systemFingerprint =
    usageName(choice?.system_fingerprint) ?? usageName(root?.system_fingerprint);
  if (
    inputTokens === null &&
    outputTokens === null &&
    costUsd === null &&
    systemFingerprint === null
  )
    return null;
  return { inputTokens, outputTokens, costUsd, systemFingerprint };
}

/** Anthropic names its token fields its own way and reports no cost. */
function anthropicUsage(payload: unknown): UsageFacts {
  const usage = usageRecord(usageRecord(payload)?.usage);
  const inputTokens = usageInt(usage?.input_tokens);
  const outputTokens = usageInt(usage?.output_tokens);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens, costUsd: null, systemFingerprint: null };
}

/** Gemini counts tokens in `usageMetadata` with camelCase names. */
function geminiUsage(payload: unknown): UsageFacts {
  const usage = usageRecord(usageRecord(payload)?.usageMetadata);
  const inputTokens = usageInt(usage?.promptTokenCount);
  const outputTokens = usageInt(usage?.candidatesTokenCount);
  if (inputTokens === null && outputTokens === null) return null;
  return { inputTokens, outputTokens, costUsd: null, systemFingerprint: null };
}

/** One provider answer over the wire: status line plus body text. */
interface HttpResponse {
  status: number;
  text: string;
}

/**
 * One answered call, ready to be read or classified. The call, the response and
 * the parsed payload travel together because every failure below needs all
 * three: the call says what was asked, the response sizes what came back, and
 * the payload holds the shape.
 */
interface ModelReply {
  call: ModelCall;
  response: HttpResponse;
  payload: unknown;
}

/** The reply for a call whose body has passed classification. */
function modelReply(call: ModelCall, response: HttpResponse): ModelReply {
  return { call, response, payload: parseProviderPayload(call, response) };
}

type JsonObject = Record<string, unknown>;

/**
 * `Array.isArray` narrows `unknown` to `any[]`, and every element read off it is
 * then untyped — which defeats the point of the shape checks below. This
 * narrows to `unknown[]`, so each element still has to be checked before use.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** The same narrowing for objects: every member still has to be checked. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON Schema handed to OpenAI / OpenRouter / Anthropic. The Zod source is the
 * caller's (all fields required, nullable optionals) because OpenAI strict
 * json_schema rejects non-required properties.
 */
function wireJsonSchema(source: WireSchema): JsonObject {
  const converted = zodToJsonSchema(source, {
    $refStrategy: "none",
  }) as JsonObject;
  /* OpenAI strict json_schema rejects the $schema key zod-to-json-schema adds. */
  delete converted.$schema;
  return stripLengthCeilings(converted) as JsonObject;
}

/**
 * JSON Schema keywords whose value maps caller-chosen names to subschemas.
 * Their keys are names, so nothing in them is a keyword to remove.
 */
const SCHEMA_NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * Keywords whose value is a subschema, or an array of them. Only these are
 * walked: every other value is data the caller wrote — `enum`, `const`,
 * `default`, `examples`, `required` — where a `maxLength` is a literal to
 * preserve rather than a ceiling to drop.
 */
const SCHEMA_VALUED = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "anyOf",
  "allOf",
  "oneOf",
]);

/**
 * The wire schema without the one keyword that costs the whole call.
 *
 * `maxLength` is not ignored by constrained decoding; on the OpenRouter route
 * it is honoured pathologically. Measured with the judge's own support-phase
 * Result Shape and a 41k-character request: as the seam sent it, the call ran
 * past 45 seconds and came back as an HTTP 200 carrying upstream code 502,
 * which is how 24 of 27 support phases died. The identical request with
 * `maxLength` removed answered in 4.4 seconds. `maxItems` and the numeric
 * bounds were measured innocent, and `inception/mercury-2.5-preview` and
 * `qwen/qwen3.7-flash` behaved alike, so the cost belongs to the provider's
 * decoder rather than to one model — which is why this strips for every
 * OpenAI-shaped provider instead of naming a model.
 *
 * The ceiling itself is not given up. The caller's own Zod schema still
 * rejects an over-long answer, so the bound moves from decode time to
 * validation time and the contract is unchanged.
 *
 * Only subschema positions are walked. A `maxLength` sitting in a name map
 * (`properties`, `patternProperties`) is a caller's field name, and one inside
 * `enum`, `const` or `default` is a literal value: both are data this must not
 * touch. Sourcery caught the first on PR #304; the second was the same bug one
 * position over.
 */
function stripLengthCeilings(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripLengthCeilings);
  if (!isUnknownRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "maxLength") continue;
    if (SCHEMA_NAME_MAPS.has(key) && isUnknownRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, stripLengthCeilings(sub)]),
      );
      continue;
    }
    out[key] = SCHEMA_VALUED.has(key) ? stripLengthCeilings(value) : value;
  }
  return out;
}

/**
 * Whether a model id names a Google model, whichever provider fronts it.
 * Their upstream rejects JSON Schema keywords the OpenAI shape carries.
 */
function geminiFamily(model: string): boolean {
  return /(^|\/)(google\/)?(gemini|gemma)/i.test(model);
}

/**
 * Abbreviate every property name in a JSON Schema, and say how to undo it.
 *
 * One alias per distinct property name across the whole schema, so a name that
 * appears at several depths abbreviates the same way and the answer can be
 * restored without tracking position. Initials of the name's words, extended
 * on collision.
 */
function compactWireSchema(source: JsonObject): { schema: JsonObject; names: Map<string, string> } {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const aliasFor = (name: string): string => {
    const existing = names.get(name);
    if (existing) return existing;
    const initials = name
      .split(/(?=[A-Z])|_/)
      .filter(Boolean)
      .map((word) => word[0]!.toLowerCase())
      .join("");
    const base = initials.length >= 2 ? initials : name.slice(0, 2).toLowerCase();
    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate)) candidate = `${base}${String(++suffix)}`;
    taken.add(candidate);
    names.set(name, candidate);
    return candidate;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isUnknownRecord(value)) {
        const renamed: JsonObject = {};
        for (const [property, sub] of Object.entries(value))
          renamed[aliasFor(property)] = walk(sub);
        out[key] = renamed;
        continue;
      }
      if (key === "required" && isUnknownArray(value)) {
        out[key] = value.map((name) => (typeof name === "string" ? aliasFor(name) : name));
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };
  const schema = walk(source) as JsonObject;
  return { schema, names };
}

/** Put the caller's own property names back on an answer sent with aliases. */
function expandWireNames(answer: unknown, names: Map<string, string>): unknown {
  const back = new Map([...names].map(([long, short]) => [short, long]));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) out[back.get(key) ?? key] = walk(value);
    return out;
  };
  return walk(answer);
}

/** The legend the model needs to answer in the abbreviated shape. */
function wireNameLegend(names: Map<string, string>): string {
  return ` The result's field names are abbreviated: ${[...names]
    .map(([long, short]) => `${short}=${long}`)
    .join(", ")}. Use the abbreviated names exactly.`;
}

function geminiWireSchema(source: WireSchema): JsonObject {
  const converted = zodToJsonSchema(source, {
    target: "openApi3",
    $refStrategy: "none",
  }) as JsonObject;
  return stripUnsupportedKeys(converted) as JsonObject;
}

function stripUnsupportedKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripUnsupportedKeys);
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "additionalProperties") {
        continue;
      }
      out[key] = stripUnsupportedKeys(value);
    }
    return out;
  }
  return node;
}

/** The call context every failure at this seam is classified against. */
function modelCall(cfg: LlmConfig, binding: ResultShapeBinding): ModelCall {
  return { provider: cfg.provider, model: cfg.model, binding };
}

async function postJson(
  call: ModelCall,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadline: RequestDeadline,
): Promise<HttpResponse> {
  deadline.calling(call);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw modelBoundaryFailure({
        call,
        classification: "request_timeout",
        timeoutMs: deadline.absoluteCeilingMs,
      });
    }
    throw modelBoundaryFailure({ call, classification: "transport_failure" });
  }
}

/**
 * POST one OpenAI-shaped chat completion as an SSE stream and read it back as
 * the plain completion `postJson` would have returned, so everything above the
 * transport — classification, binding extraction — is unchanged. Activity is a
 * token-bearing `data:` event: the keep-alive comments OpenRouter sends
 * between events (`: OPENROUTER PROCESSING`) prove a route, not a model, so
 * they do not reset the idle timer. Errors before the stream starts are plain
 * non-2xx JSON and take the same classification path as `postJson`; errors
 * mid-generation arrive as `data:` events carrying an `error` field.
 */
async function postSseStream(
  call: ModelCall,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadline: RequestDeadline,
): Promise<HttpResponse> {
  deadline.calling(call);
  /* The idle timer owns the wire; the seam's ceiling aborts the same wire, so
     either one ends the fetch, and the abort's origin names the timeout. */
  const idle = new AbortController();
  const onOuterAbort = (): void => idle.abort();
  deadline.signal.addEventListener("abort", onOuterAbort, { once: true });
  /* Two questions, two ceilings. `connection` asks whether the upstream is
     still there at all and is reset by any byte; `progress` asks whether it is
     producing an answer and is reset only by answer tokens. A buffering
     upstream keeps the first alive with keepalives while it generates, which
     is why the first alone used to abort work that was succeeding (#232). */
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let firedCeiling: number | null = null;
  const armConnection = (): void => {
    clearTimeout(connectionTimer);
    connectionTimer = setTimeout(() => {
      firedCeiling ??= STREAM_IDLE_TIMEOUT_MS;
      idle.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const armIdle = (): void => {
    armConnection();
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      firedCeiling ??= STREAM_SILENT_TIMEOUT_MS;
      idle.abort();
    }, STREAM_SILENT_TIMEOUT_MS);
  };
  armIdle();
  /* `upstreamServer` is observation, not control: OpenRouter names the route
     serving this call on every chunk, and a stalled stream otherwise leaves no
     trace of which of a model's many upstreams was answering (#232). */
  const observed: { status?: number; bodyBytes: number; upstreamServer?: string } = {
    bodyBytes: 0,
  };
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: idle.signal,
      });
      observed.status = response.status;
      deadline.observed({ status: response.status, bodyBytes: 0 });
    } catch (error) {
      throw requestTimeoutOrTransport(
        call,
        deadline.signal,
        deadline.absoluteCeilingMs,
        error,
        observed,
        firedCeiling,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      /* Classify exactly like postJson: the refusal body carries the facts. */
      return { status: response.status, text: await response.text() };
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw modelBoundaryFailure({ call, classification: "transport_failure" });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map<
      number,
      {
        id: string;
        type: string;
        name: string;
        arguments: string;
        hasFunction: boolean;
        hasArguments: boolean;
        checked: number;
      }
    >();
    let finishReason: string | null = null;
    /* Reasoning never enters the answer or a diagnostic, but its size is
       shape, and an answer's size is what the overrun ceiling measures. */
    let reasoningChars = 0;
    /* The answer surfaces are re-tested for degenerate repetition only after
       this much new text, so a trickle of one-character deltas does not
       rescan the whole answer per token. */
    let contentChecked = 0;
    const seen = { data: false };
    /* Usage accounting rides the final frame (OpenRouter) or per-frame
       fingerprint fields; both are recorded, never parsed as answer. Held in
       an object because closures write them and CFA cannot see that. */
    const captured: {
      usage: Record<string, unknown> | null;
      fingerprint: string | null;
    } = { usage: null, fingerprint: null };
    /** Fail the attempt once an answer surface repeats itself without finishing. */
    const checkDegenerate = (answer: string, checked: number): number => {
      if (answer.length - checked < REPEAT_CHECK_STEP) return checked;
      if (degenerateRepeat(answer)) {
        throw modelBoundaryFailure({
          call,
          classification: "repetition_loop",
          status: response.status,
          bodyBytes: observed.bodyBytes,
          ...(observed.upstreamServer ? { upstreamServer: observed.upstreamServer } : {}),
        });
      }
      return answer.length;
    };
    const consume = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith(":")) return false;
      if (!trimmed.startsWith("data:")) return false;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return true;
      seen.data = true;
      const chunk = tryParse(data);
      if (chunk === undefined) return false;
      if (carriesUpstreamError(chunk)) {
        throw modelBoundaryFailure({
          call,
          classification: "upstream_error",
          status: response.status,
          body: data,
          payload: chunk,
        });
      }
      if (typeof chunk !== "object" || chunk === null) return false;
      /* Every chunk names the route serving this call; the first one to do so
         is enough, and the name is a route identifier, never content. */
      if (
        observed.upstreamServer === undefined &&
        "provider" in chunk &&
        typeof chunk.provider === "string" &&
        chunk.provider !== ""
      )
        observed.upstreamServer = chunk.provider;
      const frame = chunk as JsonObject;
      const usageFrame = usageRecord(frame.usage);
      if (usageFrame !== null) captured.usage = usageFrame;
      const fingerprint = usageName(
        usageRecord(usageRecord(frame.choices)?.[0])?.system_fingerprint,
      );
      if (fingerprint !== null) captured.fingerprint = fingerprint;
      if (!("choices" in chunk)) return false;
      const choices = chunk.choices;
      if (!isUnknownArray(choices) || choices.length === 0) return false;
      const choice = choices[0];
      if (typeof choice !== "object" || choice === null) return false;
      if ("delta" in choice && typeof choice.delta === "object" && choice.delta !== null) {
        const delta = choice.delta;
        if ("content" in delta && typeof delta.content === "string" && delta.content.length) {
          content += delta.content;
          armIdle();
        }
        /* Reasoning tokens establish activity but their contents never enter
           the answer or diagnostics. Transport comments establish neither. */
        if (carriesReasoningActivity(delta)) {
          reasoningChars += reasoningLength(delta);
          armIdle();
        }
        if ("tool_calls" in delta && isUnknownArray(delta.tool_calls)) {
          for (const [position, toolCall] of delta.tool_calls.entries()) {
            if (typeof toolCall !== "object" || toolCall === null) continue;
            /* Indices identify streams, not arrival order. Older compatible
               responses omit them; their array position supplies the index. */
            const index = "index" in toolCall ? toolCall.index : position;
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
            const accumulated = toolCalls.get(index) ?? {
              id: "",
              type: "",
              name: "",
              arguments: "",
              hasFunction: false,
              hasArguments: false,
              checked: 0,
            };
            toolCalls.set(index, accumulated);
            if ("id" in toolCall && typeof toolCall.id === "string") accumulated.id += toolCall.id;
            if ("type" in toolCall && typeof toolCall.type === "string")
              accumulated.type = toolCall.type;
            if (!("function" in toolCall)) continue;
            const fn = toolCall.function;
            if (typeof fn !== "object" || fn === null) continue;
            accumulated.hasFunction = true;
            if ("name" in fn && typeof fn.name === "string") accumulated.name += fn.name;
            if ("arguments" in fn && typeof fn.arguments === "string") {
              accumulated.hasArguments = true;
              accumulated.arguments += fn.arguments;
              if (fn.arguments.length) armIdle();
            }
          }
        }
      }
      if ("finish_reason" in choice && typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      return false;
    };
    let done = false;
    for (;;) {
      const read = await readChunk(reader);
      if (!read.ok) {
        /* The abort's origin names the timeout: the seam's ceiling or the idle
           timer — which, before the first token, is also the first-token cap. */
        throw requestTimeoutOrTransport(
          call,
          deadline.signal,
          deadline.absoluteCeilingMs,
          read.error,
          observed,
          firedCeiling,
        );
      }
      if (read.chunk.done) break;
      observed.bodyBytes += read.chunk.value.byteLength;
      /* Any byte answers the connection question, whatever it carries. It
         does not answer the progress question, so the second ceiling still
         bounds an upstream that stays connected and never produces one. */
      armConnection();
      deadline.observed({
        status: response.status,
        bodyBytes: observed.bodyBytes,
        /* Carried outwards so the absolute ceiling, which fires from outside
           this stream, can still name the route that spent the whole call. */
        ...(observed.upstreamServer ? { upstreamServer: observed.upstreamServer } : {}),
      });
      buffer += decoder.decode(read.chunk.value, { stream: true });
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (consume(line)) {
          done = true;
          break;
        }
      }
      /* A finished stream is never scanned: a close the provider sent is the
         answer, and garbage in it is the schema's and judge's to catch. An
         open stream gets its answer surfaces scanned for degenerate
         repetition. */
      if (done) break;
      contentChecked = checkDegenerate(content, contentChecked);
      for (const toolCall of toolCalls.values())
        toolCall.checked = checkDegenerate(toolCall.arguments, toolCall.checked);
      /* A route that will not stop costs the operation as surely as one that
         will not start. The repetition detector above catches an answer that
         repeats itself; this catches one that runs away without repeating, and
         hands what is left of the budget to the next attempt (ADR-0070). It
         counts the answer, not the wire: a route that streams one token per
         event spends far more envelope than answer, and a byte ceiling would
         end its legitimate answers first (#233). */
      let answerChars = content.length + reasoningChars;
      for (const toolCall of toolCalls.values()) answerChars += toolCall.arguments.length;
      if (answerChars > STREAM_MAX_ANSWER_CHARS) {
        throw modelBoundaryFailure({
          call,
          classification: "answer_overrun",
          status: response.status,
          bodyBytes: observed.bodyBytes,
          ...(observed.upstreamServer ? { upstreamServer: observed.upstreamServer } : {}),
        });
      }
    }
    let message: JsonObject = { role: "assistant", content };
    if (call.binding === "forced_tool_call") {
      /* Reconstruct the provider's array in index order. The existing reader
         selects its first call, exactly as for nonstreamed replies; malformed
         first arguments never borrow from a later call or select its answer. */
      /* Content is kept rather than nulled. An upstream that ignores a forced
         tool call and answers in `content` has still answered, and discarding
         it left the diagnostic saying every field was empty when one was not
         (#232). The reader still looks only in the binding's own field. */
      message = {
        role: "assistant",
        content: content || null,
        tool_calls: [...toolCalls]
          .sort(([a], [b]) => a - b)
          .map(([, toolCall]) => ({
            ...(toolCall.id ? { id: toolCall.id } : {}),
            ...(toolCall.type ? { type: toolCall.type } : {}),
            ...(toolCall.hasFunction
              ? {
                  function: {
                    ...(toolCall.name ? { name: toolCall.name } : {}),
                    ...(toolCall.hasArguments ? { arguments: toolCall.arguments } : {}),
                  },
                }
              : {}),
          })),
      };
    }
    /* A stream that ended without a single token is an empty body, and is
       classified as one — not as an answer that said nothing. */
    if (!seen.data) return { status: response.status, text: "" };
    return {
      status: 200,
      text: JSON.stringify({
        ...(observed.upstreamServer ? { provider: observed.upstreamServer } : {}),
        ...(captured.usage !== null && Object.keys(captured.usage).length > 0
          ? { usage: captured.usage }
          : {}),
        ...(captured.fingerprint !== null ? { system_fingerprint: captured.fingerprint } : {}),
        choices: [{ index: 0, message, finish_reason: finishReason }],
      }),
    };
  } finally {
    clearTimeout(connectionTimer);
    clearTimeout(progressTimer);
    idle.abort();
    deadline.signal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * OpenRouter streams reasoning as text, an alias, or typed detail deltas.
 * Only actual nonblank payload establishes activity; signatures and indices
 * alone do not. This predicate never assembles or retains reasoning.
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
function carriesReasoningActivity(delta: object): boolean {
  const nonblank = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if ("reasoning" in delta && nonblank(delta.reasoning)) return true;
  if ("reasoning_content" in delta && nonblank(delta.reasoning_content)) return true;
  if (!("reasoning_details" in delta) || !isUnknownArray(delta.reasoning_details)) return false;
  return delta.reasoning_details.some((detail) => {
    if (typeof detail !== "object" || detail === null || !("type" in detail)) return false;
    return (
      (detail.type === "reasoning.text" && "text" in detail && nonblank(detail.text)) ||
      (detail.type === "reasoning.summary" && "summary" in detail && nonblank(detail.summary)) ||
      (detail.type === "reasoning.encrypted" && "data" in detail && nonblank(detail.data))
    );
  });
}

/**
 * How much reasoning text one delta carried, by length alone. The text itself is
 * never retained: a count is shape, the words are not.
 */
function reasoningLength(delta: object): number {
  const length = (value: unknown) => (typeof value === "string" ? value.length : 0);
  let total = 0;
  if ("reasoning" in delta) total += length(delta.reasoning);
  if ("reasoning_content" in delta) total += length(delta.reasoning_content);
  if ("reasoning_details" in delta && isUnknownArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details) {
      if (typeof detail !== "object" || detail === null) continue;
      if ("text" in detail) total += length(detail.text);
      if ("summary" in detail) total += length(detail.summary);
      if ("data" in detail) total += length(detail.data);
    }
  }
  return total;
}

/** The timeout whose ceiling fired, or a transport fault when neither did. */
function requestTimeoutOrTransport(
  call: ModelCall,
  ceilingSignal: AbortSignal,
  absoluteCeilingMs: number,
  error: unknown,
  observed: { status?: number; bodyBytes: number; upstreamServer?: string } = { bodyBytes: 0 },
  firedCeiling: number | null = null,
): ModelBoundaryError {
  if (ceilingSignal.aborted) {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      timeoutMs: absoluteCeilingMs,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      /* Which of the stream's two ceilings fired: a connection that went
         silent, or one that stayed open without producing an answer. */
      timeoutMs: firedCeiling ?? STREAM_IDLE_TIMEOUT_MS,
    });
  }
  if (isRequestTimeout(error)) {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      timeoutMs: absoluteCeilingMs,
    });
  }
  return modelBoundaryFailure({ ...observed, call, classification: "transport_failure" });
}

/** One stream read, with its failure carried instead of thrown. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    return { ok: true as const, chunk: await reader.read() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return cause.code === "UND_ERR_HEADERS_TIMEOUT" || cause.code === "UND_ERR_BODY_TIMEOUT";
}

/** Whether a provider body carries a failure envelope alongside its 2xx status. */
function carriesUpstreamError(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = payload.error;
  if (typeof error === "string") return error !== "";
  return typeof error === "object" && error !== null;
}

/**
 * The provider's parsed body, or a classified failure saying why there is none.
 * Providers answer HTTP 200 and carry the failure in the body, so a status check
 * alone reports a response-shape problem for a fault they named exactly.
 */
function parseProviderPayload(call: ModelCall, response: HttpResponse): unknown {
  const parsed = tryParse(response.text);
  if (response.status < 200 || response.status >= 300) {
    /* The body is parsed even here, for the structural facts a refusal carries —
       its top-level keys, the upstream that refused, and the code it gave. */
    throw modelBoundaryFailure({
      call,
      classification: "http_error",
      status: response.status,
      body: response.text,
      payload: parsed,
    });
  }
  if (response.text.trim() === "") {
    throw modelBoundaryFailure({
      call,
      classification: "empty_body",
      status: response.status,
      body: response.text,
    });
  }
  if (parsed === undefined) {
    throw modelBoundaryFailure({
      call,
      classification: "unparseable_body",
      status: response.status,
      body: response.text,
    });
  }
  if (carriesUpstreamError(parsed)) {
    throw modelBoundaryFailure({
      call,
      classification: "upstream_error",
      status: response.status,
      body: response.text,
      payload: parsed,
    });
  }
  return parsed;
}

/** The parsed body, or `undefined` when the text is not JSON. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Where a reply puts the answer, named as far down as the reply actually goes.
 * A failure has to report the fields of the deepest container that arrived,
 * because "the shape was wrong" is exactly what withheld the cause. OpenAI-shaped
 * replies nest it under `choices[0].message` and Gemini under
 * `candidates[0].content`; the walk is the same one.
 */
function locateAnswer(payload: unknown, listKey: string, childKey: string): AnswerContainer {
  if (
    typeof payload === "object" &&
    payload !== null &&
    listKey in payload &&
    isUnknownArray((payload as JsonObject)[listKey])
  ) {
    const list = (payload as JsonObject)[listKey] as unknown[];
    const first = list.length > 0 ? list[0] : null;
    if (typeof first === "object" && first !== null) {
      return childKey in first
        ? { path: `${listKey}[0].${childKey}`, value: (first as JsonObject)[childKey] }
        : { path: `${listKey}[0]`, value: first };
    }
  }
  return { path: "", value: payload };
}

/** Read `choices[0].message.content` from an OpenAI-shaped chat completion. */
function readChatCompletionContent(reply: ModelReply, answer: AnswerContainer): string {
  const message = answer.value;
  if (
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    typeof message.content === "string" &&
    message.content !== ""
  ) {
    return message.content;
  }
  throw unusableShape(reply, answer);
}

/** Read the forced tool call's arguments from an OpenAI-shaped chat completion. */
function readToolCallArguments(reply: ModelReply, answer: AnswerContainer): string {
  const message = answer.value;
  if (
    typeof message === "object" &&
    message !== null &&
    "tool_calls" in message &&
    isUnknownArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const first = message.tool_calls[0];
    if (typeof first === "object" && first !== null && "function" in first) {
      const fn = first.function;
      if (
        typeof fn === "object" &&
        fn !== null &&
        "arguments" in fn &&
        typeof fn.arguments === "string"
      ) {
        return fn.arguments;
      }
    }
  }
  throw unusableShape(reply, answer);
}

/** The Result Shape from an OpenAI-shaped reply, out of whichever field the binding used. */
function readChatResultShape(reply: ModelReply): unknown {
  const answer = locateAnswer(reply.payload, "choices", "message");
  const text =
    reply.call.binding === "forced_tool_call"
      ? readToolCallArguments(reply, answer)
      : readChatCompletionContent(reply, answer);
  return parseAnswer(reply, answer, text);
}

/** The Result Shape from a Gemini reply, which always arrives as text. */
function readGeminiResultShape(reply: ModelReply): unknown {
  const answer = locateAnswer(reply.payload, "candidates", "content");
  return parseAnswer(reply, answer, readGeminiText(reply, answer));
}

/** Read the first `tool_use` block's input from an Anthropic messages response. */
function readToolUseInput(reply: ModelReply): unknown {
  const payload = reply.payload;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    isUnknownArray(payload.content)
  ) {
    for (const block of payload.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_use" &&
        "input" in block
      ) {
        return block.input;
      }
    }
  }
  /* The blocks are an array, so the body itself is the deepest named container. */
  throw unusableShape(reply, { path: "", value: payload });
}
/** Read `candidates[0].content.parts[0].text` from a Gemini response. */
function readGeminiText(reply: ModelReply, answer: AnswerContainer): string {
  const content = answer.value;
  if (
    typeof content === "object" &&
    content !== null &&
    "parts" in content &&
    isUnknownArray(content.parts) &&
    content.parts.length > 0
  ) {
    const part = content.parts[0];
    if (
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text !== ""
    ) {
      return part.text;
    }
  }
  throw unusableShape(reply, answer);
}

function unusableShape(reply: ModelReply, answer: AnswerContainer): ModelBoundaryError {
  return modelBoundaryFailure({
    call: reply.call,
    classification: "unusable_shape",
    status: reply.response.status,
    body: reply.response.text,
    payload: reply.payload,
    answer,
  });
}

/**
 * The answer as JSON. The parse error is deliberately not carried: it quotes the
 * text it choked on, and that text is the model's reply to a private transcript.
 */
function parseAnswer(reply: ModelReply, answer: AnswerContainer, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw modelBoundaryFailure({
      call: reply.call,
      classification: "answer_not_json",
      status: reply.response.status,
      body: reply.response.text,
      payload: reply.payload,
      answer,
    });
  }
}

async function openaiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "response_format");
  const response = await postJson(
    call,
    "https://api.openai.com/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      /* Best-effort reproducibility: hosted inference stays non-deterministic
         even with a seed, so the fingerprint is recorded beside it. */
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction_result", strict: true, schema },
      },
    },
    deadline,
  );
  const reply = modelReply(call, response);
  fireUsage(deadline, call, openAiUsage(reply.payload));
  return readChatResultShape(reply);
}

async function anthropicComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "forced_tool_call");
  const response = await postJson(
    call,
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: cfg.model,
      max_tokens: 8192,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      tools: [
        {
          name: "save_extraction",
          description: "Save the extraction result.",
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "save_extraction" },
    },
    deadline,
  );
  const reply = modelReply(call, response);
  fireUsage(deadline, call, anthropicUsage(reply.payload));
  return readToolUseInput(reply);
}

async function geminiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  responseSchema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "response_format");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const response = await postJson(
    call,
    url,
    {},
    {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
      },
    },
    deadline,
  );
  const reply = modelReply(call, response);
  fireUsage(deadline, call, geminiUsage(reply.payload));
  return readGeminiResultShape(reply);
}

/**
 * The prompt-only binding has no provider-side shape constraint, so the Result
 * Shape itself travels in the prompt: the field descriptions alone leave the
 * model without the schema. Provider-constrained bindings keep the Module's
 * prompt verbatim — the shape rides in response_format or in the tool's
 * parameters.
 */
function promptOnlySystem(system: string, schema: JsonObject): string {
  return `${system}\n\nReturn exactly one JSON object matching this schema, and nothing else — no prose, no markdown fences, no fields beyond it:\n${JSON.stringify(schema, null, 2)}`;
}

/** The OpenAI-shaped chat-completion body that asks for one Result Shape Binding. */
function chatCompletionBody(
  binding: ResultShapeBinding,
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  reasoning: { effort?: string } | null,
): JsonObject {
  const body: JsonObject = {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content:
          binding === "prompt_only" ? promptOnlySystem(request.system, schema) : request.system,
      },
      { role: "user", content: request.user },
    ],
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  /* Best-effort reproducibility, OpenAI family only: the other wires have no
     seed parameter, and Anthropic's is a fixed zero by another name. */
  if (request.seed !== undefined && (cfg.provider === "openai" || cfg.provider === "openrouter"))
    body.seed = request.seed;
  /* Thinking budget, OpenRouter only: thinking off the wire always, and the
     resolved effort level when the model advertises it. Other providers never
     see this object. */
  if (reasoning !== null && cfg.provider === "openrouter")
    body.reasoning = {
      exclude: true,
      ...(reasoning.effort !== undefined ? { effort: reasoning.effort } : {}),
    };
  if (binding === "response_format") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction_result", strict: true, schema },
    };
  }
  if (binding === "forced_tool_call") {
    body.tools = [
      {
        type: "function",
        function: {
          name: "save_extraction",
          description: "Save the extraction result.",
          parameters: schema,
        },
      },
    ];
    body.tool_choice = { type: "function", function: { name: "save_extraction" } };
  }
  return body;
}

/**
 * Which routes cost a call, and when each may be asked again.
 *
 * OpenRouter serves one model from many upstream routes, and `sort: "throughput"`
 * lets each call land on a different one. They do not fail alike: on the
 * configured model one route answered a degenerate repetition loop of 6.7 MB,
 * five answered HTTP 429, and one buffered its whole answer past every ceiling,
 * while others completed the same request in 84 seconds (#233). Routing back
 * into a route that just burned a 300-second operation spends the operation
 * again, so a route that fails that way rests and the next call asks OpenRouter
 * to skip it.
 *
 * The precedent is `createPublicSearch`, which rests a refusing search provider
 * rather than retrying it. State is process-wide for the reason the search
 * cooldowns are app-wide: one account meets every route's capacity, so a rest
 * one Stage learns is a rest every Stage owes. `makeCompleteJson` is rebuilt per
 * attempt, so this cannot live in its closure either.
 */
const routeRest = new Map<string, number>();

/** How long a route that burned a call rests before it is asked again. Exported for condition records. */
export const ROUTE_COOLDOWN_MS = 900_000;

/**
 * The most routes that may rest at once, newest first. `provider.ignore`
 * narrows routing, and a model served by few endpoints could be narrowed to
 * none; a bounded list keeps a bad stretch from leaving nowhere to route.
 * Exported for condition records.
 */
export const MAX_RESTING_ROUTES = 8;

/**
 * Descriptor of the `restFailedRoute` predicate below, recorded in benchmark
 * conditions so a rest-policy change across assessments is a visible condition
 * diff. Keep in sync with the predicate.
 */
export const ROUTE_REST_POLICY =
  "repetition_loop, answer_overrun, request_timeout, 429 http_error, absent-or-500-plus upstream_error";

/** Rests are per model and route: a route can serve one model well and another badly. */
function routeRestKey(model: string, route: string): string {
  return `${model}\u0000${route}`;
}

/** The routes resting for this model, most recently rested first, bounded. */
function restingRoutes(model: string): string[] {
  const now = Date.now();
  const prefix = `${model}\u0000`;
  const resting: { route: string; until: number }[] = [];
  for (const [key, until] of routeRest) {
    if (until <= now) {
      routeRest.delete(key);
      continue;
    }
    if (key.startsWith(prefix)) resting.push({ route: key.slice(prefix.length), until });
  }
  return resting
    .sort((left, right) => right.until - left.until)
    .slice(0, MAX_RESTING_ROUTES)
    .map((entry) => entry.route);
}

/**
 * Rest the route that served a failed call, where the failure belongs to the
 * route rather than to the request. A stalled stream, a repetition loop, a
 * capacity refusal and an accepted-then-failed upstream error all say this
 * route cannot serve this call now; a refused binding, an unusable answer
 * shape, or an upstream error naming a 4xx fault says the request is wrong,
 * and it would be wrong on every route, so those rest nothing.
 */
function restFailedRoute(model: string, diagnostic: ModelBoundaryDiagnostic | null): void {
  const route = diagnostic?.upstreamServer;
  if (!diagnostic || route === null || route === undefined || route === "") return;
  const routeFailed =
    diagnostic.classification === "repetition_loop" ||
    diagnostic.classification === "answer_overrun" ||
    diagnostic.classification === "request_timeout" ||
    (diagnostic.classification === "http_error" && diagnostic.status === 429) ||
    (diagnostic.classification === "upstream_error" &&
      (diagnostic.upstreamCode === null || diagnostic.upstreamCode >= 500));
  if (!routeFailed) return;
  routeRest.set(routeRestKey(model, route), Date.now() + ROUTE_COOLDOWN_MS);
}

/**
 * Drop every rest this model is carrying.
 *
 * ADR-0068 bounds the rest list so "a bad stretch cannot narrow a model served
 * by few endpoints down to none", but it spends a constant eight on a question
 * only the model's own endpoint count can answer: the configured
 * `inception/mercury-2.5-preview` is served by exactly one route, so the first
 * rest is already the whole pool. Rather than learn the count — a catalogue
 * lookup ADR-0068 rejected as a label that goes stale — the seam lets routing
 * tell it, and gives the rests up the moment they are what stands between the
 * call and a route.
 */
function clearRests(model: string): void {
  const prefix = `${model}\u0000`;
  for (const key of [...routeRest.keys()]) if (key.startsWith(prefix)) routeRest.delete(key);
}

/**
 * The bindings one call may use, in the order it will try them.
 *
 * `chosen` is what the model declared support for, or `null` when there is no
 * declaration to read — which is not the same as declaring no support, and is
 * the only case that permits the ordinary refusal step-down.
 */
interface DeclaredBindings {
  chosen: ResultShapeBinding | null;
  ladder: readonly ResultShapeBinding[];
}

/** Whether a declaration covers one binding. Prompt-only asks nothing of the provider. */
function declares(declared: Set<string>, binding: ResultShapeBinding): boolean {
  if (binding === "response_format")
    return declared.has("structured_outputs") || declared.has("response_format");
  if (binding === "forced_tool_call") return declared.has("tools") && declared.has("tool_choice");
  return true;
}

/**
 * OpenAI-shaped chat completion, shared by OpenRouter and Ollama: both front
 * many models, and those models differ in which Result Shape Bindings they
 * support. The binding is chosen by the caller from what the model declares.
 */
async function openAiCompatibleComplete(
  url: string,
  headers: Record<string, string>,
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  declared: DeclaredBindings,
  deadline: RequestDeadline,
  stream: boolean,
): Promise<unknown> {
  /* A declared binding is sent first, then the other bindings the same
     declaration covers, then prompt-only. An unknown declaration walks the
     whole ladder from the most deterministic binding down, because a model
     that refuses a JSON Schema may still honour a tool call.
 
     The walk is over candidates, not over the ladder's own indices: a declared
     `forced_tool_call` used to step to whatever followed it, which skipped
     `response_format` entirely — and `response_format` is the binding measured
     to stream incrementally on the very routes that buffer a tool call past
     the ceilings (#233). */
  const ladder = declared.ladder;
  let index = 0;
  /* The rests may be given up once per call. `routeRest` is process-wide and
     operations run concurrently, so a peer operation can rest the route again
     between the clear and the retry; without this latch that pair of calls
     trades 404s until the request deadline expires rather than the ladder
     making progress. One clear is all the recovery needs — after it, an empty
     `ignore` means a further 404 is the route's own answer. */
  let restsGivenUp = false;
  let retried = false;
  let recoveryFailure: { error: unknown } | null = null;
  /* Thinking budget, resolved once per call: reasoning streams are metered
     output that can outgrow the answer ceilings, so every OpenRouter call
     asks for the effort it was configured with (default low) while keeping
     the thinking itself off the wire. Models that advertise no effort list
     resolve to no effort level — the provider default applies, exactly as
     before. Other providers are untouched. */
  const reasoningEffort =
    cfg.provider === "openrouter"
      ? resolveReasoningEffort(
          request.reasoningEffort,
          await openrouterReasoningCatalogue(cfg, deadline.signal),
          cfg.model,
        )
      : undefined;
  deadline.reasoningEffort = reasoningEffort;
  const reasoning: { exclude: true; effort?: string } | null =
    cfg.provider === "openrouter"
      ? {
          exclude: true,
          ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
        }
      : null;
  for (;;) {
    /* Every recovery route crosses this fence, including binding changes and
       cancellation triggered by the observer of the previous attempt. */
    if (recoveryFailure && request.retry?.canRetry?.() === false) {
      deadline.reportAttempt({
        outcome: "failed",
        diagnostic: modelBoundaryDiagnostic(recoveryFailure.error) ?? null,
        delayMs: 0,
        stoppedReason: "Retry cancelled by caller.",
      });
      throw recoveryFailure.error;
    }
    const call = modelCall(cfg, ladder[index] ?? "prompt_only");
    const body = chatCompletionBody(call.binding, cfg, request, schema, reasoning);
    /* What this attempt asked routing to skip, so a refusal can be read as the
       rests' doing rather than the binding's. */
    let skippedRoutes: string[] = [];
    if (stream) body.stream = true;
    /* OpenRouter unions endpoint declarations across a model's routes, so a
       declared binding is not a promise that any single route honours the
       whole body. `require_parameters` used to hold routing to routes that
       declare everything — but it answers HTTP 404 naming the very parameter
       the metadata declares, and a model that answers in under a second
       without it never got asked at all (#232). The step-down ladder handles
       a route that refuses the binding, so routing asks for throughput
       instead: the same model measured 28 tokens/second on one route and
       66-75 on another. Sorting is OpenRouter's own continuous measurement;
       naming a route here would be a catalogue label that goes stale. */
    if (cfg.provider === "openrouter") {
      /* Sorting alone chooses among routes by throughput; it does not know
         which of them just cost this model an operation. The rests do, and
         they ride along as `ignore` — verified to accept the very name the
         stream reports as its serving `provider`, so no catalogue lookup and
         no name mapping stands between the observation and the control. A
         requested throughput floor rides beside both: routes below it are
         deprioritized, never excluded, so it steers the first attempt onto a
         fast route without ever refusing the call a home (#233). */
      const resting = restingRoutes(cfg.model);
      const provider: Record<string, unknown> = { sort: "throughput" };
      if (request.preferredMinThroughput !== undefined)
        provider.preferred_min_throughput = request.preferredMinThroughput;
      if (resting.length > 0) provider.ignore = resting;
      body.provider = provider;
      skippedRoutes = resting;
      deadline.providerIgnore = resting.length > 0 ? [...resting] : undefined;
    } else {
      deadline.providerIgnore = undefined;
    }
    let response: HttpResponse;
    try {
      response = await (stream
        ? postSseStream(call, url, headers, body, deadline)
        : postJson(call, url, headers, body, deadline));
    } catch (error) {
      const diagnostic = modelBoundaryDiagnostic(error) ?? null;
      if (cfg.provider === "openrouter") restFailedRoute(cfg.model, diagnostic);
      /* An upstream out of capacity is retried on the same binding: the
         refusal is about the moment, not about the request, and the route that
         gave it has not stopped serving (ADR-0066, ADR-0068). The timeout arm
         stays narrower on purpose — the absolute request ceiling has already
         spent the deadline a retry would need, so `isUpstreamCapacityRefusal`
         is asked rather than `isModelCapacityFailure`, whose broader timeout
         branch would retry exactly that exhausted case. */
      const retryable =
        diagnostic?.classification === "transport_failure" ||
        isUpstreamCapacityRefusal(error) ||
        (diagnostic?.classification === "request_timeout" &&
          (diagnostic.timeoutMs === STREAM_IDLE_TIMEOUT_MS ||
            diagnostic.timeoutMs === STREAM_SILENT_TIMEOUT_MS));
      if (request.retry && retryable) {
        let stoppedReason = deadline.signal.aborted
          ? "The original request deadline expired."
          : request.retry.canRetry?.() === false
            ? "Retry cancelled by caller."
            : retried
              ? "The one additional same-binding retry was exhausted."
              : deadline.timeRemaining() < STREAM_IDLE_TIMEOUT_MS + 500
                ? "Insufficient original deadline for backoff and another idle window."
                : null;
        if (!stoppedReason) {
          retried = true;
          deadline.reportAttempt({
            outcome: "retrying",
            diagnostic,
            delayMs: 500,
            stoppedReason: null,
          });
          await retryBackoff(deadline.signal);
          stoppedReason = deadline.signal.aborted
            ? "The original request deadline expired."
            : request.retry.canRetry?.() === false
              ? "Retry cancelled by caller."
              : deadline.timeRemaining() < STREAM_IDLE_TIMEOUT_MS
                ? "Insufficient original deadline for another idle window."
                : null;
          if (!stoppedReason) {
            recoveryFailure = { error };
            continue;
          }
        }
        deadline.reportAttempt({ outcome: "failed", diagnostic, delayMs: 0, stoppedReason });
        throw error;
      }
      /* ADR-0064 permits recovery from sustained answer repetition even on a
         declared binding, and an answer that runs away without repeating is
         the same fact observed a different way (ADR-0070). The next binding
         gets the call's remaining budget; the final binding preserves the
         failure it was given. */
      if (
        index < ladder.length - 1 &&
        !deadline.signal.aborted &&
        RUNAWAY_ANSWER.has(modelBoundaryDiagnostic(error)?.classification ?? "")
      ) {
        deadline.reportAttempt({
          outcome: "retrying",
          diagnostic,
          delayMs: 0,
          stoppedReason: null,
        });
        recoveryFailure = { error };
        index += 1;
        continue;
      }
      throw error;
    }
    /* A declaration keeps its meaning: a model that declares a binding and then
       refuses it surfaces that refusal rather than silently degrading. A
       routing refusal is different in kind — no model saw the request, because
       OpenRouter's union of endpoint declarations promised a binding no single
       route honours — so it steps down whatever the declaration said (#232).
       The refusal is read off the 404 status alone: OpenRouter's body wording
       varies with what its routing pool happened to say that day, so it is
       not a contract to match against (#271). */
    /* A 404 while this attempt carried `ignore` is not the route refusing the
       binding — it is routing reporting that the rests left it nowhere to go,
       and stepping the ladder down answers a question no route was ever asked.
       The discriminator is what the attempt sent, not how the body was worded:
       #271 established that OpenRouter's wording varies with its routing pool
       and is not a contract to match against. Giving the rests up costs at
       most a repeat of the failure that earned them; keeping them costs every
       remaining call in the operation (#228). */
    if (
      cfg.provider === "openrouter" &&
      response.status === 404 &&
      skippedRoutes.length > 0 &&
      !restsGivenUp
    ) {
      restsGivenUp = true;
      clearRests(cfg.model);
      deadline.reportAttempt({
        outcome: "retrying",
        diagnostic:
          modelBoundaryDiagnostic(
            modelBoundaryFailure({
              call,
              classification: "http_error",
              status: response.status,
              body: response.text,
            }),
          ) ?? null,
        delayMs: 0,
        stoppedReason: null,
      });
      continue;
    }
    if (
      index < ladder.length - 1 &&
      (response.status === 404 ||
        (declared.chosen === null && refusesBinding(call.binding, response)))
    ) {
      const failure = modelBoundaryFailure({
        call,
        classification: "http_error",
        status: response.status,
        body: response.text,
      });
      deadline.reportAttempt({
        outcome: "retrying",
        diagnostic: modelBoundaryDiagnostic(failure) ?? null,
        delayMs: 0,
        stoppedReason: null,
      });
      recoveryFailure = { error: failure };
      index += 1;
      continue;
    }
    try {
      const reply = modelReply(call, response);
      fireUsage(deadline, call, openAiUsage(reply.payload));
      return readChatResultShape(reply);
    } catch (error) {
      /* Two measured signatures say the answer is unusable at this binding and
         ordinary at the next one, so either steps down rather than ending the
         call. Some upstreams answer `finish_reason: stop` with no tool call at
         all under a forced named function, doing the task in content instead
         (gpt-oss-20b, north-mini-code) — unusable shape with content
         populated. And a declared `response_format` whose answer field holds
         prose did the task in the one field the binding does not constrain
         (mercury, eight times in one run — #239's addendum): at that binding a
         non-parsing answer is a binding question, not a dead end. Malformed
         tool-call arguments at a tool binding are different in kind — the
         reader's first-call rule already discarded them deliberately — so
         they keep their report (ADR-0074). */
      const diagnostic = modelBoundaryDiagnostic(error);
      if (cfg.provider === "openrouter") restFailedRoute(cfg.model, diagnostic ?? null);
      const shapeRecoverable =
        (diagnostic?.classification === "answer_not_json" && call.binding === "response_format") ||
        (diagnostic?.classification === "unusable_shape" &&
          /* An answer that is empty everywhere is not going to be better at
             the next binding, and keeps its report. */
          diagnostic.populatedFields.some((field) => field.endsWith(".content")));
      if (index < ladder.length - 1 && !deadline.signal.aborted && shapeRecoverable) {
        deadline.reportAttempt({
          outcome: "retrying",
          diagnostic,
          delayMs: 0,
          stoppedReason: null,
        });
        recoveryFailure = { error };
        index += 1;
        continue;
      }
      throw error;
    }
  }
}

/** Backoff shares the request's deadline and cannot keep an aborted call alive. */
async function retryBackoff(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * The shortest repeated stretch that proves a degenerate answer. The live
 * extraction loop repeated a ~24-character JSON fragment indefinitely, so
 * units up to 64 characters are checked; the shortest test needs 256
 * characters and the proportional minimum of sixteen repeats together keep
 * ordinary varied answers out while any real loop trips within a few hundred
 * characters of the stream.
 */
const REPEAT_MAX_PERIOD = 64;
const REPEAT_MIN_STRETCH = 256;
const REPEAT_MIN_REPEATS = 16;
/** Repetition is re-tested only after this much new answer text has arrived. */
const REPEAT_CHECK_STEP = 64;

function degenerateRepeat(value: string): boolean {
  for (let period = 1; period <= REPEAT_MAX_PERIOD; period++) {
    const stretch = Math.max(REPEAT_MIN_STRETCH, period * REPEAT_MIN_REPEATS);
    if (value.length < stretch) continue;
    const tail = value.slice(-stretch);
    let periodic = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }
  return false;
}

/** Whether a 4xx says the model will not honour the binding that was sent. */
function refusesBinding(binding: ResultShapeBinding, response: HttpResponse): boolean {
  if (response.status < 400 || response.status >= 500) return false;
  if (binding === "response_format") {
    return /response_format|json_schema|structured output/i.test(response.text);
  }
  if (binding === "forced_tool_call") {
    return /tool_choice|tools|function call/i.test(response.text);
  }
  return false;
}

/** What one OpenRouter model says about its own reasoning, if anything. */
interface ModelReasoning {
  /** Advertised effort levels, or null when the model advertises none. */
  efforts: string[] | null;
  /** When true the model rejects effort "none" outright. */
  mandatory: boolean;
}

/** The thinking depth sent when the caller names none. Exported so condition records can cite it. */
export const DEFAULT_REASONING_EFFORT = "low";

/**
 * The whole OpenRouter model catalogue's reasoning metadata, one free read
 * per distinct model per process, shared by concurrent calls through the
 * cached promise. Keyed per model like the declaration cache. A failed fetch
 * resolves to an empty catalogue, which resolves every effort to omitted —
 * today's exact behavior.
 */
const openrouterReasoning = new Map<string, Promise<Map<string, ModelReasoning>>>();

function openrouterReasoningCatalogue(
  cfg: LlmConfig,
  signal: AbortSignal,
): Promise<Map<string, ModelReasoning>> {
  const cached = openrouterReasoning.get(cfg.model);
  if (cached) return cached;
  const pending = fetchReasoningCatalogue(signal);
  openrouterReasoning.set(cfg.model, pending);
  return pending;
}

async function fetchReasoningCatalogue(signal: AbortSignal): Promise<Map<string, ModelReasoning>> {
  const catalogue = new Map<string, ModelReasoning>();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal });
    if (!response.ok) return catalogue;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("data" in payload)) return catalogue;
    if (!isUnknownArray(payload.data)) return catalogue;
    for (const entry of payload.data) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!("id" in entry) || typeof entry.id !== "string" || entry.id === "") continue;
      let efforts: string[] | null = null;
      let mandatory = false;
      if ("reasoning" in entry && typeof entry.reasoning === "object" && entry.reasoning !== null) {
        const reasoning = entry.reasoning;
        if ("supported_efforts" in reasoning && isUnknownArray(reasoning.supported_efforts))
          efforts = reasoning.supported_efforts.filter(
            (value): value is string => typeof value === "string",
          );
        if ("mandatory" in reasoning && reasoning.mandatory === true) mandatory = true;
      }
      catalogue.set(entry.id, { efforts, mandatory });
    }
  } catch {
    return catalogue;
  }
  return catalogue;
}

/**
 * The effort level to actually send, or undefined to send none. Unknown
 * models and unreadable catalogues resolve to omitted — the provider default
 * applies, exactly as before reasoning was sent. An advertised list that
 * lacks the requested level also omits: out-of-list values are undocumented
 * and map unpredictably. Exported so tests reach the contract directly.
 */
export function resolveReasoningEffort(
  requested: string | undefined,
  catalogue: Map<string, ModelReasoning> | null,
  model: string,
): string | undefined {
  const effort = requested ?? DEFAULT_REASONING_EFFORT;
  const metadata = catalogue?.get(model) ?? null;
  if (metadata === null) return undefined;
  if (effort === "none" && metadata.mandatory) return undefined;
  if (metadata.efforts !== null && !metadata.efforts.includes(effort)) return undefined;
  return effort;
}

/**
 * What each model declares, for this process's lifetime. `makeCompleteJson` is
 * rebuilt per attempt, so the cache cannot live in its closure. The promise is
 * cached rather than its result so that concurrent Stages share one lookup.
 */
const openrouterDeclarations = new Map<string, Promise<Set<string> | null>>();

/**
 * The `supported_parameters` an OpenRouter model declares, or `null` when the
 * declaration cannot be read — which is not the same as declaring no support.
 */
function openrouterDeclaredParameters(
  cfg: LlmConfig,
  deadline: RequestDeadline,
): Promise<Set<string> | null> {
  const cached = openrouterDeclarations.get(cfg.model);
  if (cached) return cached;
  const pending = fetchDeclaredParameters(cfg, deadline.signal);
  openrouterDeclarations.set(cfg.model, pending);
  return pending;
}

async function fetchDeclaredParameters(
  cfg: LlmConfig,
  signal: AbortSignal,
): Promise<Set<string> | null> {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${cfg.model}/endpoints`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal,
    });
    if (!response.ok) return null;
    return readDeclaredParameters(await response.json());
  } catch {
    return null;
  }
}

function readDeclaredParameters(payload: unknown): Set<string> | null {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return null;
  const data = payload.data;
  if (typeof data !== "object" || data === null || !("endpoints" in data)) return null;
  if (!isUnknownArray(data.endpoints)) return null;
  const declared = new Set<string>();
  for (const endpoint of data.endpoints) {
    if (
      typeof endpoint !== "object" ||
      endpoint === null ||
      !("supported_parameters" in endpoint) ||
      !isUnknownArray(endpoint.supported_parameters)
    ) {
      continue;
    }
    for (const parameter of endpoint.supported_parameters) {
      if (typeof parameter === "string") declared.add(parameter);
    }
  }
  return declared.size > 0 ? declared : null;
}

/**
 * A supported request preference, otherwise the strongest declared binding —
 * and behind it the rungs that binding may step to, so a failure has somewhere
 * to go. The chosen binding leads; the rest keep the ladder's own order.
 *
 * Two kinds of rung follow it. Everything below it on the ladder, as before —
 * a model that refuses a JSON Schema may still honour a tool call, and
 * prompt-only asks nothing of the provider at all. And anything *above* it the
 * declaration covers, which is new: a request preference for `forced_tool_call`
 * starts the walk halfway down, and stepping only downwards from there skipped
 * `response_format` on a model that declares it. That was not a saving. On the
 * routes that buffer a whole tool call past the ceilings, `response_format` is
 * the binding measured to stream incrementally (#233).
 *
 * A binding the declaration does not cover is never stepped back up to:
 * `readDeclaredParameters` unions every endpoint, so an absence there is an
 * absence everywhere, and a call spent on it is a call spent for nothing.
 */
function declaredBindings(
  declared: Set<string> | null,
  preferred?: CompletionRequest["preferredBinding"],
): DeclaredBindings {
  if (!declared) return { chosen: null, ladder: RESULT_SHAPE_BINDINGS };
  const chosen: ResultShapeBinding =
    preferred === "forced_tool_call" && declares(declared, "forced_tool_call")
      ? "forced_tool_call"
      : declares(declared, "response_format")
        ? "response_format"
        : declares(declared, "forced_tool_call")
          ? "forced_tool_call"
          : "prompt_only";
  const from = RESULT_SHAPE_BINDINGS.indexOf(chosen);
  return {
    chosen,
    ladder: [
      chosen,
      ...RESULT_SHAPE_BINDINGS.filter(
        (binding, index) => binding !== chosen && (index > from || declares(declared, binding)),
      ),
    ],
  };
}

async function openrouterComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  return openAiCompatibleComplete(
    "https://openrouter.ai/api/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    cfg,
    request,
    schema,
    declaredBindings(await openrouterDeclaredParameters(cfg, deadline), request.preferredBinding),
    deadline,
    true,
  );
}

/**
 * A model served locally by Ollama, through its OpenAI-compatible endpoint. No
 * key is needed for a local server, so the auth header is sent only when one is
 * configured (some deployments sit behind a proxy that wants it).
 */
function ollamaComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const base = (cfg.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  return openAiCompatibleComplete(
    `${base}/v1/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    cfg,
    request,
    schema,
    { chosen: null, ladder: RESULT_SHAPE_BINDINGS },
    deadline,
    false,
  );
}

async function mockComplete(mockResultPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(mockResultPath, "utf8"));
  } catch {
    return {
      version: 1,
      sourceId: "",
      sourceFileName: "",
      sourceUrl: null,
      processedAt: new Date().toISOString(),
      isTranscript: false,
      skipReason: "mock: no mock-result.json",
      summary: "",
      tasks: [],
      drafts: [],
    };
  }
}

function initialCall(cfg: LlmConfig): ModelCall {
  return modelCall(cfg, cfg.provider === "anthropic" ? "forced_tool_call" : "response_format");
}

async function withinRequestCeiling<T>(
  cfg: LlmConfig,
  request: CompletionRequest,
  work: (deadline: RequestDeadline) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const ceilingMs = request.absoluteCeilingMs ?? REQUEST_TIMEOUT_MS;
  const expiresAt = Date.now() + ceilingMs;
  let call = initialCall(cfg);
  let attempt = 0;
  let terminalReported = false;
  let deadline: RequestDeadline;
  const reportAttempt: RequestDeadline["reportAttempt"] = (event) => {
    if (!attempt || terminalReported) return;
    if (event.outcome !== "retrying") terminalReported = true;
    request.retry?.onAttempt({
      ...event,
      attempt,
      binding: call.binding,
      provider: call.provider,
      model: call.model,
      ...(deadline.providerIgnore !== undefined ? { providerIgnore: deadline.providerIgnore } : {}),
      ...(deadline.reasoningEffort !== undefined
        ? { reasoningEffort: deadline.reasoningEffort }
        : {}),
      /* Usage facts describe the wire response of one succeeded attempt; a
         retrying or failed attempt has none to report. */
      ...(event.outcome === "succeeded" && deadline.usage !== undefined
        ? {
            ...(deadline.usage.systemFingerprint !== null
              ? { systemFingerprint: deadline.usage.systemFingerprint }
              : {}),
            ...(deadline.usage.inputTokens !== null || deadline.usage.outputTokens !== null
              ? {
                  usage: {
                    inputTokens: deadline.usage.inputTokens,
                    outputTokens: deadline.usage.outputTokens,
                    costUsd: deadline.usage.costUsd,
                  },
                }
              : {}),
          }
        : {}),
    });
  };
  let observed: { status?: number; bodyBytes: number; upstreamServer?: string } = {
    bodyBytes: 0,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const failure = modelBoundaryFailure({
        ...observed,
        call,
        classification: "request_timeout",
        timeoutMs: ceilingMs,
      });
      /* A route that held the whole call and never finished is exactly the
         route the next call should not be given, and this ceiling is the one
         path out of a model call that the binding ladder never sees. */
      if (cfg.provider === "openrouter")
        restFailedRoute(cfg.model, modelBoundaryDiagnostic(failure) ?? null);
      try {
        reportAttempt({
          outcome: "failed",
          diagnostic: modelBoundaryDiagnostic(failure) ?? null,
          delayMs: 0,
          stoppedReason: "The original request deadline expired.",
        });
        reject(failure);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Model attempt observer failed."));
      }
    }, ceilingMs);
  });
  try {
    return await Promise.race([
      work(
        // Assigned here so the central stamp above reads the routing each
        // wire attempt was actually sent with.
        (deadline = {
          signal: controller.signal,
          timeRemaining: () => Math.max(0, expiresAt - Date.now()),
          absoluteCeilingMs: ceilingMs,
          reportAttempt,
          calling(next) {
            if (controller.signal.aborted)
              throw modelBoundaryFailure({
                call: next,
                classification: "request_timeout",
                timeoutMs: ceilingMs,
              });
            attempt += 1;
            terminalReported = false;
            call = next;
            observed = { bodyBytes: 0 };
          },
          observed(response) {
            observed = response;
          },
        }),
      ).then(
        (value) => {
          reportAttempt({
            outcome: "succeeded",
            diagnostic: null,
            delayMs: 0,
            stoppedReason: null,
          });
          return value;
        },
        (error: unknown) => {
          reportAttempt({
            outcome: "failed",
            diagnostic: modelBoundaryDiagnostic(error) ?? null,
            delayMs: 0,
            stoppedReason: "The attempt failed without further recovery.",
          });
          throw error;
        },
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Build the provider call for the current config. Cheap to rebuild per attempt. */
export function makeCompleteJson(cfg: LlmConfig, mockResultPath: string): CompleteJson {
  return async (request) => {
    /* Per request, not per provider call: the shape belongs to the calling
       Module, not to this seam. */
    const full = wireJsonSchema(request.schema);
    if (cfg.provider === "mock") return mockComplete(mockResultPath);
    /* Compaction is a property of the wire, so it is applied and undone here
       rather than by any Module: the caller hands over its own schema and gets
       its own names back. */
    const compacted = request.compactWireNames ? compactWireSchema(full) : null;
    const schema = compacted?.schema ?? full;
    if (compacted)
      request = {
        ...request,
        system: request.system + wireNameLegend(compacted.names),
      };
    const answered = withinRequestCeiling(cfg, request, async (deadline) => {
      switch (cfg.provider) {
        case "openai":
          return openaiComplete(cfg, request, schema, deadline);
        case "anthropic":
          return anthropicComplete(cfg, request, schema, deadline);
        case "openrouter":
          /* Google AI Studio answers INVALID_ARGUMENT to the full JSON Schema
             and 200 to a stripped one. The stripping already existed for the
             direct `gemini` provider; a Gemini-family model reached through
             OpenRouter never got it (#232). */
          return openrouterComplete(
            cfg,
            request,
            geminiFamily(cfg.model) ? geminiWireSchema(request.schema) : schema,
            deadline,
          );
        case "gemini":
          return geminiComplete(cfg, request, geminiWireSchema(request.schema), deadline);
        case "ollama":
          return ollamaComplete(cfg, request, schema, deadline);
        case "mock":
          return mockComplete(mockResultPath);
      }
    });
    return compacted ? answered.then((value) => expandWireNames(value, compacted.names)) : answered;
  };
}
