import { google } from "googleapis";
import type { DraftItem } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "./oauth.js";

export interface GmailDraftInput {
  to: string;
  subject: string;
  body: string;
}

export function gmailDraftInput(item: DraftItem): GmailDraftInput {
  return { to: item.to ?? "", subject: item.subject, body: item.body };
}

/** Compose the raw UTF-8 MIME message, base64url-encoded as the API requires. */
export function encodeDraftRaw(draft: GmailDraftInput): string {
  const headers: string[] = [];
  if (draft.to) {
    headers.push(`To: ${draft.to}`);
  }
  headers.push(`Subject: ${draft.subject}`);
  headers.push(`Content-Type: text/plain; charset="UTF-8"`);
  const body = draft.body.replace(/\r?\n/g, "\r\n");
  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

/**
 * Draft-only Gmail surface. This module must never reference the delivery
 * API — the banned-token unit test enforces it structurally.
 */
export async function createGmailDraft(auth: GoogleAuth, draft: GmailDraftInput): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: encodeDraftRaw(draft) } },
  });
  if (!res.data.id) {
    throw new Error(`draft insert returned no id for "${draft.subject}"`);
  }
  return res.data.id;
}
