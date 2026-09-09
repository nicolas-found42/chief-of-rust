import { google } from "googleapis";
import { createHash } from "node:crypto";
import type { GoogleAuth } from "../../../google/oauth.js";

/**
 * Gmail Delivery Output Adapter — send-only-to-owner (ADR-0034).
 *
 * This is the deliberate exception to the draft-only policy. It never accepts
 * a recipient from event/API/model; the recipient is structurally fixed to the
 * connected Google identity. It never emails External Guests. It renders the
 * Meeting Brief deterministically and persists a stable delivery identity
 * before the outward write for idempotency.
 *
 * Draft-only Modules (apps/server/src/google/gmail.ts) remain structurally
 * unable to call send; the banned-token test enforces that. Only this adapter
 * may reference users.messages.send.
 */

export interface GmailDeliveryProvider {
  /**
   * Send the rendered Meeting Brief to the workspace owner.
   * The recipient is resolved from the authenticated Gmail profile.
   * Returns both the Gmail messageId and that authenticated recipient.
   */
  send(params: {
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }): Promise<{ messageId: string; recipient: string }>;

  /**
   * Reconcile: did a message with this deliveryId already send?
   * Read-only; used before retry so a lost ack converges to one message.
   */
  findByDeliveryId(deliveryId: string): Promise<{ messageId: string; recipient: string } | null>;
}

/** Resolve the recipient from the authenticated Gmail account, never Calendar/model input. */
export async function gmailOwnerEmail(auth: GoogleAuth): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.getProfile({ userId: "me" });
  const email = response.data.emailAddress?.trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    throw new Error("Gmail profile returned no valid authenticated owner email");
  }
  return email;
}

function encodeMeetingBriefRaw(
  to: string,
  subject: string,
  text: string,
  html: string,
  deliveryId: string,
): string {
  // Deterministic MIME with stable delivery header for reconciliation.
  const boundary = `mb_${deliveryId.replace(/[^a-zA-Z0-9]/g, "_")}_b`;
  const messageId = messageIdFor(deliveryId);
  const safeSubject = subject.replace(/[\r\n]+/g, " ").trim();
  const headers = [
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    `Message-ID: <${messageId}>`,
    `X-MeetingBrief-Delivery-Id: ${deliveryId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const safeText = text.replace(/\r?\n/g, "\r\n");
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    safeText,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    html,
    `--${boundary}--`,
  ];
  const mime = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

function messageIdFor(deliveryId: string): string {
  const digest = createHash("sha256").update(deliveryId, "utf8").digest("hex");
  return `meeting-brief-${digest}@chief-of-staff-demo.local`;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function createGmailDeliveryProvider(
  auth: GoogleAuth,
  ownerEmail: string,
): GmailDeliveryProvider {
  if (!ownerEmail || !isValidEmail(ownerEmail)) {
    throw new Error(`Gmail delivery requires a valid owner email, got ${ownerEmail}`);
  }
  const owner = ownerEmail.trim();

  return {
    async send({ subject, text, html, deliveryId }) {
      // Owner-only enforcement: recipient is fixed, never from model/event.
      // The adapter itself never takes a `to` parameter; it is bound to owner at construction.
      if (!deliveryId) throw new Error("deliveryId is required for idempotency");
      const raw = encodeMeetingBriefRaw(owner, subject, text, html, deliveryId);
      const gmail = google.gmail({ version: "v1", auth });
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      const id = (res.data as { id?: string }).id;
      if (!id) throw new Error(`Gmail send returned no id for delivery ${deliveryId}`);
      return { messageId: id, recipient: owner };
    },

    async findByDeliveryId(
      deliveryId: string,
    ): Promise<{ messageId: string; recipient: string } | null> {
      if (!deliveryId) return null;
      const gmail = google.gmail({ version: "v1", auth });
      // Gmail exposes an exact RFC Message-ID search operator. The hashed ID is
      // deterministic and contains no provider-controlled query syntax.
      const q = `rfc822msgid:${messageIdFor(deliveryId)} in:sent`;
      const list = await gmail.users.messages.list({ userId: "me", maxResults: 10, q });
      const messages = (list.data as { messages?: Array<{ id?: string }> }).messages ?? [];
      for (const m of messages) {
        const id = m.id;
        if (!id) continue;
        const get = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["X-MeetingBrief-Delivery-Id", "Message-ID", "To"],
        });
        const headers = (
          get.data as { payload?: { headers?: Array<{ name?: string; value?: string }> } }
        ).payload?.headers;
        const headerId = headers?.find(
          (h) => h.name?.toLowerCase() === "x-meetingbrief-delivery-id",
        )?.value;
        if (headerId === deliveryId) {
          const to = headers?.find((h) => h.name?.toLowerCase() === "to")?.value ?? owner;
          return { messageId: id, recipient: to };
        }
      }
      return null;
    },
  };
}

/**
 * Totally injectable fake delivery provider for host-seam tests (issue://90).
 * Retains real delivery state machine while avoiding Google network.
 */
export type FakeGmailDeliveryMode = "normal" | "unavailable" | "lostAck" | "permanentFailure";

export interface FakeGmailDeliveryOptions {
  ownerEmail: string;
  mode?: FakeGmailDeliveryMode;
  /** Fail the Nth send call (1-indexed) with transient error for lostAck simulation. */
  failOnAttempt?: number | null;
}

export class FakeGmailDeliveryProvider implements GmailDeliveryProvider {
  private readonly ownerEmail: string;
  private readonly mode: FakeGmailDeliveryMode;
  private failOnAttempt: number | null;
  private sendCount = 0;
  private readonly sentByDeliveryId = new Map<
    string,
    { messageId: string; recipient: string; subject: string }
  >();
  private readonly allMessages: Array<{
    messageId: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }> = [];

  constructor(opts: FakeGmailDeliveryOptions) {
    if (!opts.ownerEmail) throw new Error("FakeGmailDeliveryProvider requires ownerEmail");
    this.ownerEmail = opts.ownerEmail;
    this.mode = opts.mode ?? "normal";
    this.failOnAttempt = opts.failOnAttempt ?? null;
  }

  get messages(): ReadonlyArray<{
    messageId: string;
    to: string;
    subject: string;
    deliveryId: string;
  }> {
    return this.allMessages;
  }

  get count(): number {
    return this.sendCount;
  }

  clear(): void {
    this.sentByDeliveryId.clear();
    this.allMessages.length = 0;
    this.sendCount = 0;
  }

  async send(params: {
    subject: string;
    text: string;
    html: string;
    deliveryId: string;
  }): Promise<{ messageId: string; recipient: string }> {
    this.sendCount++;
    if (this.mode === "unavailable") {
      throw Object.assign(new Error("Gmail delivery unavailable (fake)"), {
        code: 503,
        response: {
          data: { error: { message: "Gmail unavailable", errors: [{ reason: "backendError" }] } },
        },
      });
    }
    if (this.failOnAttempt !== null && this.sendCount === this.failOnAttempt) {
      throw new Error(`Fake transient failure on attempt ${this.sendCount}`);
    }
    if (this.mode === "permanentFailure") {
      throw new Error("Fake permanent Gmail failure");
    }

    const messageId = `fake-msg-${params.deliveryId}-${this.sendCount}-${Date.now()}`;

    // For lostAck mode: store but then throw to simulate lost acknowledgement
    if (this.mode === "lostAck" && this.sendCount === 1) {
      this.sentByDeliveryId.set(params.deliveryId, {
        messageId,
        recipient: this.ownerEmail,
        subject: params.subject,
      });
      this.allMessages.push({
        messageId,
        to: this.ownerEmail,
        subject: params.subject,
        text: params.text,
        html: params.html,
        deliveryId: params.deliveryId,
      });
      throw new Error("Fake lost acknowledgement after send");
    }

    this.sentByDeliveryId.set(params.deliveryId, {
      messageId,
      recipient: this.ownerEmail,
      subject: params.subject,
    });
    this.allMessages.push({
      messageId,
      to: this.ownerEmail,
      subject: params.subject,
      text: params.text,
      html: params.html,
      deliveryId: params.deliveryId,
    });
    return { messageId, recipient: this.ownerEmail };
  }

  async findByDeliveryId(
    deliveryId: string,
  ): Promise<{ messageId: string; recipient: string } | null> {
    const found = this.sentByDeliveryId.get(deliveryId);
    if (!found) return null;
    return { messageId: found.messageId, recipient: found.recipient };
  }
}
