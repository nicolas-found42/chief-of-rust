import type { CompleteJson } from "../../llm/providers.js";
import { isModelCapacityFailure } from "../../llm/failure.js";

const CONTENT_SCOUT_MODEL_ATTEMPTS = 3;

/** Content Scout's retry policy for transient capacity at the model seam. */
export async function completeJsonWithCapacityRetries(
  getCompleteJson: () => CompleteJson,
  request: Parameters<CompleteJson>[0],
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getCompleteJson()(request);
    } catch (error) {
      if (!isModelCapacityFailure(error) || attempt >= CONTENT_SCOUT_MODEL_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
