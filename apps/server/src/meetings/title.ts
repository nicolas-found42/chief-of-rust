import { z } from "zod/v3";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";

/**
 * What a transcript-owned Meeting is called (issue: Meeting Wizard naming).
 *
 * A Meeting created from a Transcript alone has no Calendar summary to take
 * its name from, so the name has to be recovered. Three sources, best first:
 *
 * 1. the transcript's own leading Markdown heading — the exporter writes the
 *    meeting's real name there, punctuation intact ("Found42 Stand-Up
 *    Meeting"), where the file name has already lost it to the separator;
 * 2. the file name, with the exporter's artifact words and Drive's copy
 *    prefix stripped (`meetingFileNameMeta`);
 * 3. a model pass over the two, for names neither rule can repair.
 *
 * The first two are deterministic and free; the model only ever sees names
 * the deterministic pass could not settle, and a failure falls back to it
 * rather than blocking the join.
 */

/** A leading `# Heading`, before any speaker line. */
const MARKDOWN_H1 = /^\s*#\s+(.+?)\s*$/m;
/** Headings the exporter writes about the file rather than the meeting. */
const NON_TITLE_HEADING = /^(?:transcript|summary|notes|meeting notes|recording)$/i;
/** How far into the text the heading must appear to be the document's own. */
const HEADING_SCAN_CHARS = 400;
/** A title longer than this is a sentence the exporter put in the heading. */
const MAX_TITLE_LENGTH = 120;
/** A trailing word that may name the file rather than the meeting. */
const ARTIFACT_WORD_TAIL =
  /[\s_-](?:transcripts?|summary|summaries|notes?|recordings?|audio|video|minutes)$/i;

/**
 * The meeting name the transcript states about itself, or null when it
 * states none worth having.
 */
function headingTitleOf(record: TranscriptRecord): string | null {
  const head = record.normalizedText.slice(0, HEADING_SCAN_CHARS);
  const match = MARKDOWN_H1.exec(head);
  const title = match?.[1]?.trim() ?? "";
  if (title === "" || title.length > MAX_TITLE_LENGTH) return null;
  if (NON_TITLE_HEADING.test(title)) return null;
  return /[a-z]/i.test(title) ? title : null;
}

/** The deterministic name: the transcript's own heading, else its file name. */
function deterministicTitleOf(record: TranscriptRecord): string | null {
  return headingTitleOf(record) ?? meetingFileNameMeta(record.source.fileName).title;
}

/**
 * Whether a deterministic name still reads like a file rather than a meeting.
 * Only these reach the model: a name that already reads well is not worth a
 * model call, and re-writing it would risk losing a name the owner knows.
 */
function needsCleaning(title: string | null): boolean {
  if (title === null) return true;
  const trimmed = title.trim();
  if (trimmed === "" || trimmed.length > MAX_TITLE_LENGTH) return true;
  return (
    /\.(?:md|json|txt|docx?|vtt|srt)$/i.test(trimmed) ||
    // A long digit run is an id or a raw timestamp, never part of a name.
    /\d{5,}/.test(trimmed) ||
    // Leftover separator noise the deterministic rules do not own.
    /[_]{1,}|\s{2,}|^[-\s]|[-\s]$/.test(trimmed) ||
    /* Still ending in the exporter's word for the file. The deterministic pass
       only strips that from a name that also carries a timestamp, because a
       meeting really can be called "Design Notes" — so the ambiguous ones come
       here, where the model can read the transcript's own opening and tell the
       two apart. */
    ARTIFACT_WORD_TAIL.test(trimmed) ||
    NON_TITLE_HEADING.test(trimmed)
  );
}

/** The model's answer: the cleaned name, or an explicit refusal. */
const CleanedTitleSchema = z.strictObject({
  title: z
    .string()
    .describe("The meeting's name in plain title case, or an empty string if it cannot be told."),
});

export interface MeetingTitleCleanerDeps {
  /** The Shell's model seam; absent means deterministic naming only. */
  getCompleteJson?: () => (request: {
    system: string;
    user: string;
    temperature?: number;
    schema: typeof CleanedTitleSchema;
  }) => Promise<unknown>;
  log?: (message: string) => void;
}

const TITLE_SYSTEM_PROMPT = [
  "You name meetings from transcript metadata.",
  "Return the meeting's own name, as a person would write it on a calendar.",
  "Keep real punctuation and capitalisation (hyphens in 'Stand-Up', 'x' in 'Nick x Adejoke').",
  "Remove file-naming debris: extensions, timestamps, ids, 'copy of', and the words",
  "transcript, summary, notes, recording when they name the file rather than the meeting.",
  "Never invent a subject the input does not state. Never add a date.",
  "If the input does not say what the meeting was, return an empty string.",
].join(" ");

/**
 * Names a transcript-owned Meeting, using the model only where the
 * deterministic rules leave something file-shaped behind. Never throws: the
 * join must not fail because a naming call did.
 */
export async function resolveMeetingTitle(
  record: TranscriptRecord,
  deps: MeetingTitleCleanerDeps = {},
): Promise<string> {
  const deterministic = deterministicTitleOf(record);
  const fallback = deterministic ?? record.source.fileName;
  if (!needsCleaning(deterministic)) return fallback;

  const complete = deps.getCompleteJson?.();
  if (!complete) return fallback;

  try {
    const raw = await complete({
      system: TITLE_SYSTEM_PROMPT,
      user: [
        `File name: ${record.source.fileName}`,
        deterministic === null ? null : `Deterministic guess: ${deterministic}`,
        `Transcript opening:\n${record.normalizedText.slice(0, HEADING_SCAN_CHARS)}`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n\n"),
      temperature: 0,
      schema: CleanedTitleSchema,
    });
    const parsed = CleanedTitleSchema.safeParse(raw);
    const cleaned = parsed.success ? parsed.data.title.trim() : "";
    /* An empty answer is the model saying it cannot tell, which is a real
       answer — take the deterministic name rather than an empty title. */
    if (cleaned === "" || cleaned.length > MAX_TITLE_LENGTH) return fallback;
    return cleaned;
  } catch (error) {
    deps.log?.(
      `meeting title cleaning failed for ${record.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return fallback;
  }
}
