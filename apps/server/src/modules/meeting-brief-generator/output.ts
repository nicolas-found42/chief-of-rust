import type {
  DailyBriefing,
  DailyBriefingBriefStatus,
  DailyBriefingWork,
  MeetingBrief,
} from "@chief-of-staff-demo/shared";
/**
 * Gmail Output Adapter — Meeting Brief rendering (ADR-0034).
 *
 * Renders a concise plain-text/HTML email from the structured Meeting Brief.
 * Deterministic logistics + source links. No recipient field: caller supplies
 * owner email structurally, never from event/API/model. Never emails External Guest.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatWhen(startAt: string, endAt: string): string {
  try {
    const s = new Date(startAt).toISOString();
    const e = new Date(endAt).toISOString();
    return `${s} — ${e}`;
  } catch {
    return `${startAt} — ${endAt}`;
  }
}

export interface RenderedMeetingBriefEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render the structured Meeting Brief as owner-only email.
 * @param brief - structured brief from compose stage
 * @param isRevision - true when this Run supersedes a prior Run
 */
export function renderMeetingBriefEmail(
  brief: MeetingBrief,
  isRevision: boolean,
): RenderedMeetingBriefEmail {
  const prefix = isRevision ? "Updated Meeting Brief" : "Meeting Brief";
  const logistics = brief.logistics;
  const title = logistics.title;
  const when = formatWhen(logistics.startAt, logistics.endAt);
  const subject = `${prefix}: ${title}`;

  const lines: string[] = [];
  lines.push(`${prefix}: ${title}`);
  lines.push(`When: ${when}`);
  if (logistics.location) lines.push(`Where: ${logistics.location}`);
  if (logistics.conferenceLink) lines.push(`Join: ${logistics.conferenceLink}`);
  if (logistics.organizer) {
    const o = logistics.organizer;
    lines.push(`Organizer: ${o.displayName ? `${o.displayName} <${o.email}>` : o.email}`);
  }
  lines.push("");
  lines.push(brief.summary);
  lines.push("");

  const guests = brief.guests;
  if (guests.length > 0) {
    lines.push("Guests:");
    for (const g of guests) {
      const guestHistory = g.relationshipHistory;
      const guestTalking = g.talkingPoints;
      const guestUncert = g.uncertainty;
      const guestRefs = g.evidenceReferences;
      lines.push(`- ${g.name ? `${g.name} <${g.email}>` : g.email}${g.role ? ` — ${g.role}` : ""}`);
      if (g.background) lines.push(`  Background: ${g.background}`);
      if (guestHistory.length > 0) {
        lines.push(`  Relationship history:`);
        for (const r of guestHistory) lines.push(`    • ${r}`);
      }
      if (g.crmContext) lines.push(`  CRM: ${g.crmContext}`);
      if (guestTalking.length > 0) {
        lines.push(`  Talking points:`);
        for (const t of guestTalking) lines.push(`    • ${t}`);
      }
      if (guestUncert.length > 0) lines.push(`  Uncertainty: ${guestUncert.join("; ")}`);
      if (guestRefs.length > 0) lines.push(`  Sources: ${guestRefs.join(", ")}`);
    }
    lines.push("");
  }

  const companies = brief.companies;
  if (companies.length > 0) {
    lines.push("Companies:");
    for (const c of companies) {
      const cDocs = c.docs;
      const cNews = c.news;
      const cIndustry = c.industry;
      const cUncert = c.uncertainty;
      const cRefs = c.evidenceReferences;
      lines.push(`- ${c.name}${c.domain ? ` (${c.domain})` : ""}`);
      if (c.hubspotContext) lines.push(`  HubSpot: ${c.hubspotContext}`);
      if (cDocs.length > 0) {
        lines.push(`  Docs:`);
        for (const d of cDocs) lines.push(`    • ${d}`);
      }
      if (cNews.length > 0) {
        lines.push(`  News:`);
        for (const n of cNews) lines.push(`    • ${n}`);
      }
      if (cIndustry.length > 0) {
        lines.push(`  Industry:`);
        for (const ind of cIndustry) lines.push(`    • ${ind}`);
      }
      if (cUncert.length > 0) lines.push(`  Uncertainty: ${cUncert.join("; ")}`);
      if (cRefs.length > 0) lines.push(`  Sources: ${cRefs.join(", ")}`);
    }
    lines.push("");
  }

  const starters = brief.conversationStarters;
  if (starters.length > 0) {
    lines.push("Conversation starters:");
    for (const s of starters) lines.push(`- ${s}`);
    lines.push("");
  }

  const srcRefs = brief.sourceReferences;
  if (srcRefs.length > 0) {
    lines.push("Source references:");
    for (const r of srcRefs) lines.push(`- ${r}`);
    lines.push("");
  }

  const missing = brief.missingEvidence;
  if (missing.length > 0) {
    lines.push("Missing evidence:");
    for (const m of missing) lines.push(`- ${m}`);
    lines.push("");
  }

  const uncert = brief.uncertainty;
  if (uncert.length > 0) {
    lines.push("Uncertainty:");
    for (const u of uncert) lines.push(`- ${u}`);
    lines.push("");
  }

  lines.push(`—`);
  lines.push(`Event: ${brief.eventId} · ${brief.occurrenceId} · ${brief.eventVersion}`);
  lines.push(`Generated: ${brief.generatedAt}`);

  const text = lines.join("\n");

  const htmlLines: string[] = [];
  htmlLines.push(
    `<div style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height:1.5; color:#111; max-width:640px">`,
  );
  htmlLines.push(`<h2 style="margin:0 0 8px 0">${escapeHtml(prefix)}: ${escapeHtml(title)}</h2>`);
  htmlLines.push(`<div style="color:#555; font-size:14px; margin-bottom:12px">`);
  htmlLines.push(`<div>When: ${escapeHtml(when)}</div>`);
  if (logistics.location) htmlLines.push(`<div>Where: ${escapeHtml(logistics.location)}</div>`);
  if (logistics.conferenceLink)
    htmlLines.push(
      `<div>Join: <a href="${escapeHtml(logistics.conferenceLink)}">${escapeHtml(logistics.conferenceLink)}</a></div>`,
    );
  if (logistics.organizer) {
    const o = logistics.organizer;
    htmlLines.push(
      `<div>Organizer: ${escapeHtml(o.displayName ? `${o.displayName} <${o.email}>` : o.email)}</div>`,
    );
  }
  htmlLines.push(`</div>`);
  htmlLines.push(`<p>${escapeHtml(brief.summary)}</p>`);

  if (guests.length > 0) {
    htmlLines.push(`<h3 style="margin:16px 0 8px 0">Guests</h3>`);
    for (const g of guests) {
      const gHistory = g.relationshipHistory;
      const gTalking = g.talkingPoints;
      const gUncert = g.uncertainty;
      const gRefs = g.evidenceReferences;
      htmlLines.push(
        `<div style="margin-bottom:12px; padding:8px; border:1px solid #eee; border-radius:8px">`,
      );
      htmlLines.push(
        `<div><strong>${escapeHtml(g.name ? `${g.name} <${g.email}>` : g.email)}</strong>${g.role ? ` — ${escapeHtml(g.role)}` : ""}</div>`,
      );
      if (g.background)
        htmlLines.push(`<div style="color:#333">Background: ${escapeHtml(g.background)}</div>`);
      if (gHistory.length > 0) {
        htmlLines.push(`<div>Relationship history:<ul>`);
        for (const r of gHistory) htmlLines.push(`<li>${escapeHtml(r)}</li>`);
        htmlLines.push(`</ul></div>`);
      }
      if (g.crmContext) htmlLines.push(`<div>CRM: ${escapeHtml(g.crmContext)}</div>`);
      if (gTalking.length > 0) {
        htmlLines.push(`<div>Talking points:<ul>`);
        for (const t of gTalking) htmlLines.push(`<li>${escapeHtml(t)}</li>`);
        htmlLines.push(`</ul></div>`);
      }
      if (gUncert.length > 0)
        htmlLines.push(
          `<div style="color:#666">Uncertainty: ${escapeHtml(gUncert.join("; "))}</div>`,
        );
      if (gRefs.length > 0) {
        htmlLines.push(`<div>Sources: `);
        const refs = gRefs.map((r) => `<a href="${escapeHtml(r)}">${escapeHtml(r)}</a>`).join(", ");
        htmlLines.push(refs + `</div>`);
      }
      htmlLines.push(`</div>`);
    }
  }

  if (companies.length > 0) {
    htmlLines.push(`<h3 style="margin:16px 0 8px 0">Companies</h3>`);
    for (const c of companies) {
      const cDocs = c.docs;
      const cNews = c.news;
      const cIndustry = c.industry;
      const cUncert = c.uncertainty;
      const cRefs = c.evidenceReferences;
      htmlLines.push(
        `<div style="margin-bottom:12px; padding:8px; border:1px solid #eee; border-radius:8px">`,
      );
      htmlLines.push(
        `<div><strong>${escapeHtml(c.name)}</strong>${c.domain ? ` (${escapeHtml(c.domain)})` : ""}</div>`,
      );
      if (c.hubspotContext) htmlLines.push(`<div>HubSpot: ${escapeHtml(c.hubspotContext)}</div>`);
      if (cDocs.length > 0) {
        htmlLines.push(`<div>Docs:<ul>`);
        for (const d of cDocs) htmlLines.push(`<li>${escapeHtml(d)}</li>`);
        htmlLines.push(`</ul></div>`);
      }
      if (cNews.length > 0) {
        htmlLines.push(`<div>News:<ul>`);
        for (const n of cNews) htmlLines.push(`<li>${escapeHtml(n)}</li>`);
        htmlLines.push(`</ul></div>`);
      }
      if (cIndustry.length > 0) {
        htmlLines.push(`<div>Industry:<ul>`);
        for (const ind of cIndustry) htmlLines.push(`<li>${escapeHtml(ind)}</li>`);
        htmlLines.push(`</ul></div>`);
      }
      if (cUncert.length > 0)
        htmlLines.push(
          `<div style="color:#666">Uncertainty: ${escapeHtml(cUncert.join("; "))}</div>`,
        );
      if (cRefs.length > 0) {
        htmlLines.push(`<div>Sources: `);
        const refs = cRefs.map((r) => `<a href="${escapeHtml(r)}">${escapeHtml(r)}</a>`).join(", ");
        htmlLines.push(refs + `</div>`);
      }
      htmlLines.push(`</div>`);
    }
  }

  if (starters.length > 0) {
    htmlLines.push(`<h3>Conversation starters</h3><ul>`);
    for (const s of starters) htmlLines.push(`<li>${escapeHtml(s)}</li>`);
    htmlLines.push(`</ul>`);
  }

  if (srcRefs.length > 0) {
    htmlLines.push(`<h3>Source references</h3><ul>`);
    for (const r of srcRefs)
      htmlLines.push(`<li><a href="${escapeHtml(r)}">${escapeHtml(r)}</a></li>`);
    htmlLines.push(`</ul>`);
  }

  if (missing.length > 0) {
    htmlLines.push(`<div style="color:#666"><strong>Missing evidence:</strong><ul>`);
    for (const m of missing) htmlLines.push(`<li>${escapeHtml(m)}</li>`);
    htmlLines.push(`</ul></div>`);
  }

  if (uncert.length > 0) {
    htmlLines.push(`<div style="color:#666"><strong>Uncertainty:</strong><ul>`);
    for (const u of uncert) htmlLines.push(`<li>${escapeHtml(u)}</li>`);
    htmlLines.push(`</ul></div>`);
  }

  htmlLines.push(
    `<hr style="margin:16px 0; border:none; border-top:1px solid #eee" /><div style="color:#888; font-size:12px">Event: ${escapeHtml(brief.eventId)} · ${escapeHtml(brief.occurrenceId)} · ${escapeHtml(brief.eventVersion)} · Generated: ${escapeHtml(brief.generatedAt)}</div>`,
  );
  htmlLines.push(`</div>`);

  const html = htmlLines.join("\n");

  return { subject, text, html };
}

/** Said the way a person would say it: what the Brief state means for the day. */
function briefingStatusLabel(status: DailyBriefingBriefStatus): string {
  if (status === "ready") return "Brief ready";
  if (status === "pending") return "Brief pending";
  if (status === "failed") return "Brief failed — retry it";
  return "No brief yet";
}

function formatMeetingWhen(startAt: string): string {
  const ms = Date.parse(startAt);
  if (Number.isNaN(ms)) return startAt;
  return new Date(ms).toLocaleString();
}

/**
 * Render the Daily Briefing as owner-only email (issue #163). Deterministic
 * rollup of the day's Meetings and their Brief state — the same read model
 * the home surface shows. No recipient field: the caller sends owner-only
 * through the Gmail delivery adapter, never to External Guests.
 */

/**
 * The Task and Action Item sections a Daily Briefing email carries (issue
 * #192), in the order they matter. An empty section is omitted rather than
 * rendered as a zero, and a capped one says how many rows it did not draw.
 */
function workSections(
  work: DailyBriefingWork,
): Array<{ heading: string; rows: string[]; more: number }> {
  const due = (dueDate: string | null): string => (dueDate ? ` · due ${dueDate}` : "");
  const sections = [
    {
      heading: "Overdue Tasks",
      rows: work.overdue.map((task) => `${task.title}${due(task.dueDate)}`),
      more: work.totals.overdue - work.overdue.length,
    },
    {
      heading: "Tasks due today",
      rows: work.dueToday.map((task) => task.title),
      more: work.totals.dueToday - work.dueToday.length,
    },
    {
      heading: "High priority",
      rows: work.highPriority.map((task) => `${task.title}${due(task.dueDate)}`),
      more: work.totals.highPriority - work.highPriority.length,
    },
    {
      heading: "Action Items awaiting review",
      rows: work.pendingActionItems.map((item) => `${item.title}${due(item.dueDate)}`),
      more: work.totals.pendingActionItems - work.pendingActionItems.length,
    },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

export function renderDailyBriefingEmail(briefing: DailyBriefing): RenderedMeetingBriefEmail {
  const subject = `Daily Briefing: ${briefing.date}`;
  const lines: string[] = [subject, "", briefing.summary, "", "Today's meetings:"];
  for (const meeting of briefing.meetings) {
    lines.push(
      `- ${meeting.title} · ${formatMeetingWhen(meeting.startAt)} · ${briefingStatusLabel(meeting.briefStatus)}`,
    );
  }
  if (briefing.meetings.length === 0) lines.push("- None");
  /* Tasks and Action Items stay separate sections with separate headings: an
     email that ran them together would read as a list of commitments, and half
     of it would be proposals nobody has accepted yet (issue #192). */
  for (const section of workSections(briefing.work)) {
    lines.push("", `${section.heading}:`);
    for (const row of section.rows) lines.push(`- ${row}`);
    if (section.more > 0) lines.push(`- and ${section.more} more`);
  }
  const text = lines.join("\n");

  const htmlLines: string[] = [];
  htmlLines.push(
    `<div style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height:1.5; color:#111; max-width:640px">`,
  );
  htmlLines.push(`<h2 style="margin:0 0 8px 0">${escapeHtml(subject)}</h2>`);
  htmlLines.push(`<p>${escapeHtml(briefing.summary)}</p>`);
  htmlLines.push(`<h3 style="margin:16px 0 8px 0">Today's meetings</h3><ul>`);
  for (const meeting of briefing.meetings) {
    htmlLines.push(
      `<li><strong>${escapeHtml(meeting.title)}</strong> · ${escapeHtml(formatMeetingWhen(meeting.startAt))} · ${escapeHtml(briefingStatusLabel(meeting.briefStatus))}</li>`,
    );
  }
  htmlLines.push(`</ul>`);
  for (const section of workSections(briefing.work)) {
    htmlLines.push(`<h3 style="margin:16px 0 8px 0">${escapeHtml(section.heading)}</h3><ul>`);
    for (const row of section.rows) htmlLines.push(`<li>${escapeHtml(row)}</li>`);
    if (section.more > 0) htmlLines.push(`<li>and ${section.more} more</li>`);
    htmlLines.push(`</ul>`);
  }
  htmlLines.push(
    `<hr style="margin:16px 0; border:none; border-top:1px solid #eee" /><div style="color:#888; font-size:12px">Daily Briefing for ${escapeHtml(briefing.date)}</div>`,
  );
  htmlLines.push(`</div>`);
  return { subject, text, html: htmlLines.join("\n") };
}
