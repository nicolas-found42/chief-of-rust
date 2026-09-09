import { readFileSync } from "node:fs";
import { parseSync, type Program } from "oxc-parser";

/** Parse source assertions without depending on a compiler's private API. */
export function parseSource(path: string, text = readFileSync(path, "utf8")): Program {
  const result = parseSync(path, text);
  if (result.errors.length > 0) {
    throw new Error(
      `Cannot inspect ${path}: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return result.program;
}
