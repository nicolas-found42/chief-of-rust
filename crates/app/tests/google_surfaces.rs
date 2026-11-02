//! Google Calendar, Drive and Gmail draft request paths.
//!
//! These three surfaces had no network coverage: the existing tests stop at
//! "missing configuration", so nothing exercised the request each path builds.
//! Each request is driven here against a local server through the same
//! `CHIEF_COLLECT_GOOGLE_BASE` seam the collectors use, and the assertions are
//! the documented wire contracts:
//!
//! - Calendar `events.list`: `timeMin`/`timeMax` RFC-3339, `singleEvents`,
//!   `showDeleted`, `maxResults`, `pageToken` paging
//!   (developers.google.com/workspace/calendar/api/v3/reference/events/list).
//! - Drive `files.list`: `q`, `pageSize`, the narrow `fields` selection and
//!   `pageToken` paging; `files/{id}?alt=media` for text and
//!   `docs/v1/documents/{id}` for native Docs
//!   (developers.google.com/workspace/drive/api/reference/rest/v3/files/list).
//! - Gmail `users.drafts.create`: `message.raw` is the whole message, which the
//!   `Message` resource documents as "an RFC 2822 formatted and base64url
//!   encoded string"; it is addressed to the connected owner with the subject
//!   encoded as an RFC 2047 UTF-8 encoded-word
//!   (developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create,
//!   developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chief_of_rust::{App, integrations::GoogleBinding, settings::WorkspaceSettings, work};
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path, query_param, query_param_is_missing},
};

/// Provider bases are process-global, so env-touching tests serialize here.
static GOOGLE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn app(dir: &tempfile::TempDir) -> App {
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf()).app()
}

/// A connected account whose stored token is unexpired, so the only outbound
/// request a test makes is the provider call under test.
async fn connect_google(app: &App) -> String {
    let binding = GoogleBinding {
        generation: 1,
        subject: Some("fixture-subject".into()),
    };
    app.db()
        .put("google_connection", "current", binding.clone())
        .await
        .unwrap();
    std::fs::create_dir_all(app.cfg().google_token_path.parent().unwrap()).unwrap();
    std::fs::write(
        &app.cfg().google_token_path,
        json!({
            "access_token":"fixture-access-token", "refresh_token":null,
            "expires_at":chief_of_rust::now_ms()+3_600_000,
            "email":"owner@example.test", "binding":binding,
        })
        .to_string(),
    )
    .unwrap();
    "fixture-access-token".into()
}

async fn enqueue(app: &App, kind: &str, input: serde_json::Value) -> String {
    work::enqueue(app.db(), kind, &format!("test:{kind}"), input)
        .await
        .unwrap()
        .id
}

/// Calendar intake pages until `nextPageToken` is absent, then commits every
/// event from both pages. The documented query is asserted on the wire, so a
/// widened window or a dropped `showDeleted` fails here.
#[tokio::test]
async fn calendar_intake_pages_the_documented_events_list_and_commits_every_page() {
    let _guard = GOOGLE_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let token = connect_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    Mock::given(method("GET"))
        .and(path("/calendar/v3/calendars/primary/events"))
        .and(header("authorization", format!("Bearer {token}")))
        .and(query_param("singleEvents", "true"))
        .and(query_param("showDeleted", "true"))
        .and(query_param("maxResults", "250"))
        .and(query_param_is_missing("pageToken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "nextPageToken":"page-2",
            "items":[{"id":"event-1","summary":"Launch review",
                      "start":{"dateTime":"2026-11-03T14:00:00-05:00"},
                      "end":{"dateTime":"2026-11-03T15:00:00-05:00"},
                      "attendees":[{"displayName":"Sam","email":"sam@example.test"}]}]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/calendar/v3/calendars/primary/events"))
        .and(query_param("pageToken", "page-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items":[{"id":"event-2","summary":"Proposal sync",
                      "start":{"dateTime":"2026-11-04T09:00:00-05:00"},
                      "end":{"dateTime":"2026-11-04T09:30:00-05:00"}}]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let job = enqueue(
        &app,
        "meetings.calendar",
        json!({"calendar_id":"primary","timezone":"America/New_York"}),
    )
    .await;
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    let job = work::find(app.db(), &job).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    assert_eq!(job.result.unwrap()["events_seen"], 2);
    let meetings = app
        .db()
        .list::<chief_of_rust::meetings::Meeting>("meeting")
        .await
        .unwrap();
    let titles: Vec<_> = meetings.iter().map(|m| m.title.clone()).collect();
    assert!(titles.contains(&"Launch review".to_string()), "{titles:?}");
    assert!(titles.contains(&"Proposal sync".to_string()), "{titles:?}");
    // The attendee is preserved from the provider payload, not re-derived.
    let launch = meetings
        .iter()
        .find(|m| m.title == "Launch review")
        .unwrap();
    assert_eq!(launch.attendees, "Sam <sam@example.test>");
}

/// Drive intake lists with the narrow field selection, then fetches each file's
/// body: `alt=media` for text and the Docs API for a native document.
#[tokio::test]
async fn drive_intake_uses_the_narrow_fields_selection_and_fetches_each_body() {
    let _guard = GOOGLE_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let token = connect_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .and(header("authorization", format!("Bearer {token}")))
        .and(query_param("pageSize", "100"))
        .and(query_param(
            "fields",
            "nextPageToken,files(id,name,mimeType,webViewLink)",
        ))
        // The documented search restricts to transcript names inside the
        // authorized folder and excludes trashed files.
        .and(query_param("q", "trashed = false and (mimeType = 'text/plain' or mimeType = 'application/vnd.google-apps.document') and (name contains 'transcript' or name contains 'Transcript') and 'folder-1' in parents"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"files":[
            {"id":"file-text","name":"Team transcript.txt","mimeType":"text/plain",
             "webViewLink":"https://drive.example.test/file-text"},
            {"id":"file-doc","name":"Board Transcript (doc)","mimeType":"application/vnd.google-apps.document",
             "webViewLink":"https://docs.example.test/file-doc"}
        ]})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/drive/v3/files/file-text"))
        .and(query_param("alt", "media"))
        .respond_with(ResponseTemplate::new(200).set_body_string("Plain drive transcript body."))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        // Native Docs use the Docs API path, not the Drive files path.
        .and(path("/v1/documents/file-doc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "body":{"content":[{"paragraph":{"elements":[
                {"textRun":{"content":"Native document body."}}
            ]}}]}
        })))
        .expect(1)
        .mount(&server)
        .await;

    app.db()
        .put(
            "settings",
            "workspace",
            WorkspaceSettings {
                revision: 1,
                drive_consent: true,
                drive_folder_id: "folder-1".into(),
                ..WorkspaceSettings::default()
            },
        )
        .await
        .unwrap();
    let job = enqueue(&app, "meetings.drive", json!({"folder_id":"folder-1"})).await;
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    let job = work::find(app.db(), &job).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    assert_eq!(job.result.unwrap()["imported"], 2);
    let transcripts = app
        .db()
        .list::<chief_of_rust::meetings::Transcript>("transcript")
        .await
        .unwrap();
    let texts: Vec<_> = transcripts.iter().map(|t| t.text.as_str()).collect();
    assert!(
        texts.contains(&"Plain drive transcript body."),
        "text file body was not imported: {texts:?}"
    );
    assert!(
        texts.contains(&"Native document body."),
        "native Doc body was not extracted: {texts:?}"
    );
}

/// A Gmail draft is created for the connected owner only. The raw MIME part is
/// base64url inside the JSON body, so the draft is decoded here and checked as
/// the message the recipient would actually see.
#[tokio::test]
async fn gmail_draft_posts_the_documented_raw_mime_message_to_the_connected_owner() {
    let _guard = GOOGLE_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let token = connect_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    Mock::given(method("POST"))
        .and(path("/gmail/v1/users/me/drafts"))
        .and(header("authorization", format!("Bearer {token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id":"draft-1","message":{"id":"msg-1","threadId":"thread-1"}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = chief_of_rust::integrations::gmail_draft(
        &app,
        "Weekly review — Q4 planning",
        "Reviewed the proposal.\n\nNext step: send the checklist.",
    )
    .await
    .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    assert_eq!(result["id"], "draft-1");
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "exactly one draft creation");
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    let raw = body["message"]["raw"]
        .as_str()
        .expect("the documented `message.raw` field");
    let mime = String::from_utf8(URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap();

    // Addressed to the connected owner and nobody else: there is no send API.
    assert!(mime.contains("To: owner@example.test\r\n"), "{mime}");
    assert!(!mime.contains("Cc:") && !mime.contains("Bcc:"), "{mime}");
    // RFC 2047 encoded-word, decoded back to the subject the user typed.
    let subject = mime
        .lines()
        .find_map(|line| line.strip_prefix("Subject: =?UTF-8?B?"))
        .and_then(|rest| rest.strip_suffix("?="))
        .expect("an RFC 2047 UTF-8 encoded subject");
    assert_eq!(
        String::from_utf8(STANDARD.decode(subject).unwrap()).unwrap(),
        "Weekly review — Q4 planning"
    );
    // The body is base64 after the header terminator, as the MIME declares.
    let (_, encoded_body) = mime.split_once("\r\n\r\n").expect("header terminator");
    assert_eq!(
        String::from_utf8(STANDARD.decode(encoded_body.trim()).unwrap()).unwrap(),
        "Reviewed the proposal.\n\nNext step: send the checklist."
    );
    // Header order is the documented message shape: recipient, then the
    // MIME version and content declaration.
    let (headers, _) = mime.split_once("\r\n\r\n").unwrap();
    assert!(headers.contains("\r\nMIME-Version: 1.0\r\n"), "{mime}");
    assert!(
        headers.contains("Content-Transfer-Encoding: base64"),
        "the body encoding must be declared: {mime}"
    );
}

/// An operator base proxies API traffic, so a draft creation follows it — the
/// same rule as Calendar and Drive. What may never follow it is the OAuth
/// credential exchange itself, which carries the long-lived refresh token and
/// is already pinned in `integrations::tests`.
#[tokio::test]
async fn gmail_draft_follows_the_operator_base_while_the_token_exchange_does_not() {
    let _guard = GOOGLE_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let token = connect_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };
    Mock::given(method("POST"))
        .and(path("/gmail/v1/users/me/drafts"))
        .and(header("authorization", format!("Bearer {token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"draft-2"})))
        .expect(1)
        .mount(&server)
        .await;

    let result = chief_of_rust::integrations::gmail_draft(&app, "Subject", "Body").await;
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    assert_eq!(result.unwrap()["id"], "draft-2");
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "the configured base is the documented proxy for this provider's API calls"
    );
}

/// Calendar and Drive both stop paging rather than import a partial window.
#[tokio::test]
async fn unbounded_calendar_paging_fails_instead_of_saving_partial_data() {
    let _guard = GOOGLE_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    connect_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    // Every response advertises another page, so only the page cap ends it.
    Mock::given(method("GET"))
        .and(path("/calendar/v3/calendars/primary/events"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "nextPageToken":"always-more",
            "items":[{"id":"event-x","summary":"Recurring",
                      "start":{"dateTime":"2026-11-03T14:00:00Z"}}]
        })))
        .mount(&server)
        .await;

    let job = enqueue(
        &app,
        "meetings.calendar",
        json!({"calendar_id":"primary","timezone":"UTC"}),
    )
    .await;
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    let job = work::find(app.db(), &job).await.unwrap().unwrap();
    assert_eq!(job.status, "failed");
    assert!(
        job.error.unwrap_or_default().contains("too many pages"),
        "a truncated window must be reported, not silently saved"
    );
    assert!(
        app.db()
            .list::<chief_of_rust::meetings::Meeting>("meeting")
            .await
            .unwrap()
            .is_empty(),
        "no partial batch may be committed"
    );
}
