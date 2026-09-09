import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  actionItemEvidence,
  buildDebriefMessages,
  clampDueDates,
  dropActionItemEvidence,
  stripFulfilledActionItems,
} from "../apps/server/src/modules/meeting-debrief/extraction.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import { MeetingDebriefExtractionSchema } from "../packages/shared/src/meeting-debrief.js";
import type { TranscriptRecord } from "../packages/shared/src/transcript.js";

const OUT = process.argv[3] ?? "/tmp/debrief-runs";
const files = process.argv.slice(4);
if (files.length === 0) {
  console.error("usage: tsx scripts/run-debrief-eval.mts <model> <outdir> <files...>");
  process.exit(1);
}
const model = process.argv[2];
if (!model) {
  console.error("usage: tsx scripts/run-debrief-eval.mts <model> <outdir> <files...>");
  process.exit(1);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
const complete = makeCompleteJson({ provider: "openrouter", model, apiKey }, "");

for (const file of files) {
  const name = file.split("/").pop()!;
  console.log(`=== ${name} ===`);
  const text = await readFile(file, "utf8");
  // crude meeting date from filename
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  const record = {
    id: `eval-${name}`,
    source: { fileName: name },
    ingestedAt: new Date().toISOString(),
    normalizedText: text,
    meetingDate: m?.[1] ?? null,
    occurrence: null,
    speakers: [],
    roster: [],
  } as unknown as TranscriptRecord;
  const messages = buildDebriefMessages(record, { mentions: [], decisions: [], organizations: [] });
  console.log(
    `system prompt chars: ${messages.system.length}, user chars: ${messages.user.length}`,
  );
  const t0 = Date.now();
  try {
    const raw = await complete({
      system: messages.system,
      user: messages.user,
      schema: messages.schema,
      temperature: 0,
    });
    const ms = Date.now() - t0;
    const checked = MeetingDebriefExtractionSchema.safeParse(dropActionItemEvidence(raw));
    const parsed = checked.success
      ? {
          success: true as const,
          data: stripFulfilledActionItems(
            clampDueDates(checked.data, record),
            actionItemEvidence(raw),
            record,
          ),
        }
      : checked;
    const outFile = `${OUT}/${name}.debrief.json`;
    await writeFile(
      outFile,
      JSON.stringify(
        {
          model,
          ms,
          valid: parsed.success,
          /* What the production pipeline would store: post-clamp. */
          raw: parsed.success ? parsed.data : raw,
          modelRaw: raw,
        },
        null,
        2,
      ),
    );
    if (!parsed.success) {
      console.log(
        `INVALID after ${ms}ms:`,
        JSON.stringify(parsed.error.issues.slice(0, 5), null, 2),
      );
    } else {
      const d = parsed.data;
      console.log(
        `OK ${ms}ms summary=${d.summary.length}ch decisions=${d.decisions.length} actions=${d.actionItems.length} questions=${d.openQuestions.length} recipients=${d.suggestedRecipients.length}`,
      );
      for (const a of d.actionItems)
        console.log(`  - [${a.owner ?? "?"}] ${a.title} due=${a.dueDate ?? "-"}`);
    }
  } catch (error) {
    console.log(`ERROR after ${Date.now() - t0}ms:`, errorMessage(error));
  }
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 2000);
  return String(error).slice(0, 2000);
}
