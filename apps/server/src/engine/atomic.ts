import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Atomically write JSON-serializable data to `filePath`.
 * Creates parent directories, writes to a temporary file, then renames.
 * Keeps behavior identical to the duplicated 4-line blocks it replaces.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}
