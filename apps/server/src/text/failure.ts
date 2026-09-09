import { StageFailure } from "../engine/module.js";
import { conversionFailureHint, diagnoseConversionFailure } from "./convert.js";

/** Convert an intake-boundary exception into safe Module-owned Run wording and event facts. */
export function conversionStageFailure(
  error: unknown,
  fileName: string,
  bytes: Buffer,
): StageFailure {
  const diagnostic = diagnoseConversionFailure(error, fileName, bytes);
  return new StageFailure(diagnostic.classification, conversionFailureHint(diagnostic), {
    eventDetail: { diagnostic },
  });
}
