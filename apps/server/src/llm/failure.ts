import {
  ModelBoundaryDiagnosticSchema,
  type ModelBoundaryClassification,
  type ModelBoundaryDiagnostic,
  type ProviderId,
  type ResultShapeDiagnostic,
  type ResultShapeBinding,
} from "@chief-of-staff-demo/shared";
import type { ZodIssue, ZodType, ZodTypeDef } from "zod/v3";

/** Which model the Shell was calling, and how it asked for the Result Shape. */
export interface ModelCall {
  provider: ProviderId;
  model: string;
  binding: ResultShapeBinding;
}

/** Where the binding's answer should have been, named for the diagnostic. */
export interface AnswerContainer {
  /** Dotted path to the container, `""` when it is the body itself. */
  path: string;
  value: unknown;
}

export interface ModelBoundaryFailureInput {
  call: ModelCall;
  classification: ModelBoundaryClassification;
  /** Absent when no response arrived at all. */
  status?: number;
  /** The response text, read for its byte length and structure and then dropped. */
  body?: string;
  /** Observed wire bytes when a streaming response did not finish. No content is retained. */
  bodyBytes?: number;
  /** The parsed body, where there was one to parse. */
  payload?: unknown;
  /** The container whose fields the diagnostic reports as populated or empty. */
  answer?: AnswerContainer;
  /** The ceiling that fired, for `request_timeout`. */
  timeoutMs?: number;
  /**
   * The upstream a streaming response named before it stalled.
   *
   * A refusal body names its own upstream, but a stream that times out has no
   * body to read it from — and OpenRouter routes one model id across many
   * upstreams, so "which one served this" is the difference between a model
   * that cannot do the task and a route that was not answering (#232). Only
   * used when no payload named one.
   */
  upstreamServer?: string;
}

/**
 * A failure at the Shell's one LLM seam, carrying the classified facts instead
 * of a sentence callers have to pattern-match. The message is for a person
 * reading a Run; code reads `diagnostic`.
 *
 * No `cause` is attached, deliberately. A JSON parse error quotes the text it
 * choked on and a transport error can quote a URL holding an API key, so the
 * only account of the failure this carries is the shape-only diagnostic.
 */
export class ModelBoundaryError extends Error {
  readonly diagnostic: ModelBoundaryDiagnostic;

  constructor(diagnostic: ModelBoundaryDiagnostic) {
    const sanitized = sanitizeModelBoundaryDiagnostic(diagnostic);
    super(failureMessage(sanitized));
    this.name = "ModelBoundaryError";
    this.diagnostic = sanitized;
  }
}

/** Keep identifiers and measured shape only, including at durable recorder boundaries. */
export function sanitizeModelBoundaryDiagnostic(
  diagnostic: ModelBoundaryDiagnostic,
): ModelBoundaryDiagnostic {
  const identifier = (value: string) =>
    /^[A-Za-z0-9_.:/[\]-]{1,200}$/.test(value) ? value : "[unnamed]";
  const names = (values: string[]) => values.slice(0, 64).map(identifier);
  return ModelBoundaryDiagnosticSchema.parse({
    ...diagnostic,
    model: identifier(diagnostic.model),
    upstreamCode: Number.isSafeInteger(diagnostic.upstreamCode) ? diagnostic.upstreamCode : null,
    upstreamServer:
      diagnostic.upstreamServer === null ? null : routeName(diagnostic.upstreamServer),
    finishReason: diagnostic.finishReason === null ? null : identifier(diagnostic.finishReason),
    topLevelKeys: names(diagnostic.topLevelKeys),
    populatedFields: names(diagnostic.populatedFields),
    emptyFields: names(diagnostic.emptyFields),
  });
}

/** A Module rejected a model reply without retaining the rejected values. */
class ResultShapeError extends Error {
  constructor(readonly diagnostic: ResultShapeDiagnostic) {
    const fields = diagnostic.issues
      .map((issue) => `${issue.field}:${issue.expectedType}/${issue.actualType}`)
      .join(" ");
    super(
      `Result Shape ${diagnostic.expectedShape} did not match (keys ${diagnostic.topLevelKeys.join(" ") || "none"}; fields ${fields || "unknown"})`,
    );
    this.name = "ResultShapeError";
  }
}

/** The classified facts behind an error, or `null` if it did not cross the seam. */
export function modelBoundaryDiagnostic(error: unknown): ModelBoundaryDiagnostic | null {
  return error instanceof ModelBoundaryError ? error.diagnostic : null;
}

/**
 * Whether the upstream said it is out of capacity right now: a 429 from either
 * side of the seam, or a 502/503/504 the upstream named as its own.
 *
 * Kept apart from `isModelCapacityFailure` because the two are asked different
 * questions. This one is about the upstream's own answer, and it is what a
 * retry policy may act on: measured on the pinned route, one identical request
 * sent three times gave a 502, then an answer, then a 502, so the refusal does
 * not predict the next attempt. A timeout is a different fact — the call
 * consumed a ceiling rather than being refused — and whether it is worth
 * repeating depends on which ceiling fired, which only the caller's own
 * deadline can judge.
 */
export function isUpstreamCapacityRefusal(error: unknown): boolean {
  const diagnostic = modelBoundaryDiagnostic(error);
  if (diagnostic === null) return false;
  if (diagnostic.status === 429 || diagnostic.upstreamCode === 429) return true;
  return (
    diagnostic.classification === "upstream_error" &&
    diagnostic.upstreamCode !== null &&
    [502, 503, 504].includes(diagnostic.upstreamCode)
  );
}

/** Whether the seam reported a transient capacity condition, without choosing a retry policy. */
export function isModelCapacityFailure(error: unknown): boolean {
  const diagnostic = modelBoundaryDiagnostic(error);
  if (diagnostic === null) return false;
  if (diagnostic.classification === "request_timeout") return true;
  return isUpstreamCapacityRefusal(error);
}

function resultShapeDiagnostic(error: unknown): ResultShapeDiagnostic | null {
  return error instanceof ResultShapeError ? error.diagnostic : null;
}

/** Classified model diagnostics ready to merge into a durable event. */
export function modelDiagnosticEventDetail(error: unknown): Record<string, unknown> {
  const boundary = modelBoundaryDiagnostic(error);
  const shape = resultShapeDiagnostic(error);
  return {
    ...(boundary === null ? {} : { modelBoundary: boundary }),
    ...(shape === null ? {} : { resultShape: shape }),
  };
}

/** Validate a Module's named Result Shape without retaining rejected values. */
export function parseResultShape<T>(
  expectedShape: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw resultShapeFailure(expectedShape, value, parsed.error.issues);
}

function resultShapeFailure(
  expectedShape: string,
  value: unknown,
  issues: ZodIssue[],
): ResultShapeError {
  const leafIssues = flattenZodIssues(issues);
  const topLevelKeys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).map(safeName)
      : [];
  return new ResultShapeError({
    expectedShape,
    topLevelKeys,
    issues: leafIssues.map((issue) => ({
      field: issue.path.map(String).join(".") || "[root]",
      expectedType:
        issue.code === "invalid_type"
          ? issue.expected
          : issue.code === "invalid_enum_value"
            ? "enum"
            : "valid_value",
      actualType: valueType(valueAtPath(value, issue.path)),
    })),
  });
}

function flattenZodIssues(issues: ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.unionErrors.flatMap((error) => flattenZodIssues(error.issues))
      : [issue],
  );
}

export function modelBoundaryFailure(input: ModelBoundaryFailureInput): ModelBoundaryError {
  const payload = asObject(input.payload);
  const fields = input.answer ? fieldFlags(input.answer) : { populated: [], empty: [] };
  return new ModelBoundaryError({
    classification: input.classification,
    provider: input.call.provider,
    model: input.call.model,
    upstreamServer:
      upstreamServer(payload) ?? (input.upstreamServer ? routeName(input.upstreamServer) : null),
    upstreamCode: upstreamCode(payload),
    binding: input.call.binding,
    status: input.status ?? null,
    finishReason: finishReason(payload),
    bodyBytes:
      input.bodyBytes ?? (input.body === undefined ? 0 : Buffer.byteLength(input.body, "utf8")),
    topLevelKeys: payload === null ? [] : Object.keys(payload).map(safeName),
    populatedFields: fields.populated,
    emptyFields: fields.empty,
    timeoutMs: input.timeoutMs ?? null,
  });
}

type JsonObject = Record<string, unknown>;

/** An object that is not an array, so its own keys can be read as fields. */
function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * A provider-authored identifier, kept only if it looks like one. Providers name
 * their own keys and stop reasons, but a diagnostic that copies a name through
 * unchecked is a route for payload text to reach a durable log.
 */
function safeName(value: string): string {
  return /^[A-Za-z0-9_.:/-]{1,64}$/.test(value) ? value : "[unnamed]";
}

/**
 * The serving route's name, sanitized like any other identifier except that it
 * may carry a space inside it.
 *
 * OpenRouter names a route the way it displays it — `Sail Research`, `Io Net`,
 * `Thinking Machines` — and that name is exactly what `provider.ignore` takes
 * back, so the general identifier rule, which rejects a space outright, was
 * throwing away the only handle the seam has on the route that just failed
 * (#233). Still bounded, still no control characters, still shape and not
 * content: a route name is an identifier the provider chose, never an answer.
 */
function routeName(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:/-](?:[A-Za-z0-9_.:/ -]{0,62}[A-Za-z0-9_.:/-])?$/.test(trimmed)
    ? trimmed
    : "[unnamed]";
}

function valueAtPath(value: unknown, path: (string | number)[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !(part in current)) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function valueType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Why the model stopped, wherever the provider in use reports it. This looks in
 * all three places rather than being told which one, so that a failure is
 * classified the same way whether the seam got as far as reading the answer or
 * rejected the body before that — an HTTP error body carries a stop reason too.
 */
function finishReason(payload: JsonObject | null): string | null {
  if (!payload) return null;
  const fromChoices = asObject(firstOf(payload.choices))?.finish_reason;
  if (typeof fromChoices === "string") return safeName(fromChoices);
  if (typeof payload.stop_reason === "string") return safeName(payload.stop_reason);
  const fromCandidates = asObject(firstOf(payload.candidates))?.finishReason;
  if (typeof fromCandidates === "string") return safeName(fromCandidates);
  return null;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : null;
}

/** The server behind the provider, where the provider named one. */
function upstreamServer(payload: JsonObject | null): string | null {
  if (!payload) return null;
  if (typeof payload.provider === "string" && payload.provider !== "") {
    return routeName(payload.provider);
  }
  const named = asObject(asObject(payload.error)?.metadata)?.provider_name;
  return typeof named === "string" && named !== "" ? routeName(named) : null;
}

/** The numeric code the provider or its upstream gave, where it gave one. */
function upstreamCode(payload: JsonObject | null): number | null {
  const code = asObject(payload?.error)?.code;
  if (typeof code === "number" && Number.isSafeInteger(code)) return code;
  if (typeof code === "string" && /^\d{1,5}$/.test(code)) return Number(code);
  return null;
}

/**
 * Which of the answer container's own fields held something. This is the fact
 * that identified the live defect: `content` was empty and the model's answer
 * had landed in a sibling field, and nothing recorded that at the time.
 */
function fieldFlags(answer: AnswerContainer): { populated: string[]; empty: string[] } {
  const container = asObject(answer.value);
  if (!container) return { populated: [], empty: [] };
  const populated: string[] = [];
  const empty: string[] = [];
  for (const [key, value] of Object.entries(container)) {
    const name = answer.path === "" ? safeName(key) : `${answer.path}.${safeName(key)}`;
    (isPopulated(value) ? populated : empty).push(name);
  }
  return { populated, empty };
}

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  const object = asObject(value);
  return object === null || Object.keys(object).length > 0;
}

const CLAUSES: Record<ModelBoundaryClassification, string> = {
  transport_failure: "the request never reached the provider",
  request_timeout: "a model call was in flight when the request ceiling fired",
  repetition_loop: "the streamed answer degenerated into a repetition loop",
  answer_overrun: "the streamed answer ran past the most one call may deliver",
  http_error: "the provider refused the call",
  empty_body: "the provider answered with no body",
  unparseable_body: "the provider's body is not JSON",
  upstream_error: "the provider carried an upstream failure",
  unusable_shape: "the reply carried no answer where the binding puts it",
  answer_not_json: "the answer field does not hold JSON",
};

/** One sentence for a person reading a Run, built from the facts and nothing else. */
function failureMessage(diagnostic: ModelBoundaryDiagnostic): string {
  const facts = [`model ${diagnostic.model}`, `binding ${diagnostic.binding}`];
  if (diagnostic.status !== null) facts.push(`HTTP ${diagnostic.status}`);
  facts.push(`${diagnostic.bodyBytes} bytes`);
  if (diagnostic.upstreamServer !== null) facts.push(`upstream ${diagnostic.upstreamServer}`);
  if (diagnostic.upstreamCode !== null) facts.push(`code ${diagnostic.upstreamCode}`);
  if (diagnostic.finishReason !== null) facts.push(`finish_reason ${diagnostic.finishReason}`);
  if (diagnostic.timeoutMs !== null) facts.push(`ceiling ${diagnostic.timeoutMs}ms`);
  if (diagnostic.emptyFields.length > 0) facts.push(`empty ${diagnostic.emptyFields.join(" ")}`);
  if (diagnostic.populatedFields.length > 0) {
    facts.push(`populated ${diagnostic.populatedFields.join(" ")}`);
  }
  return `${diagnostic.provider}: ${CLAUSES[diagnostic.classification]} (${facts.join(", ")})`;
}
