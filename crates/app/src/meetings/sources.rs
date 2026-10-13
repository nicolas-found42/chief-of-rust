use super::*;
use chrono::TimeZone;

pub(super) async fn execute_calendar(app: &App, job: &work::Job) -> anyhow::Result<Value> {
    let calendar = job.input["calendar_id"].as_str().unwrap_or("primary");
    let now = Utc::now();
    let from = (now - Duration::days(30)).to_rfc3339();
    let through = (now + Duration::days(30)).to_rfc3339();
    let mut url = url::Url::parse("https://www.googleapis.com/calendar/v3/calendars/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Calendar URL cannot accept path"))?
        .push(calendar)
        .push("events");
    let mut events = Vec::new();
    let mut token = String::new();
    for page in 0..20 {
        let mut query = vec![
            ("timeMin", from.as_str()),
            ("timeMax", through.as_str()),
            ("singleEvents", "true"),
            ("maxResults", "250"),
            ("showDeleted", "true"),
        ];
        if !token.is_empty() {
            query.push(("pageToken", &token));
        }
        let response = crate::integrations::google_get(app, url.as_str(), &query).await?;
        events.extend(response["items"].as_array().cloned().unwrap_or_default());
        token = response["nextPageToken"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if token.is_empty() {
            break;
        }
        anyhow::ensure!(
            page < 19,
            "Calendar has too many pages for one import; no partial data saved"
        );
    }
    let settings = crate::settings::load(&app.db).await?;
    let timezone = job.input["timezone"].as_str().unwrap_or(&settings.timezone);
    let count = import_calendar_records_in_zone(&app.db, calendar, events, timezone).await?;
    Ok(json!({"events_seen":count,"url":"/meetings"}))
}

/// Calendar intake commits the complete fetched batch, preserving private preparation notes.
pub async fn import_calendar_records(
    db: &Db,
    calendar: &str,
    events: Vec<Value>,
) -> anyhow::Result<usize> {
    import_calendar_records_in_zone(db, calendar, events, "UTC").await
}
async fn import_calendar_records_in_zone(
    db: &Db,
    calendar: &str,
    events: Vec<Value>,
    timezone: &str,
) -> anyhow::Result<usize> {
    let zone: chrono_tz::Tz = timezone.parse()?;
    let calendar = calendar.to_owned();
    let count = events.len();
    let binding = crate::integrations::expected_google_binding();
    db.transaction(move |tx| {
        if let Some(binding) = &binding {
            binding.assert_current(tx)?;
        }
        for event in events {
            let Some(event_id) = event["id"].as_str() else {
                continue;
            };
            // "primary" is relative to an account; shared events can have the
            // same ID in two accounts and must not overwrite each other's notes.
            let source = match binding.as_ref().and_then(|b| b.subject.as_ref()) {
                Some(subject) => format!("{subject}:{calendar}:{event_id}"),
                None => format!("{calendar}:{event_id}"),
            };
            let existing = store::list::<Meeting>(tx, MEETING)?;
            let found = existing
                .iter()
                .find(|m| m.calendar_event_id.as_deref() == Some(&source));
            if event["status"] == "cancelled" {
                if let Some(mut m) = found.cloned()
                    && m.state != "cancelled"
                {
                    m.state = "cancelled".into();
                    m.revision += 1;
                    store::put(tx, MEETING, &m.id, &m)?;
                }
                continue;
            }
            let starts_at = if let Some(dt) = event["start"]["dateTime"].as_str() {
                DateTime::parse_from_rfc3339(dt)?.to_rfc3339()
            } else if let Some(date) = event["start"]["date"].as_str() {
                let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?;
                zone.from_local_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight is valid"))
                    .earliest()
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "All-day calendar date has no midnight in the workspace timezone"
                        )
                    })?
                    .to_rfc3339()
            } else {
                continue;
            };
            let title = event["summary"]
                .as_str()
                .unwrap_or("Untitled calendar meeting")
                .to_owned();
            let purpose = event["description"].as_str().unwrap_or_default().to_owned();
            let attendees = event["attendees"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|p| {
                            let email = p["email"].as_str().unwrap_or_default();
                            let name = p["displayName"].as_str().unwrap_or(email);
                            format!("{name} <{email}>")
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            if let Some(mut m) = found.cloned() {
                if m.title != title
                    || m.starts_at != starts_at
                    || m.attendees != attendees
                    || m.purpose != purpose
                {
                    m.title = title;
                    m.starts_at = starts_at;
                    m.attendees = attendees;
                    m.purpose = purpose;
                    m.revision += 1;
                    store::put(tx, MEETING, &m.id, &m)?;
                }
            } else {
                let m = Meeting {
                    id: id(),
                    title,
                    starts_at,
                    attendees,
                    purpose,
                    notes: String::new(),
                    state: "scheduled".into(),
                    calendar_event_id: Some(source),
                    revision: 1,
                    created_at: crate::now_ms(),
                };
                store::put(tx, MEETING, &m.id, &m)?;
            }
        }
        Ok(())
    })
    .await?;
    Ok(count)
}
pub(super) fn extract_doc_text(value: &Value, output: &mut String) {
    if let Some(text) = value
        .get("textRun")
        .and_then(|v| v.get("content"))
        .and_then(Value::as_str)
    {
        output.push_str(text);
        return;
    }
    match value {
        Value::Object(object) => {
            for child in object.values() {
                extract_doc_text(child, output)
            }
        }
        Value::Array(array) => {
            for child in array {
                extract_doc_text(child, output)
            }
        }
        _ => (),
    }
}
pub(super) async fn execute_drive(app: &App, job: &work::Job) -> anyhow::Result<Value> {
    let folder = job.input["folder_id"].as_str().unwrap_or_default();
    let settings = crate::settings::load(&app.db).await?;
    anyhow::ensure!(
        !folder.is_empty() && settings.drive_consent && settings.drive_folder_id == folder,
        "Drive consent was revoked or the selected folder changed; authorize the current folder before importing"
    );
    anyhow::ensure!(
        !folder.contains('\'') && !folder.contains('\\'),
        "Invalid Drive folder ID"
    );
    let mut q="trashed = false and (mimeType = 'text/plain' or mimeType = 'application/vnd.google-apps.document') and (name contains 'transcript' or name contains 'Transcript')".to_owned();
    if !folder.is_empty() {
        q.push_str(&format!(" and '{folder}' in parents"));
    }
    let mut files = Vec::new();
    let mut token = String::new();
    for page in 0..10 {
        let mut query = vec![
            ("q", q.as_str()),
            ("pageSize", "100"),
            (
                "fields",
                "nextPageToken,files(id,name,mimeType,webViewLink)",
            ),
        ];
        if !token.is_empty() {
            query.push(("pageToken", &token));
        }
        let response = crate::integrations::google_get(
            app,
            "https://www.googleapis.com/drive/v3/files",
            &query,
        )
        .await?;
        files.extend(response["files"].as_array().cloned().unwrap_or_default());
        token = response["nextPageToken"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if token.is_empty() {
            break;
        }
        anyhow::ensure!(
            page < 9,
            "Drive has too many transcript pages; no partial import saved"
        );
    }
    let existing = app.db.list::<Transcript>(TRANSCRIPT).await?;
    let excluded = app.db.list::<TranscriptTombstone>(TOMBSTONE).await?;
    let mut records = Vec::new();
    for file in files {
        let Some(source_id) = file["id"].as_str() else {
            continue;
        };
        if existing
            .iter()
            .any(|t| t.source_id.as_deref() == Some(source_id))
            || excluded.iter().any(|t| t.source_id == source_id)
        {
            continue;
        }
        let mut url = url::Url::parse(
            if file["mimeType"] == "application/vnd.google-apps.document" {
                "https://docs.googleapis.com/v1/documents/"
            } else {
                "https://www.googleapis.com/drive/v3/files/"
            },
        )?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid Google URL"))?
            .push(source_id);
        let native = file["mimeType"] == "application/vnd.google-apps.document";
        let response = crate::integrations::google_get(
            app,
            url.as_str(),
            if native { &[] } else { &[("alt", "media")] },
        )
        .await?;
        let text = if native {
            let mut text = String::new();
            extract_doc_text(&response["body"], &mut text);
            text
        } else {
            response
                .as_str()
                .or_else(|| response["text"].as_str())
                .ok_or_else(|| anyhow::anyhow!("Drive text response was not text"))?
                .to_owned()
        };
        anyhow::ensure!(
            !text.trim().is_empty() && text.len() <= 500_000,
            "Transcript {} must contain 1–500000 bytes",
            file["name"]
        );
        let transcript = Transcript {
            id: id(),
            title: file["name"].as_str().unwrap_or("Drive transcript").into(),
            text,
            meeting_id: None,
            association: "unassigned Drive import".into(),
            source_id: Some(source_id.into()),
            source_url: file["webViewLink"].as_str().map(str::to_owned),
            revision: 1,
            created_at: crate::now_ms(),
        };
        records.push(transcript);
    }
    let authorized_folder = folder.to_owned();
    let binding = crate::integrations::expected_google_binding();
    let count=app.db
        .transaction(move |tx| {
            if let Some(binding) = binding { binding.assert_current(tx)?; }
            let settings:crate::settings::WorkspaceSettings=store::get(tx,"settings","workspace")?.unwrap_or_default();
            anyhow::ensure!(settings.drive_consent && settings.drive_folder_id == authorized_folder,
                "Drive consent was revoked or the selected folder changed during import; no transcripts were saved");
            let mut existing = store::list::<Transcript>(tx, TRANSCRIPT)?;
            let mut inserted=0;
            for t in records {
                let excluded = if let Some(source) = &t.source_id {
                    store::get::<TranscriptTombstone>(tx, TOMBSTONE, source)?.is_some()
                } else {
                    false
                };
                if !existing.iter().any(|old| old.source_id == t.source_id) && !excluded {
                    store::put(tx, TRANSCRIPT, &t.id, &t)?;
                    existing.push(t);
                    inserted+=1;
                }
            }
            Ok(inserted)
        })
        .await?;
    Ok(json!({"imported":count,"url":"/transcripts"}))
}

/// Scheduled imports snapshot connection settings rather than silently using future changes.
pub async fn enqueue_scheduled(app: &App, kind: &str) -> anyhow::Result<()> {
    let settings = crate::settings::load(&app.db).await?;
    let input = match kind {
        "meetings.calendar" => {
            json!({"calendar_id":settings.calendar_id,"timezone":settings.timezone})
        }
        "meetings.drive" => {
            anyhow::ensure!(
                settings.drive_consent && !settings.drive_folder_id.is_empty(),
                "Drive scheduling needs a selected folder and consent"
            );
            json!({"folder_id":settings.drive_folder_id})
        }
        _ => anyhow::bail!("Unknown scheduled meeting job"),
    };
    work::enqueue(
        &app.db,
        kind,
        &format!("scheduled:{}", crate::now_ms()),
        input,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn calendar_commit_fences_disconnected_import_and_separates_account_sources() {
        use crate::integrations::{GOOGLE_RUN_BINDING, GoogleBinding};
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::open(&dir.path().join("chief.db")).unwrap();
        let first = GoogleBinding {
            generation: 1,
            subject: Some("owner-A".into()),
        };
        let second = GoogleBinding {
            generation: 2,
            subject: Some("owner-B".into()),
        };
        let events = vec![
            json!({"id":"shared-event","summary":"Shared event","start":{"dateTime":"2026-10-13T12:00:00Z"}}),
        ];
        db.put("google_connection", "current", first.clone())
            .await
            .unwrap();
        GOOGLE_RUN_BINDING
            .scope(
                Some(first.clone()),
                import_calendar_records(&db, "primary", events.clone()),
            )
            .await
            .unwrap();
        db.put("google_connection", "current", second.clone())
            .await
            .unwrap();
        assert!(
            GOOGLE_RUN_BINDING
                .scope(
                    Some(first),
                    import_calendar_records(&db, "primary", events.clone())
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("connection changed")
        );
        GOOGLE_RUN_BINDING
            .scope(
                Some(second),
                import_calendar_records(&db, "primary", events),
            )
            .await
            .unwrap();
        let rows = db.list::<Meeting>(MEETING).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|m| m.calendar_event_id.as_deref() == Some("owner-A:primary:shared-event"))
        );
        assert!(
            rows.iter()
                .any(|m| m.calendar_event_id.as_deref() == Some("owner-B:primary:shared-event"))
        );
    }

    #[tokio::test]
    async fn all_day_calendar_intake_uses_selected_timezone() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::open(&dir.path().join("chief.db")).unwrap();
        import_calendar_records_in_zone(
            &db,
            "primary",
            vec![json!({"id":"all-day","summary":"Offsite","start":{"date":"2026-10-13"}})],
            "America/New_York",
        )
        .await
        .unwrap();
        let record = db.list::<Meeting>(MEETING).await.unwrap().pop().unwrap();
        assert_eq!(record.starts_at, "2026-10-13T00:00:00-04:00");
        assert_eq!(record.calendar_event_id.as_deref(), Some("primary:all-day"));
    }
}
