export const CONVERSION_FAILURE_CLASSIFICATIONS = [
  "unsupported_format",
  "empty_file",
  "invalid_file",
  "converter_failure",
] as const;
export type ConversionFailureClassification = (typeof CONVERSION_FAILURE_CLASSIFICATIONS)[number];

export const CONVERSION_STEPS = [
  "detect_format",
  "convert_file",
  "validate_text",
  "parse_json",
  "validate_transcript",
  "extract_pdf",
  "extract_docx",
] as const;
export type ConversionStep = (typeof CONVERSION_STEPS)[number];

/** Shape-only facts from the intake-file conversion boundary. */
export interface ConversionDiagnostic {
  classification: ConversionFailureClassification;
  /** Lowercase extension without the dot, or `unknown` when none is usable. */
  format: string;
  bytes: number;
  step: ConversionStep;
}
