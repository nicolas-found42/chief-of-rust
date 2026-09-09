/**
 * Workspace-level contracts shared across the Shell, the server modules and the
 * web client: the destructive actions that act on the Workspace as a whole,
 * not on one Module's records.
 */

/**
 * The exact confirmation phrase clearing all generated data requires, in the
 * house pattern of the other destructive confirmations ("DELETE PROFILE",
 * "DELETE TRANSCRIPT"). The server compares it exactly; the client holds the
 * same constant so the prompt and the comparison cannot drift.
 */
export const CLEAR_GENERATED_DATA_CONFIRMATION = "CLEAR ALL DATA" as const;
