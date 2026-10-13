use super::*;

pub(super) fn id() -> String {
    Uuid::new_v4().to_string()
}
pub(super) fn field(label: &str, name: &str, value: &str, kind: &str) -> String {
    format!(
        "<label>{label}<input name=\"{name}\" type=\"{kind}\" value=\"{}\"></label>",
        escape(value)
    )
}
pub(super) fn textarea(label: &str, name: &str, value: &str) -> String {
    format!(
        "<label>{label}<textarea name=\"{name}\" rows=\"5\">{}</textarea></label>",
        escape(value)
    )
}
pub(super) fn revision_input(revision: u64) -> String {
    format!("<input type=\"hidden\" name=\"revision\" value=\"{revision}\">")
}
pub(super) fn post_button(url: &str, label: &str, revision: Option<u64>) -> String {
    format!(
        "<form method=\"post\" action=\"{}\">{}<button>{}</button></form>",
        escape(url),
        revision.map(revision_input).unwrap_or_default(),
        escape(label)
    )
}
pub(super) fn meeting_form(meeting: Option<&Meeting>) -> String {
    let title = meeting.map(|m| m.title.as_str()).unwrap_or("");
    let date = meeting.map(|m| m.starts_at.as_str()).unwrap_or("");
    let attendees = meeting.map(|m| m.attendees.as_str()).unwrap_or("");
    let purpose = meeting.map(|m| m.purpose.as_str()).unwrap_or("");
    let notes = meeting.map(|m| m.notes.as_str()).unwrap_or("");
    let url = meeting
        .map(|m| format!("/meetings/{}", m.id))
        .unwrap_or_else(|| "/meetings".into());
    format!(
        "<form method=\"post\" action=\"{url}\">{}{}{}{}{}{}<button>{}</button></form>",
        meeting
            .map(|m| revision_input(m.revision))
            .unwrap_or_default(),
        field("Title", "title", title, "text"),
        field(
            "Start (RFC 3339, with timezone, e.g. 2026-10-13T14:00:00-04:00)",
            "starts_at",
            date,
            "text"
        ),
        textarea("Attendees (names and emails)", "attendees", attendees),
        textarea("Purpose and agenda", "purpose", purpose),
        textarea("Private preparation notes", "notes", notes),
        if meeting.is_some() {
            "Save meeting"
        } else {
            "Create meeting"
        }
    )
}
pub(super) fn meeting_list(meetings: &[Meeting]) -> String {
    if meetings.is_empty() {
        return "<p>No meetings in this view. Create one or import your calendar.</p>".into();
    }
    let rows=meetings.iter().map(|m|format!("<tr><td><a href=\"/meetings/{}\">{}</a></td><td>{}</td><td>{}</td><td>{}</td></tr>",m.id,escape(&m.title),escape(&m.starts_at),escape(&m.attendees),escape(&m.state))).collect::<String>();
    format!(
        "<table><thead><tr><th>Meeting</th><th>Start</th><th>Attendees</th><th>State</th></tr></thead><tbody>{rows}</tbody></table>"
    )
}
pub(super) fn nav() -> &'static str {
    "<p><a href=\"/meetings\">Upcoming</a> · <a href=\"/meetings/history\">History</a> · <a href=\"/transcripts\">Transcript catalog</a> · <a href=\"/meetings/weekly\">Weekly review</a></p>"
}
pub(super) async fn require_meeting(db: &Db, id: &str) -> web::Result<Meeting> {
    db.get(MEETING, id)
        .await?
        .ok_or_else(|| Error::not_found("Meeting not found."))
}
pub(super) async fn require_transcript(db: &Db, id: &str) -> web::Result<Transcript> {
    db.get(TRANSCRIPT, id)
        .await?
        .ok_or_else(|| Error::not_found("Transcript not found."))
}
pub(super) fn checked_time(value: &str) -> web::Result<String> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|d| d.to_rfc3339())
        .map_err(|_| {
            Error::bad_request(
                "Start must be RFC 3339 with a timezone, for example 2026-10-13T14:00:00-04:00.",
            )
        })
}
pub(super) fn optional_text(value: &str, max: usize, label: &str) -> web::Result<String> {
    if value.len() > max {
        Err(Error::bad_request(format!("{label} is too long.")))
    } else {
        Ok(value.trim().to_owned())
    }
}
pub(super) fn input_values(
    input: &MeetingInput,
) -> web::Result<(String, String, String, String, String)> {
    Ok((
        web::required(&input.title, "Title", 300)?,
        checked_time(&input.starts_at)?,
        optional_text(&input.attendees, 10_000, "Attendees")?,
        optional_text(&input.purpose, 20_000, "Purpose")?,
        optional_text(&input.notes, 40_000, "Notes")?,
    ))
}

/// Manual intake is available even when the calendar connection is absent.
pub async fn create_record(db: &Db, input: MeetingInput) -> web::Result<Meeting> {
    let (title, starts_at, attendees, purpose, notes) = input_values(&input)?;
    let m = Meeting {
        id: id(),
        title,
        starts_at,
        attendees,
        purpose,
        notes,
        state: "scheduled".into(),
        calendar_event_id: None,
        revision: 1,
        created_at: crate::now_ms(),
    };
    db.put(MEETING, &m.id, m.clone()).await?;
    Ok(m)
}
pub(super) async fn create(
    State(app): State<App>,
    Form(input): Form<MeetingInput>,
) -> web::Result<Redirect> {
    let m = create_record(&app.db, input).await?;
    Ok(Redirect::to(&format!("/meetings/{}", m.id)))
}
pub(super) async fn index(State(app): State<App>) -> web::Result<Response> {
    let now = Utc::now();
    let mut meetings = app
        .db
        .list::<Meeting>(MEETING)
        .await?
        .into_iter()
        .filter(|m| {
            m.state == "scheduled"
                && DateTime::parse_from_rfc3339(&m.starts_at)
                    .is_ok_and(|t| t.with_timezone(&Utc) >= now - Duration::hours(1))
        })
        .collect::<Vec<_>>();
    meetings.sort_by_key(|m| DateTime::parse_from_rfc3339(&m.starts_at).ok());
    Ok(web::page(
        "Meeting Wizard",
        format!(
            "{}<p>Prepare from the facts you have, keep transcripts as evidence, and review follow-through before it becomes a task.</p><h2>Upcoming meetings</h2>{}<details><summary>Import Google Calendar</summary><p>Imports the next 30 days and the past 30 days. Reimports update calendar facts without replacing your notes.</p><form method=\"post\" action=\"/meetings/calendar\">{}<button>Import calendar</button></form></details><h2>Create a meeting</h2>{}",
            nav(),
            meeting_list(&meetings),
            field("Calendar ID", "calendar_id", "primary", "text"),
            meeting_form(None)
        ),
    ))
}
pub(super) async fn history(State(app): State<App>) -> web::Result<Response> {
    let now = Utc::now();
    let mut meetings = app
        .db
        .list::<Meeting>(MEETING)
        .await?
        .into_iter()
        .filter(|m| {
            m.state != "scheduled"
                || DateTime::parse_from_rfc3339(&m.starts_at)
                    .is_ok_and(|t| t.with_timezone(&Utc) < now)
        })
        .collect::<Vec<_>>();
    meetings.sort_by_key(|m| std::cmp::Reverse(DateTime::parse_from_rfc3339(&m.starts_at).ok()));
    Ok(web::page(
        "Meeting history",
        format!("{}{}", nav(), meeting_list(&meetings)),
    ))
}
pub(super) async fn detail(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
) -> web::Result<Response> {
    let m = require_meeting(&app.db, &meeting_id).await?;
    let transcripts = app
        .db
        .list::<Transcript>(TRANSCRIPT)
        .await?
        .into_iter()
        .filter(|t| t.meeting_id.as_deref() == Some(&m.id))
        .collect::<Vec<_>>();
    let artifacts = app
        .db
        .list::<Artifact>(ARTIFACT)
        .await?
        .into_iter()
        .filter(|a| a.meeting_id == m.id)
        .collect::<Vec<_>>();
    let transcript_links = if transcripts.is_empty() {
        "<p>No transcript is associated. Upload text in the catalog and confirm this meeting.</p>"
            .into()
    } else {
        transcripts
            .iter()
            .map(|t| {
                format!(
                    "<li><a href=\"/transcripts/{}\">{}</a> · {}</li>",
                    t.id,
                    escape(&t.title),
                    escape(&t.association)
                )
            })
            .collect::<String>()
    };
    let preferences = crate::settings::load(&app.db).await?;
    let state_options = ["scheduled", "completed", "cancelled"]
        .into_iter()
        .map(|state| {
            format!(
                "<option value=\"{state}\"{}>{state}</option>",
                if state == m.state { " selected" } else { "" }
            )
        })
        .collect::<String>();
    let artifact_links = if artifacts.is_empty() {
        "<p>No generated drafts yet.</p>".into()
    } else {
        artifacts
            .iter()
            .map(|a| {
                format!(
                    "<li><a href=\"/meetings/{}/artifacts/{}\">{} · {}</a> · {}{}</li>",
                    m.id,
                    a.id,
                    escape(&a.kind),
                    web::saved_time(a.created_at, &preferences.timezone),
                    if a.reviewed { "reviewed" } else { "draft" },
                    if a.meeting_revision != m.revision {
                        " · meeting changed since generation"
                    } else {
                        ""
                    }
                )
            })
            .collect::<String>()
    };
    Ok(web::page(
        &m.title,
        format!(
            "{}<p>{} · {}</p><h2>Preparation</h2>{}<h2>Debrief</h2><p>Debriefs use only confirmed transcripts. Generated action items remain proposals until reviewed.</p>{}<h2>Draft history</h2><ul>{}</ul><h2>Associated transcripts</h2><ul>{}</ul><a href=\"/transcripts\">Add or review transcripts</a><h2>Edit meeting</h2>{}<h2>Meeting state</h2><form method=\"post\" action=\"/meetings/{}/state\">{}<label>State<select name=\"state\">{}</select></label><button>Set state</button></form><details><summary>Delete meeting</summary><p>This removes the meeting and its draft artifacts. Transcripts return to the unassigned catalog. Captured action items and tasks remain.</p>{}</details>",
            nav(),
            escape(&m.starts_at),
            escape(&m.state),
            post_button(
                &format!("/meetings/{}/brief", m.id),
                "Generate preparation brief",
                Some(m.revision)
            ),
            post_button(
                &format!("/meetings/{}/debrief", m.id),
                "Generate debrief",
                Some(m.revision)
            ),
            artifact_links,
            transcript_links,
            meeting_form(Some(&m)),
            m.id,
            revision_input(m.revision),
            state_options,
            post_button(
                &format!("/meetings/{}/delete", m.id),
                "Delete meeting",
                Some(m.revision)
            )
        ),
    ))
}
pub(super) async fn edit(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
    Form(input): Form<MeetingInput>,
) -> web::Result<Redirect> {
    let (title, starts_at, attendees, purpose, notes) = input_values(&input)?;
    let expected = input
        .revision
        .ok_or_else(|| Error::bad_request("Meeting revision is required."))?;
    let target = meeting_id.clone();
    let changed = app
        .db
        .transaction(move |tx| {
            let Some(mut m) = store::get::<Meeting>(tx, MEETING, &target)? else {
                anyhow::bail!("Meeting missing")
            };
            if m.revision != expected {
                return Ok(false);
            }
            m.title = title;
            m.starts_at = starts_at;
            m.attendees = attendees;
            m.purpose = purpose;
            m.notes = notes;
            m.revision += 1;
            store::put(tx, MEETING, &m.id, &m)?;
            Ok(true)
        })
        .await?;
    if !changed {
        return Err(Error::conflict(
            "Meeting changed while this form was open. Reload before saving.",
        ));
    }
    Ok(Redirect::to(&format!("/meetings/{meeting_id}")))
}
pub(super) async fn change_state(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
    Form(input): Form<StateInput>,
) -> web::Result<Redirect> {
    if !["scheduled", "completed", "cancelled"].contains(&input.state.as_str()) {
        return Err(Error::bad_request("Unknown meeting state."));
    }
    let target = meeting_id.clone();
    let saved = app
        .db
        .transaction(move |tx| {
            let Some(mut m) = store::get::<Meeting>(tx, MEETING, &target)? else {
                anyhow::bail!("Meeting missing")
            };
            if m.revision != input.revision {
                return Ok(false);
            }
            m.state = input.state;
            m.revision += 1;
            store::put(tx, MEETING, &m.id, &m)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(Error::conflict("Meeting changed; reload this form."));
    }
    Ok(Redirect::to(&format!("/meetings/{meeting_id}")))
}
pub(super) async fn delete_meeting(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
    Form(input): Form<RevisionInput>,
) -> web::Result<Redirect> {
    let saved = app
        .db
        .transaction(move |tx| {
            let Some(m) = store::get::<Meeting>(tx, MEETING, &meeting_id)? else {
                return Ok(true);
            };
            if m.revision != input.revision {
                return Ok(false);
            }
            for mut t in store::list::<Transcript>(tx, TRANSCRIPT)?
                .into_iter()
                .filter(|t| t.meeting_id.as_deref() == Some(&meeting_id))
            {
                t.meeting_id = None;
                t.association = "unassigned after meeting deletion".into();
                t.revision += 1;
                store::put(tx, TRANSCRIPT, &t.id, &t)?;
            }
            for a in store::list::<Artifact>(tx, ARTIFACT)?
                .into_iter()
                .filter(|a| a.meeting_id == meeting_id)
            {
                store::delete(tx, ARTIFACT, &a.id)?;
            }
            store::delete(tx, MEETING, &meeting_id)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(Error::conflict("Meeting changed; reload before deleting."));
    }
    Ok(Redirect::to("/meetings"))
}

pub(super) async fn catalog(State(app): State<App>) -> web::Result<Response> {
    let transcripts = app.db.list::<Transcript>(TRANSCRIPT).await?;
    let meetings = app.db.list::<Meeting>(MEETING).await?;
    let options = meeting_options(&meetings, None);
    let tombstones = app.db.list::<TranscriptTombstone>(TOMBSTONE).await?;
    let excluded = tombstones.iter().map(|t|format!("<li>{}<form method=\"post\" action=\"/transcripts/allow-reimport\"><input type=\"hidden\" name=\"source_id\" value=\"{}\"><button>Allow this file on the next import</button></form></li>",escape(&t.title),escape(&t.source_id))).collect::<String>();
    let rows = transcripts
        .iter()
        .map(|t| {
            format!(
                "<tr><td><a href=\"/transcripts/{}\">{}</a></td><td>{}</td><td>{}</td></tr>",
                t.id,
                escape(&t.title),
                escape(&t.association),
                t.text.len()
            )
        })
        .collect::<String>();
    Ok(web::page(
        "Transcript catalog",
        format!(
            "{}<p>Matching suggestions are evidence for review. A title match never silently places a transcript on a meeting.</p><table><thead><tr><th>Transcript</th><th>Association</th><th>Bytes</th></tr></thead><tbody>{rows}</tbody></table><h2>Add transcript text</h2><form method=\"post\" action=\"/transcripts\">{}{}<label>Confirm meeting<select name=\"meeting_id\">{options}</select></label><button>Save transcript</button></form><h2>Import from Google Drive</h2><p>Lists text/plain files and Google Docs whose names contain transcript. New imports stay unassigned until you confirm a meeting. Existing imported evidence is kept. Deleted imported files stay excluded until you allow them again.</p>{}<h3>Excluded imported files</h3><ul>{excluded}</ul>",
            nav(),
            field("Transcript title", "title", "", "text"),
            textarea("Transcript text", "text", ""),
            "<p>Choose a transcript folder and authorize it in <a href=\"/settings\">Settings</a> first.</p><form method=\"post\" action=\"/transcripts/drive\"><label><input type=\"checkbox\" name=\"consent\" value=\"yes\" required>I authorize importing transcripts from the selected folder for this run.</label><button>Import Drive transcripts</button></form>"
        ),
    ))
}
pub(super) fn meeting_options(meetings: &[Meeting], selected: Option<&str>) -> String {
    format!(
        "<option value=\"\">Unassigned</option>{}",
        meetings
            .iter()
            .map(|m| format!(
                "<option value=\"{}\"{}>{} · {}</option>",
                m.id,
                if selected == Some(m.id.as_str()) {
                    " selected"
                } else {
                    ""
                },
                escape(&m.title),
                escape(&m.starts_at)
            ))
            .collect::<String>()
    )
}
/// A person's explicit association is persisted as provenance, not inferred from a title.
pub async fn upload_record(
    db: &Db,
    title: &str,
    text: &str,
    meeting_id: Option<String>,
) -> web::Result<Transcript> {
    let title = web::required(title, "Transcript title", 300)?;
    let text = web::required(text, "Transcript text", 500_000)?;
    if let Some(ref meeting_id) = meeting_id {
        require_meeting(db, meeting_id).await?;
    }
    let transcript = Transcript {
        id: id(),
        title,
        text,
        association: if meeting_id.is_some() {
            "confirmed by user"
        } else {
            "unassigned"
        }
        .into(),
        meeting_id,
        source_id: None,
        source_url: None,
        revision: 1,
        created_at: crate::now_ms(),
    };
    db.put(TRANSCRIPT, &transcript.id, transcript.clone())
        .await?;
    Ok(transcript)
}
pub(super) async fn upload(
    State(app): State<App>,
    Form(input): Form<TranscriptInput>,
) -> web::Result<Redirect> {
    let meeting_id = if input.meeting_id.is_empty() {
        None
    } else {
        Some(input.meeting_id)
    };
    let t = upload_record(&app.db, &input.title, &input.text, meeting_id).await?;
    Ok(Redirect::to(&format!("/transcripts/{}", t.id)))
}
pub(super) async fn transcript_detail(
    State(app): State<App>,
    Path(transcript_id): Path<String>,
) -> web::Result<Response> {
    let t = require_transcript(&app.db, &transcript_id).await?;
    let meetings = app.db.list::<Meeting>(MEETING).await?;
    let suggestions = meetings
        .iter()
        .filter(|m| titles_overlap(&t.title, &m.title))
        .map(|m| {
            format!(
                "<li><a href=\"/meetings/{}\">{}</a> · {} · shared words in title</li>",
                m.id,
                escape(&m.title),
                escape(&m.starts_at)
            )
        })
        .collect::<String>();
    let linked = t
        .meeting_id
        .as_ref()
        .map(|id| format!("<a href=\"/meetings/{id}\">Open associated meeting</a>"))
        .unwrap_or_default();
    Ok(web::page(
        &t.title,
        format!(
            "{}<p>{} · {linked}</p><h2>Review association</h2><p>Suggested meetings (title overlap only; verify the date and speakers):</p><ul>{}</ul><form method=\"post\" action=\"/transcripts/{}/associate\">{}<label>Confirmed meeting<select name=\"meeting_id\">{}</select></label><button>Confirm association</button></form><h2>Source evidence</h2><pre>{}</pre><details><summary>Delete transcript</summary><p>Deleting this evidence makes related generated drafts stale. Captured action items and tasks remain.</p>{}</details>",
            nav(),
            escape(&t.association),
            if suggestions.is_empty() {
                "<li>No title matches. You may choose any meeting after checking the evidence.</li>"
                    .into()
            } else {
                suggestions
            },
            t.id,
            revision_input(t.revision),
            meeting_options(&meetings, t.meeting_id.as_deref()),
            escape(&t.text),
            post_button(
                &format!("/transcripts/{}/delete", t.id),
                "Delete transcript",
                Some(t.revision)
            )
        ),
    ))
}
pub(super) fn titles_overlap(left: &str, right: &str) -> bool {
    let words = |s: &str| {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 3)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let a = words(left);
    let b = words(right);
    a.iter().any(|word| b.contains(word))
}
pub(super) async fn associate(
    State(app): State<App>,
    Path(transcript_id): Path<String>,
    Form(input): Form<AssociationInput>,
) -> web::Result<Redirect> {
    let target = transcript_id.clone();
    let saved = app
        .db
        .transaction(move |tx| {
            let Some(mut t) = store::get::<Transcript>(tx, TRANSCRIPT, &target)? else {
                anyhow::bail!("Transcript missing")
            };
            if t.revision != input.revision {
                return Ok(false);
            }
            let next = if input.meeting_id.is_empty() {
                None
            } else {
                if store::get::<Meeting>(tx, MEETING, &input.meeting_id)?.is_none() {
                    anyhow::bail!("Meeting missing")
                };
                Some(input.meeting_id)
            };
            t.meeting_id = next;
            t.association = if t.meeting_id.is_some() {
                "confirmed by user"
            } else {
                "unassigned by user"
            }
            .into();
            t.revision += 1;
            store::put(tx, TRANSCRIPT, &t.id, &t)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(Error::conflict(
            "Transcript changed; reload before confirming.",
        ));
    }
    Ok(Redirect::to(&format!("/transcripts/{transcript_id}")))
}
pub(super) async fn delete_transcript(
    State(app): State<App>,
    Path(transcript_id): Path<String>,
    Form(input): Form<RevisionInput>,
) -> web::Result<Redirect> {
    let saved = app
        .db
        .transaction(move |tx| {
            let Some(t) = store::get::<Transcript>(tx, TRANSCRIPT, &transcript_id)? else {
                return Ok(true);
            };
            if t.revision != input.revision {
                return Ok(false);
            }
            if let Some(source_id) = &t.source_id {
                let marker = TranscriptTombstone {
                    source_id: source_id.clone(),
                    title: t.title.clone(),
                    deleted_at: crate::now_ms(),
                };
                store::put(tx, TOMBSTONE, source_id, &marker)?;
            }
            store::delete(tx, TRANSCRIPT, &transcript_id)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(Error::conflict(
            "Transcript changed; reload before deleting.",
        ));
    }
    Ok(Redirect::to("/transcripts"))
}
pub(super) async fn allow_reimport(
    State(app): State<App>,
    Form(input): Form<ReimportInput>,
) -> web::Result<Redirect> {
    app.db.delete(TOMBSTONE, &input.source_id).await?;
    Ok(Redirect::to("/transcripts"))
}
