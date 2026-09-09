const FILE_TIMESTAMP = /(\d{4}-\d{2}-\d{2})T\d{2}[-:]/;

/**
 * Fireflies exports embed the meeting timestamp in the file name
 * (`…-2026-06-18T13-00-00.000Z.json`). Recovering the date lets relative
 * deadlines ("by Monday") resolve against the meeting, not upload time.
 *
 * A neutral text helper (issue #142): it belonged to Transcript → Tasks, but
 * the Transcript Catalog reads the same file names from the same folder, so
 * it survives that Module's retirement here rather than inside it.
 */
export function meetingDateFromFileName(fileName: string): string | null {
  const match = FILE_TIMESTAMP.exec(fileName);
  return match ? (match[1] ?? null) : null;
}
