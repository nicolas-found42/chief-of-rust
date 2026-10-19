use super::*;

pub(super) fn id() -> String {
    Uuid::new_v4().to_string()
}
pub(super) fn meeting_form(
    meeting: Option<&Meeting>,
    timezone: &str,
    submitted: Option<&MeetingFormInput>,
) -> String {
    let zone = timezone.parse::<chrono_tz::Tz>().unwrap_or(chrono_tz::UTC);
    let defaults = MeetingFormInput {
        title: meeting.map(|m| m.title.clone()).unwrap_or_default(),
        starts_at: meeting
            .and_then(|m| DateTime::parse_from_rfc3339(&m.starts_at).ok())
            .map(|date| {
                date.with_timezone(&zone)
                    .format("%Y-%m-%dT%H:%M:%S%.f")
                    .to_string()
            })
            .unwrap_or_default(),
        attendees: meeting.map(|m| m.attendees.clone()).unwrap_or_default(),
        purpose: meeting.map(|m| m.purpose.clone()).unwrap_or_default(),
        notes: meeting.map(|m| m.notes.clone()).unwrap_or_default(),
        timezone: Some(timezone.to_owned()),
        revision: meeting.map(|m| m.revision),
        original_starts_at: meeting.map(|m| m.starts_at.clone()),
    };
    let form = submitted.unwrap_or(&defaults);
    let date_type = if form.starts_at.is_empty()
        || chrono::NaiveDateTime::parse_from_str(&form.starts_at, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || chrono::NaiveDateTime::parse_from_str(&form.starts_at, "%Y-%m-%dT%H:%M").is_ok()
    {
        "datetime-local"
    } else {
        "text"
    };
    let original = form
        .original_starts_at
        .as_deref()
        .map(|value| {
            format!(
                "<input type=\"hidden\" name=\"original_starts_at\" value=\"{}\">",
                escape(value)
            )
        })
        .unwrap_or_default();
    let revision = form.revision.map(web::revision_input).unwrap_or_default();
    let url = meeting
        .map(|m| format!("/meetings/{}", m.id))
        .unwrap_or_else(|| "/meetings".into());
    format!(
        "<form class=\"form-grid\" method=\"post\" action=\"{url}\">{revision}{original}{}{}{}{}{}{}<button class=\"btn-primary\">{}</button></form>",
        format_args!(
            "<label>Title<input name=\"title\" value=\"{}\" required maxlength=\"300\"></label>",
            escape(&form.title)
        ),
        format_args!(
            "<label>Start date and time<input name=\"starts_at\" type=\"{date_type}\" step=\"any\" value=\"{}\" required></label>",
            escape(&form.starts_at)
        ),
        format_args!(
            "<label>Time zone<span class=\"badge badge-neutral\">{}</span><input name=\"timezone\" type=\"text\" value=\"{}\" required></label>",
            escape(timezone),
            escape(form.timezone.as_deref().unwrap_or(timezone))
        ),
        web::textarea("Attendees (names and emails)", "attendees", &form.attendees),
        web::textarea("Purpose and agenda", "purpose", &form.purpose),
        web::textarea("Private preparation notes", "notes", &form.notes),
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
    let rows=meetings.iter().map(|m|format!("<tr><td><a href=\"/meetings/{}\">{}</a></td><td>{}</td><td>{}</td><td>{}</td></tr>",m.id,escape(&m.title),web::timestamp(&m.starts_at),escape(&m.attendees),web::badge(&m.state))).collect::<String>();
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
// Browser forms use wall-clock input; the record API retains explicit instants.
#[derive(Clone, Deserialize)]
pub(super) struct MeetingFormInput {
    title: String,
    starts_at: String,
    #[serde(default)]
    attendees: String,
    #[serde(default)]
    purpose: String,
    #[serde(default)]
    notes: String,
    revision: Option<u64>,
    timezone: Option<String>,
    original_starts_at: Option<String>,
}
impl MeetingFormInput {
    fn into_record(self) -> web::Result<MeetingInput> {
        let mut meeting = MeetingInput {
            title: self.title,
            starts_at: self.starts_at,
            attendees: self.attendees,
            purpose: self.purpose,
            notes: self.notes,
            revision: self.revision,
        };
        if DateTime::parse_from_rfc3339(meeting.starts_at.trim()).is_ok() {
            return Ok(meeting);
        }
        let zone = self
            .timezone
            .as_deref()
            .unwrap_or("")
            .trim()
            .parse::<chrono_tz::Tz>()
            .map_err(|_| {
                Error::bad_request("Choose a valid time zone, for example America/New_York or UTC.")
            })?;
        let local =
            chrono::NaiveDateTime::parse_from_str(meeting.starts_at.trim(), "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| {
                    chrono::NaiveDateTime::parse_from_str(
                        meeting.starts_at.trim(),
                        "%Y-%m-%dT%H:%M",
                    )
                })
                .map_err(|_| Error::bad_request("Choose a valid start date and time."))?;
        use chrono::TimeZone;
        let instant = match zone.from_local_datetime(&local) {
            chrono::LocalResult::Single(instant) => Some(instant),
            // Preserve the fold when editing an imported repeated-hour instant.
            chrono::LocalResult::Ambiguous(first, second) => self
                .original_starts_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .and_then(|original| {
                    [first, second]
                        .into_iter()
                        .find(|candidate| *candidate == original)
                }),
            chrono::LocalResult::None => None,
        };
        meeting.starts_at = instant
            .ok_or_else(|| Error::bad_request("This time is skipped or occurs twice during a daylight-saving change. Choose another time, or enter the intended time in UTC with time zone UTC."))?
            .to_rfc3339();
        Ok(meeting)
    }
}
pub(super) async fn create(
    State(app): State<App>,
    Form(input): Form<MeetingFormInput>,
) -> web::Result<Response> {
    let result = match input.clone().into_record() {
        Ok(record) => create_record(app.db(), record).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(meeting) => Ok(axum::response::IntoResponse::into_response(Redirect::to(
            &format!("/meetings/{}", meeting.id),
        ))),
        Err(error) if error.status == axum::http::StatusCode::BAD_REQUEST => {
            let page = meetings_page(&app, Some(&input), Some(&error.message)).await?;
            Ok(axum::response::IntoResponse::into_response((
                error.status,
                page,
            )))
        }
        Err(error) => Err(error),
    }
}
pub(super) async fn index(State(app): State<App>) -> web::Result<Response> {
    meetings_page(&app, None, None).await
}
async fn meetings_page(
    app: &App,
    submitted: Option<&MeetingFormInput>,
    error: Option<&str>,
) -> web::Result<Response> {
    let now = Utc::now();
    let mut meetings = app
        .db()
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
        web::Body::new(format!(
            "{}{}<p>Prepare from the facts you have, keep transcripts as evidence, and review follow-through before it becomes a task.</p><h2>Upcoming meetings</h2>{}<details><summary>Import Google Calendar</summary><p>Imports the next 30 days and the past 30 days. Reimports update calendar facts without replacing your notes.</p><form method=\"post\" action=\"/meetings/calendar\">{}<button class=\"btn-primary\">Import calendar</button></form></details><details{}><summary>Create a meeting</summary>{}</details>",
            nav(),
            error.map(|message| format!("<p role=\"alert\">{} Your meeting details are kept below; correct them and try again.</p>", escape(message))).unwrap_or_default(),
            meeting_list(&meetings),
            web::field("Calendar ID", "calendar_id", "primary", "text", None, false),
            if submitted.is_some() { " open" } else { "" },
            meeting_form(None, &crate::settings::load(app.db()).await?.timezone, submitted)
        )),
    ))
}
pub(super) async fn history(State(app): State<App>) -> web::Result<Response> {
    let now = Utc::now();
    let mut meetings = app
        .db()
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
        web::Body::new(format!("{}{}", nav(), meeting_list(&meetings))),
    ))
}
pub(super) async fn detail(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
) -> web::Result<Response> {
    let m = require_meeting(app.db(), &meeting_id).await?;
    meeting_page(&app, m, None, None).await
}
async fn meeting_page(
    app: &App,
    m: Meeting,
    submitted: Option<&MeetingFormInput>,
    error: Option<&str>,
) -> web::Result<Response> {
    let transcripts = app
        .db()
        .list::<Transcript>(TRANSCRIPT)
        .await?
        .into_iter()
        .filter(|t| t.meeting_id.as_deref() == Some(&m.id))
        .collect::<Vec<_>>();
    let mut artifacts = app
        .db()
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
    let preferences = crate::settings::load(app.db()).await?;
    let state_options = web::options(
        ["scheduled", "completed", "cancelled"]
            .into_iter()
            .map(|state| (state, state.to_owned())),
        &m.state,
    );
    artifacts.sort_by_key(|a| (a.created_at, a.id.clone()));
    let artifact_links = if artifacts.is_empty() {
        "<p>No generated drafts yet.</p>".into()
    } else {
        let mut versions = std::collections::HashMap::new();
        let numbered = artifacts
            .iter()
            .map(|artifact| {
                let version = versions.entry(artifact.kind.as_str()).or_insert(0);
                *version += 1;
                (artifact, *version)
            })
            .collect::<Vec<_>>();
        numbered
            .into_iter()
            .rev()
            .map(|(a, version)| {
                format!(
                    "<li><a href=\"/meetings/{}/artifacts/{}\">{} v{version}</a> · {} {} {}</li>",
                    m.id,
                    a.id,
                    escape(&web::display_label(&a.kind)),
                    web::saved_time(a.created_at, &preferences.timezone),
                    web::badge(if a.reviewed { "reviewed" } else { "draft" }),
                    if a.meeting_revision != m.revision {
                        web::badge("Stale: meeting changed")
                    } else {
                        String::new()
                    }
                )
            })
            .collect::<String>()
    };
    Ok(web::page(
        &m.title,
        web::Body::new(format!(
            "{}{}<p>{} · {}</p><h2>Preparation</h2>{}<h2>Debrief</h2><p>Debriefs analyze spoken dialogue from confirmed transcripts: topics, decisions, new actions, reported completed work, open questions, risks and suggestions. Tone judgments use text only. Dialogue is sent to your selected generation and TypeSafe/Jev providers. Actions remain proposals until reviewed.</p>{}<h2>Draft history</h2><ul>{}</ul><h2>Associated transcripts</h2><ul>{}</ul><a href=\"/transcripts\">Add or review transcripts</a><details{}><summary>Edit meeting and state</summary>{}<h2>Meeting state</h2><form method=\"post\" action=\"/meetings/{}/state\">{}<label>State<select name=\"state\">{}</select></label><button class=\"btn-secondary\">Set state</button></form></details><details class=\"danger-zone\"><summary>Delete meeting</summary><p>This removes the meeting and its draft artifacts. Transcripts return to the unassigned catalog. Captured action items and tasks remain.</p>{}</details>",
            nav(),
            error.map(|message| format!("<p role=\"alert\">{} Your meeting details are kept below.</p><p><a href=\"/meetings/{}\">Reload saved meeting</a></p>", escape(message), m.id)).unwrap_or_default(),
            web::timestamp(&m.starts_at),
            web::badge(&m.state),
            web::button_form(
                &format!("/meetings/{}/brief", m.id),
                "Generate preparation brief",
                &web::revision_input(m.revision)
            ),
            match app.judge().reason() {
                None => web::button_form(
                    &format!("/meetings/{}/debrief", m.id),
                    "Generate evidence-based debrief",
                    &web::revision_input(m.revision),
                ),
                Some(reason) => format!("<p role=\"status\">{}</p>", escape(reason)),
            },
            artifact_links,
            transcript_links,
            if submitted.is_some() { " open" } else { "" },
            meeting_form(Some(&m), &crate::settings::load(app.db()).await?.timezone, submitted),
            m.id,
            web::revision_input(m.revision),
            state_options,
            web::button_form(
                &format!("/meetings/{}/delete", m.id),
                "Delete meeting",
                &web::revision_input(m.revision)
            )
        )),
    ))
}
pub(super) async fn edit(
    State(app): State<App>,
    Path(meeting_id): Path<String>,
    Form(input): Form<MeetingFormInput>,
) -> web::Result<Response> {
    let validation: web::Result<_> = (|| {
        let record = input.clone().into_record()?;
        let expected = record
            .revision
            .ok_or_else(|| Error::bad_request("Meeting revision is required."))?;
        Ok((expected, input_values(&record)?))
    })();
    let (expected, (title, starts_at, attendees, purpose, notes)) = match validation {
        Ok(values) => values,
        Err(error) => return rejected_meeting_edit(&app, &meeting_id, &input, error).await,
    };
    let target = meeting_id.clone();
    let changed = app
        .db()
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
        return rejected_meeting_edit(&app, &meeting_id, &input, Error::conflict("Meeting changed while this form was open. Copy your edits before reloading the saved meeting. Reload before saving.")).await;
    }
    Ok(axum::response::IntoResponse::into_response(Redirect::to(
        &format!("/meetings/{meeting_id}"),
    )))
}
async fn rejected_meeting_edit(
    app: &App,
    id: &str,
    input: &MeetingFormInput,
    error: Error,
) -> web::Result<Response> {
    let saved = require_meeting(app.db(), id).await?;
    let page = meeting_page(app, saved, Some(input), Some(&error.message)).await?;
    Ok(axum::response::IntoResponse::into_response((
        error.status,
        page,
    )))
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
        .db()
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
        .db()
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

#[derive(Default, Deserialize)]
pub(super) struct CatalogFilter {
    #[serde(default)]
    q: String,
    #[serde(default)]
    association: String,
    #[serde(default)]
    page: usize,
}
pub(super) async fn catalog(
    State(app): State<App>,
    axum::extract::Query(filter): axum::extract::Query<CatalogFilter>,
) -> web::Result<Response> {
    let mut transcripts = app.db().list::<Transcript>(TRANSCRIPT).await?;
    transcripts.retain(|t| {
        t.title.to_lowercase().contains(&filter.q.to_lowercase())
            && match filter.association.as_str() {
                "unassigned" => t.meeting_id.is_none(),
                "confirmed" => t.meeting_id.is_some(),
                _ => true,
            }
    });
    transcripts.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let total = transcripts.len();
    let pages = total.div_ceil(25).max(1);
    let page = filter.page.max(1).min(pages);
    let meetings = app.db().list::<Meeting>(MEETING).await?;
    let options = meeting_options(&meetings, "");
    let mut body = format!(
        "{}<p>Matching suggestions are evidence for review. A title match never silently places a transcript on a meeting.</p><details><summary>+ Add Transcript Text</summary><form method=\"post\" action=\"/transcripts\">{}{}<label>Confirm meeting<select name=\"meeting_id\">{options}</select></label><button class=\"btn-primary\">Save transcript</button></form></details><details><summary>Import from Google Drive</summary><p>New imports stay unassigned until you confirm a meeting. Choose a transcript folder and authorize it in <a href=\"/settings\">Settings</a> first.</p><form method=\"post\" action=\"/transcripts/drive\"><label><input type=\"checkbox\" name=\"consent\" value=\"yes\" required>I authorize importing transcripts from the selected folder for this run.</label><button class=\"btn-primary\">Import Drive transcripts</button></form>",
        nav(),
        web::field("Transcript title", "title", "", "text", None, false),
        web::textarea("Transcript text", "text", "")
    );
    let tombstones = app.db().list::<TranscriptTombstone>(TOMBSTONE).await?;
    if !tombstones.is_empty() {
        body.push_str("<h3>Excluded imported files</h3><ul>");
        for t in tombstones {
            body.push_str(&format!("<li>{}<form method=\"post\" action=\"/transcripts/allow-reimport\"><input type=\"hidden\" name=\"source_id\" value=\"{}\"><button class=\"btn-secondary\">Allow this file on the next import</button></form></li>",escape(&t.title),escape(&t.source_id)));
        }
        body.push_str("</ul>");
    }
    body.push_str(&format!("</details><form class=\"toolbar\" method=\"get\" action=\"/transcripts\"><label>Search title<input name=\"q\" value=\"{}\"></label><label>Association<select name=\"association\">",escape(&filter.q)));
    body.push_str(&web::options(
        [
            ("", "All"),
            ("unassigned", "Unassigned"),
            ("confirmed", "Confirmed"),
        ]
        .into_iter()
        .map(|(value, label)| (value, label.to_owned())),
        &filter.association,
    ));
    body.push_str("</select></label><button class=\"btn-secondary\">Filter</button></form><table><thead><tr><th>Transcript</th><th>Association</th><th>Size</th></tr></thead><tbody>");
    for t in transcripts.iter().skip((page - 1) * 25).take(25) {
        body.push_str(&format!(
            "<tr><td><a href=\"/transcripts/{}\">{}</a></td><td>{}</td><td>{:.1} KB {}</td></tr>",
            t.id,
            escape(&t.title),
            web::badge(&t.association),
            t.text.len() as f64 / 1024.0,
            if t.text.len() < 1024 {
                web::badge("Very short / <1 KB")
            } else {
                String::new()
            }
        ));
    }
    body.push_str(&format!(
        "</tbody></table><p>{} · Page {page} of {pages}</p><nav aria-label=\"Transcript pages\">",
        web::pluralize(total, "transcript", "transcripts")
    ));
    for (target, label) in [(page.saturating_sub(1), "Previous"), (page + 1, "Next")] {
        if target >= 1 && target <= pages {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("q", &filter.q)
                .append_pair("association", &filter.association)
                .append_pair("page", &target.to_string())
                .finish();
            body.push_str(&format!(
                "<a class=\"button btn-secondary\" href=\"/transcripts?{}\">{label}</a> ",
                escape(&query)
            ));
        }
    }
    body.push_str("</nav>");
    Ok(web::page("Transcript catalog", web::Body::new(body)))
}
/// The meeting chooser: unassigned first, then each meeting with its start.
pub(super) fn meeting_options(meetings: &[Meeting], selected: &str) -> String {
    web::options(
        std::iter::once(("", "Unassigned".to_owned())).chain(meetings.iter().map(|m| {
            (
                m.id.as_str(),
                format!("{} · {}", escape(&m.title), web::timestamp(&m.starts_at)),
            )
        })),
        selected,
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
    let t = upload_record(app.db(), &input.title, &input.text, meeting_id).await?;
    Ok(Redirect::to(&format!("/transcripts/{}", t.id)))
}
pub(super) async fn transcript_detail(
    State(app): State<App>,
    Path(transcript_id): Path<String>,
) -> web::Result<Response> {
    let t = require_transcript(app.db(), &transcript_id).await?;
    let meetings = app.db().list::<Meeting>(MEETING).await?;
    let suggestions = meetings
        .iter()
        .filter(|m| titles_overlap(&t.title, &m.title))
        .map(|m| {
            format!(
                "<li><a href=\"/meetings/{}\">{}</a> · {} · shared words in title</li>",
                m.id,
                escape(&m.title),
                web::timestamp(&m.starts_at)
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
        web::Body::new(format!(
            "{}<p>{} · {linked}</p><h2>Review association</h2><p>Suggested meetings (title overlap only; verify the date and speakers):</p><ul>{}</ul><form method=\"post\" action=\"/transcripts/{}/associate\">{}<label>Confirmed meeting<select name=\"meeting_id\">{}</select></label><button class=\"btn-primary\">Confirm association</button></form><h2>Source evidence</h2><pre>{}</pre><details><summary>Delete transcript</summary><p>Deleting this evidence makes related generated drafts stale. Captured action items and tasks remain.</p>{}</details>",
            nav(),
            escape(&t.association),
            if suggestions.is_empty() {
                "<li>No title matches. You may choose any meeting after checking the evidence.</li>"
                    .into()
            } else {
                suggestions
            },
            t.id,
            web::revision_input(t.revision),
            meeting_options(&meetings, t.meeting_id.as_deref().unwrap_or("")),
            t.text
                .lines()
                .enumerate()
                .map(|(i, line)| format!(
                    "<span id=\"line-{}\">{}: {}</span>\n",
                    i + 1,
                    i + 1,
                    escape(line)
                ))
                .collect::<String>(),
            web::button_form(
                &format!("/transcripts/{}/delete", t.id),
                "Delete transcript",
                &web::revision_input(t.revision)
            )
        )),
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
        .db()
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
        .db()
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
    app.db().delete(TOMBSTONE, &input.source_id).await?;
    Ok(Redirect::to("/transcripts"))
}
