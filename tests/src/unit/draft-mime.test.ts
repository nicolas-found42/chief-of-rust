import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeDraftRaw, gmailDraftInput } from "../../../apps/server/src/google/gmail";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("encodeDraftRaw", () => {
  it("composes To/Subject/Content-Type headers, a blank line, then the body", () => {
    const raw = encodeDraftRaw({
      to: "procurement@acme.example",
      subject: "Updated Q3 pricing",
      body: "Hello,\n\nHere is the sheet.",
    });
    expect(decode(raw)).toBe(
      [
        "To: procurement@acme.example",
        "Subject: Updated Q3 pricing",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        "Hello,",
        "",
        "Here is the sheet.",
      ].join("\r\n"),
    );
  });

  it("omits the To header when the recipient is unknown", () => {
    const raw = encodeDraftRaw({ to: "", subject: "S", body: "B" });
    expect(decode(raw)).not.toContain("To:");
    expect(decode(raw).startsWith("Subject: S\r\n")).toBe(true);
  });

  it("round-trips non-ASCII UTF-8 bodies through base64url", () => {
    const raw = encodeDraftRaw({ to: "a@b.c", subject: "Sübjekt", body: "Café — naïve ✓" });
    expect(decode(raw)).toContain("Café — naïve ✓");
  });

  it("maps a DraftItem with no recipient onto an empty to", () => {
    expect(gmailDraftInput({ subject: "S", body: "B" })).toEqual({
      to: "",
      subject: "S",
      body: "B",
    });
  });
});

describe("gmail module is draft-only (structural guarantee)", () => {
  it("contains no reference to the delivery API", () => {
    const sourcePath = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../../apps/server/src/google/gmail.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/send/i);
    expect(source).not.toMatch(/users\.messages/);
    expect(source).toMatch(/users\.drafts\.create/);
  });
});
