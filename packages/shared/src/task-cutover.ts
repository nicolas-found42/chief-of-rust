import { z } from "zod/v3";

/** Content-free authorization and receipt for the canonical Tasks cutover. */
const count = z.number().int().nonnegative();
const preview = z.object({
  kind: z.literal("canonical-tasks"),
  workspace: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({
    legacyRuns: count,
    receipts: count,
    tasks: count,
    actionItems: count,
    taskLists: count,
    tasksToCreate: count,
    actionItemsToCreate: count,
  }),
  authenticationPreserved: z.literal(true),
  historicalRunsPreserved: z.literal(true),
});
export type TaskCutoverPreview = z.infer<typeof preview>;
export const TaskCutoverReceiptSchema = preview.extend({ completedAt: z.string().datetime() });
export type TaskCutoverReceipt = z.infer<typeof TaskCutoverReceiptSchema>;
