import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixture";

const LINKED_RUN_FILE = "Linked sync - 2026-08-17T13-00-00.000Z.md";

function transcriptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "drive_journey_link_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "journey-link",
      fileName: LINKED_RUN_FILE,
      sourceUrl: null,
      checksum: "journey-checksum-1",
      observedRevision: 1,
      modifiedAt: "2026-08-17T13:05:00.000Z",
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: [
      "Alice: We decided to ship the billing fix on Friday.",
      "Alice: I will own the billing fix follow-up.",
      "Bob: Is the rollout on track?",
    ].join("\n"),
    meetingDate: "2026-08-17",
    occurrence: { occurrenceKey: "evt1::2026-08-17T13:00:00Z", calendarEventId: "evt1" },
    speakers: ["Alice", "Bob"],
    speakerIdentityMappings: [],
    roster: [
      { displayName: "Alice", email: "alice@example.com" },
      { displayName: "Bob", email: "bob@example.com" },
    ],
    ...overrides,
  };
}

function mention(id: string, surfaceText: string, transcriptId: string): Record<string, unknown> {
  return {
    id,
    kind: "person",
    surfaceText,
    normalizedForms: [surfaceText.toLowerCase()],
    emails: [],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: null,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    provenance: {
      transcriptId,
      spanStart: 0,
      spanEnd: surfaceText.length,
      quote: surfaceText,
      timestamp: null,
      speakerLabel: null,
      meetingDate: null,
    },
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
  };
}

function identityState(transcriptId: string, profileId: string): Record<string, unknown> {
  return {
    mentions: [mention("m_alice", "Alice", transcriptId), mention("m_bob", "Bob", transcriptId)],
    decisions: [
      {
        id: `d_${transcriptId}_alice`,
        mentionId: "m_alice",
        transcriptId,
        action: "confirm",
        outcome: "linked",
        profileId,
        profileRevision: 1,
        decidedBy: "owner",
        decidedAt: "2026-08-31T12:00:00.000Z",
        note: null,
        mappingAuthority: null,
      },
    ],
    organizations: [],
  };
}

async function seed(
  request: APIRequestContext,
  payload: Record<string, unknown>,
): Promise<{ runId: string }> {
  const response = await request.post("/api/test/meeting-debrief/seed", { data: payload });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { runId: string };
}

async function waitForStatus(
  request: APIRequestContext,
  runId: string,
  status: "blocked" | "done" | "skipped",
): Promise<void> {
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(runId)}`)
      ).json()) as { status: string };
      return detail.status;
    })
    .toBe(status);
}

const REVIEW_WAIT_MS = 31 * 24 * 60 * 60 * 1000;

test("meeting debrief hermetic journey — seed → list → detail → unlinked → idempotent → no outward writes", async ({
  page,
  request,
}) => {
  // 1. A Calendar-linked transcript with identity review state is mined.
  const linkedTranscript = transcriptRecord();
  const seeded = await seed(request, {
    transcript: linkedTranscript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
  });
  await waitForStatus(request, seeded.runId, "done");

  // 2. The Debrief list shows the row with prefill and readiness.
  await page.goto("/meeting-debrief");
  await expect(page.getByRole("heading", { level: 1, name: "Meeting Debrief" })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(LINKED_RUN_FILE) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Linked", { exact: true })).toBeVisible();
  await expect(row.getByText("Roster prefilled from Calendar")).toBeVisible();
  await expect(row.getByText(/1 resolved/)).toBeVisible();
  await expect(row.getByText(/^Ready/)).toBeVisible();

  // 3. The detail journey shows extraction, roster, identity, and readiness.
  await page.getByRole("link", { name: LINKED_RUN_FILE }).click();
  await expect(page).toHaveURL(new RegExp(`/meeting-debrief/${seeded.runId}$`));
  await expect(page.getByRole("heading", { name: LINKED_RUN_FILE })).toBeVisible();
  await expect(
    page.getByText("Retrospective of " + LINKED_RUN_FILE, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("We decided to ship the billing fix on Friday").first(),
  ).toBeVisible();
  await expect(page.getByText("billing fix follow-up").first()).toBeVisible();
  await expect(page.getByText("(confirmed Profile)").first()).toBeVisible();
  await expect(page.getByText(/due 2026-08-17/)).toBeVisible();
  await expect(page.getByText("Is the rollout on track?")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Effectiveness evidence" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Coaching advice" })).toBeVisible();
  /* The occurrence key is a diagnostic, not a fact about the meeting — the
     page says whether Calendar prefilled the roster, and the key lives on the
     Run detail page. */
  await expect(
    page.getByText("Prefilled from the meeting's calendar attendees, and waiting to be confirmed."),
  ).toBeVisible();
  await expect(page.getByText("Confirm the roster to create the email draft.")).toBeVisible();
  await expect(page.getByText("Extracted").first()).toBeVisible();
  // The gate's refusal surface, whatever the shared server's owner state is:
  // journey 1 guarantees only the unconfirmed roster, so assert that blocker
  // rather than one that depends on other specs' onboarding state.
  await expect(page.getByText("Creating the email draft needs:")).toBeVisible();
  await expect(page.getByText("The attendee roster is not confirmed yet.")).toBeVisible();
  await expect(page.getByText("Alice — Profile")).toBeVisible();
  /* Unresolved mentions are grouped by name and counted, not listed once per
     span with an "awaiting review" suffix nothing could ever act on. */
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();

  // 4. An unlinked transcript visibly requires manual roster confirmation.
  const unlinked = await seed(request, {
    transcript: transcriptRecord({
      id: "drive_journey_unlink_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "journey-unlink",
        fileName: "Unlinked notes - 2026-08-18T09-00-00.000Z.md",
        sourceUrl: null,
        checksum: "journey-checksum-2",
        observedRevision: 1,
        modifiedAt: null,
      },
      normalizedText: "Carol: We agreed to revisit the pricing page next week.",
      meetingDate: "2026-08-18",
      occurrence: null,
      speakers: ["Carol"],
      roster: [],
    }),
    identity: identityState("drive_journey_unlink_r1", "profile_alice"),
  });
  await waitForStatus(request, unlinked.runId, "done");

  await page.goto("/meeting-debrief");
  const unlinkedRow = page.getByRole("row", { name: /Unlinked notes/ });
  await expect(unlinkedRow).toBeVisible();
  await expect(unlinkedRow.getByText("Not linked", { exact: true })).toBeVisible();
  await expect(unlinkedRow.getByText("Roster confirmation required")).toBeVisible();
  await expect(unlinkedRow.getByText(/^Ready/)).toBeVisible();

  // 5. Re-mining the same transcripts never duplicates Debrief Runs.
  const reseeded = await seed(request, {
    transcript: linkedTranscript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
  });
  expect(reseeded.runId).toBe(seeded.runId);
  const index = (await (await request.get("/api/meeting-debrief/index")).json()) as {
    entries: Array<{ transcriptId: string }>;
  };
  expect(index.entries).toHaveLength(2);

  // 6. Nothing was written outward: no draft/Task events, no outward artifact.
  for (const runId of [seeded.runId, unlinked.runId]) {
    const run = (await (await request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
      events: Array<{ type: string }>;
      files: string[];
    };
    expect(run.events.filter((event) => /draft|task|gmail|send/i.test(event.type))).toEqual([]);
    expect(run.files.sort()).toEqual(["result.json", "review.json"]);
    const raw = await (
      await request.get(`/api/runs/${encodeURIComponent(runId)}/artifacts/result.json`)
    ).text();
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "debrief",
      "extractedAt",
      "transcriptId",
      "version",
    ]);
  }
});

const OWNER_EMAIL = "owner@example.com";

/**
 * Establishes the review journey's owner precondition idempotently and
 * verifies it took: the journey never assumes what earlier specs on the
 * shared hermetic server did to the onboarding state.
 */
async function confirmOwner(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const identity = await request.post("/api/test/owner-identity", {
      data: { email: OWNER_EMAIL },
    });
    expect(identity.ok()).toBe(true);
    const created = await request.post("/api/people", {
      data: { fullName: "Workspace Owner", primaryEmail: OWNER_EMAIL },
    });
    let profileId: string;
    if (created.ok()) {
      profileId = ((await created.json()) as { id: string }).id;
    } else {
      // The owner Profile may already exist from a previous journey pass.
      const existing = (await (
        await request.get("/api/people?query=" + encodeURIComponent(OWNER_EMAIL))
      ).json()) as Array<{ id: string }>;
      const holder = existing[0];
      expect(holder).toBeTruthy();
      profileId = holder.id;
    }
    const confirmed = await request.post("/api/onboarding/owner/confirm", {
      data: { profileId },
    });
    if (!confirmed.ok()) continue;
    const status = (await (await request.get("/api/onboarding/owner")).json()) as {
      confirmed: { confirmedForGoogleEmail: string } | null;
    };
    if (status.confirmed?.confirmedForGoogleEmail === OWNER_EMAIL) return;
  }
  throw new Error("Owner identity could not be confirmed for the review journey");
}

test("meeting debrief review journey — regenerate, roster, recipients, approval lock, redo", async ({
  page,
  request,
}) => {
  await confirmOwner(request);

  // A transcript id unique to this journey: seeding must never re-resolve to
  // a Run another journey on the shared server already created.
  const transcript = transcriptRecord({
    id: "drive_journey_review_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "journey-review",
      fileName: "Review sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "journey-checksum-review",
      observedRevision: 1,
      modifiedAt: "2026-08-17T13:05:00.000Z",
    },
    normalizedText: [
      "Alice: We decided to ship the billing fix on Friday.",
      "Bob: I will own the billing fix follow-up.",
      "Bob: Is the rollout on track?",
      "Alice: I will send you the summary, Carol.",
    ].join("\n"),
  });
  const seeded = await seed(request, {
    transcript,
    identity: identityState("drive_journey_link_r1", "profile_alice"),
    profiles: [{ fullName: "Carol", email: "carol@example.com" }],
  });
  await waitForStatus(request, seeded.runId, "done");

  await page.goto(`/meeting-debrief/${encodeURIComponent(seeded.runId)}`);
  await expect(page.getByText("Extracted").first()).toBeVisible();

  // 1. Whole-field regeneration: the rejected value is invisible to the model,
  //    and the audited regenerate Stage lands on the Run's timeline.
  await page.getByRole("button", { name: "Regenerate summary" }).click();
  await expect(page.getByText("Working…")).toBeHidden();
  await expect(page.getByText("Extracted").first()).toBeVisible();
  const run = (await (
    await request.get(`/api/meeting-debrief/${encodeURIComponent(seeded.runId)}`)
  ).json()) as { review: { state: string } };
  /* Extraction is finished work: the only state left is whether the gated
     outward writes have gone out. */
  expect(run.review.state).toBe("extracted");
  const regenerated = (await (
    await request.get(`/api/runs/${encodeURIComponent(seeded.runId)}`)
  ).json()) as { events: Array<{ type: string }> };
  expect(regenerated.events.filter((event) => event.type === "debrief_regenerated")).toHaveLength(
    1,
  );

  // 2. The extracted action items are a record of the meeting, not a queue:
  //    the decisions on them are taken against canonical Action Items with
  //    stable identities, in Tasks (issue #199).
  await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Tasks", exact: true }).first()).toBeVisible();

  // 3. Confirm the roster through the Calendar seam; the owner is excluded.
  await page
    .getByLabel("Roster — one attendee per comma, as “Name <email>” or “email”")
    .fill(`Alice <alice@example.com>, Bob <bob@example.com>, Owner <${OWNER_EMAIL}>`);
  await page.getByRole("button", { name: "Confirm roster" }).click();
  await expect(page.getByText("Roster confirmed")).toBeVisible();
  await expect(
    page.getByText("alice@example.com — automatic (confirmed attendee)").first(),
  ).toBeVisible();

  // 4. A linked roster binds Calendar shells, so the gate opens: the
  //    approval section shows the Approve button and no blockers.
  await expect(page.getByRole("heading", { name: "Email draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create email draft" })).toBeVisible();
  await expect(page.getByText("Approval is blocked until:")).toBeHidden();

  // 5. Add a suggested non-attendee recipient through an explicit,
  //    verified Profile selection.
  await page.getByLabel("Search Person Profiles to add a recipient").fill("Carol");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /Add as recipient/ }).click();
  await expect(
    page.getByText("carol@example.com — added (confirmed Profile with verified email)"),
  ).toBeVisible();

  // 6. Approve: the Run locks, and every mutation seam refuses. Approval is
  //    verified through the API before anything is built on top of it.
  await page.getByRole("button", { name: "Create email draft" }).click();
  await waitForStatus(request, seeded.runId, "done");
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(seeded.runId)}`)
      ).json()) as { review: { state: string } | null };
      return detail.review?.state;
    })
    .toBe("published");
  await expect(page.getByText(/Email draft created/).first()).toBeVisible();
  /* A draft, never a sent message. The Gmail link itself needs a real draft
     receipt, which this hermetic server has no outward surface to create —
     the module test at that seam is where the link is proven. */
  await expect(page.getByText(/nothing has been sent/).first()).toBeVisible();
  const approvedDetail = (await (
    await request.get(`/api/meeting-debrief/${encodeURIComponent(seeded.runId)}`)
  ).json()) as {
    status: string;
    review: { state: string; automaticRecipients: Array<{ email: string }> };
  };
  expect(approvedDetail.status).toBe("done");
  expect(approvedDetail.review.state).toBe("published");
  expect(approvedDetail.review.automaticRecipients.map((r) => r.email)).toEqual([
    "alice@example.com",
    "bob@example.com",
  ]);
  const lockedTry = await request.post(
    `/api/meeting-debrief/${encodeURIComponent(seeded.runId)}/regenerate`,
    { data: { field: "summary" } },
  );
  expect(lockedTry.status()).toBe(409);

  // 7. Redo after approval: a distinct Run with a duplicate-output warning.
  //    The redo Run is identified through the API — the one Run of this
  //    transcript that is not the approved original — never by diffing the
  //    whole index, which other journeys' Runs also populate.
  await page.getByRole("button", { name: /Redo \(start a new debrief\)/i }).click();
  let redoRunId: string | null = null;
  await expect
    .poll(async () => {
      const index = (await (await request.get("/api/meeting-debrief/index")).json()) as {
        entries: Array<{ runId: string; transcriptId: string }>;
      };
      const candidates = index.entries.filter(
        (entry) => entry.transcriptId === transcript.id && entry.runId !== seeded.runId,
      );
      redoRunId = candidates[0]?.runId ?? null;
      return redoRunId;
    })
    .toBeTruthy();
  // The detail surface renders once; wait for the redo Run to hold its
  // review record — and the verified warning — before reading it on the page.
  await waitForStatus(request, redoRunId!, "done");
  await expect
    .poll(async () => {
      const detail = (await (
        await request.get(`/api/meeting-debrief/${encodeURIComponent(redoRunId!)}`)
      ).json()) as {
        review: { state: string; duplicateWarning: { approvedRunId: string } | null } | null;
      };
      return detail.review?.duplicateWarning?.approvedRunId ?? null;
    })
    .toBe(seeded.runId);
  await page.goto(`/meeting-debrief/${encodeURIComponent(redoRunId!)}`);
  await expect(page.getByText(/Duplicate output warning/)).toBeVisible();
  await expect(page.getByText(new RegExp(seeded.runId))).toBeVisible();
  const redoRun = (await (
    await request.get(`/api/runs/${encodeURIComponent(redoRunId!)}`)
  ).json()) as { events: Array<{ type: string }> };
  expect(redoRun.events.some((event) => event.type === "debrief_redo")).toBe(true);
});

test("meeting debrief journey — a Debrief never expires, and publishing stays gated", async ({
  page,
  request,
}) => {
  const unlinked = await seed(request, {
    transcript: transcriptRecord({
      id: "drive_journey_expiry_r1",
      source: {
        sourceSystem: "drive",
        externalFileId: "journey-expiry",
        fileName: "Expiry notes - 2026-07-01T09-00-00.000Z.md",
        sourceUrl: null,
        checksum: "journey-checksum-3",
        observedRevision: 1,
        modifiedAt: null,
      },
      normalizedText: "Carol: We agreed to revisit the pricing page next week.",
      meetingDate: "2026-07-01",
      occurrence: null,
      speakers: ["Carol"],
      roster: [],
    }),
  });
  await waitForStatus(request, unlinked.runId, "done");

  // Confirming a typed roster with no verified Profile shows the blocker
  // the approval gate refuses on.
  await page.goto(`/meeting-debrief/${encodeURIComponent(unlinked.runId)}`);
  await page
    .getByLabel("Roster — one attendee per comma, as “Name <email>” or “email”")
    .fill("Dana <dana@example.com>");
  await page.getByRole("button", { name: "Confirm roster" }).click();
  await expect(
    page.getByText(
      "dana@example.com has no Person Profile with a verified (Calendar-anchored) email.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create email draft" })).toBeHidden();

  /* Time passing takes nothing away. A Debrief used to skip itself after
     thirty unreviewed days, which meant work the owner had not got to was
     deleted on a timer; nothing waits for review now, so nothing expires. */
  const advanced = await request.post("/api/test/meeting-debrief/advance", {
    data: { ms: REVIEW_WAIT_MS },
  });
  expect(advanced.ok()).toBe(true);
  await waitForStatus(request, unlinked.runId, "done");

  await page.goto("/meeting-debrief");
  const row = page.getByRole("row", { name: /Expiry notes/ });
  await expect(row.getByText(/^Ready/)).toBeVisible();

  await page.getByRole("link", { name: /Expiry notes/ }).click();
  await expect(page.getByText("Extracted").first()).toBeVisible();
  /* Still there, in full: nothing was taken away by the clock. */
  await expect(
    page.getByText("We agreed to revisit the pricing page", { exact: false }).first(),
  ).toBeVisible();

  // Complete and readable, and still outward-silent until it is published.
  const run = (await (
    await request.get(`/api/runs/${encodeURIComponent(unlinked.runId)}`)
  ).json()) as { events: Array<{ type: string }>; files: string[] };
  expect(run.events.filter((event) => /draft|task|gmail|send/i.test(event.type))).toEqual([]);
  expect(run.files.sort()).toEqual(["result.json", "review.json"]);
});
