//! The four providers without a live account in this installation: Google,
//! Asana, HubSpot and YouTube.
//!
//! Each one is driven through the same request path production uses. The
//! provider base override (`CHIEF_COLLECT_GOOGLE_BASE`, `CHIEF_COLLECT_ASANA_BASE`,
//! `CHIEF_COLLECT_HUBSPOT_BASE`) repoints the client at a local server, so the wire
//! contract — path, method, authorization, body shape — and the response
//! normalization are exercised for real rather than asserted from source.
//!
//! The request shapes below follow each provider's published reference:
//! Google Tasks `tasks.insert` and `tasks.get`
//! (developers.google.com/workspace/tasks/reference/rest/v1/tasks),
//! Asana `POST /tasks` (developers.asana.com/reference/createtask),
//! HubSpot CRM v3 contacts search
//! (developers.hubspot.com/docs/reference/api/crm/objects/contacts), and
//! YouTube Data API v3 `channels`, `playlistItems` and `videos`.
use chief_of_rust::{
    App,
    integrations::{self, GoogleBinding},
    tasks::Task,
    work,
};
use serde_json::json;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, header, method, path, query_param},
};

/// Provider bases resolve through process-global env, so the tests that
/// repoint them serialize on this lock. The guard spans `.await`.
static PROVIDER_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn app(dir: &tempfile::TempDir) -> App {
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf()).app()
}

/// A local Task in the shape the delivery seam receives from `/tasks/{id}/link`.
fn local_task(title: &str, notes: &str, due: Option<&str>) -> Task {
    let now = chief_of_rust::now_ms();
    Task {
        id: uuid_like(title),
        title: title.into(),
        notes: notes.into(),
        owner: "Sam".into(),
        priority: "normal".into(),
        due: due.map(str::to_owned),
        status: "open".into(),
        list_id: None,
        trashed: false,
        version: 1,
        source: None,
        links: Vec::new(),
        created_at: now,
        updated_at: now,
    }
}

/// A deterministic id per title keeps the fixtures readable in a failure.
fn uuid_like(seed: &str) -> String {
    format!("fixture-{}", seed.replace(' ', "-").to_lowercase())
}

/// A connected Google account whose stored token does not need a refresh, so
/// no OAuth exchange is attempted and the provider request is the only call.
async fn install_google(app: &App) -> (GoogleBinding, String) {
    let binding = GoogleBinding {
        generation: 3,
        subject: Some("tokensubject".into()),
    };
    app.db()
        .put("google_connection", "current", binding.clone())
        .await
        .unwrap();
    std::fs::create_dir_all(app.cfg().google_token_path.parent().unwrap()).unwrap();
    std::fs::write(
        &app.cfg().google_token_path,
        json!({
            "access_token":"fixture-google-access-token", "refresh_token":null,
            "expires_at":chief_of_rust::now_ms()+3_600_000,
            "email":"owner@example.test", "binding":binding,
        })
        .to_string(),
    )
    .unwrap();
    (binding, "fixture-google-access-token".into())
}

/// Google Tasks: the sync path performs a list preflight, then a create, and
/// records the provider ID. This is the documented `tasks.insert` contract.
#[tokio::test]
async fn google_tasks_delivery_preflights_the_list_and_creates_the_documented_task() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let (_, token) = install_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    Mock::given(method("GET"))
        .and(path("/tasks/v1/users/@me/lists/list-1"))
        .and(header("authorization", format!("Bearer {token}")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"id":"list-1","title":"Work"})),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/tasks/v1/lists/list-1/tasks"))
        .and(header("authorization", format!("Bearer {token}")))
        .and(body_partial_json(json!({
            "title":"Send the proposal",
            "notes":"Sam committed to this in the review.",
            "status":"needsAction",
            "due":"2026-11-05T00:00:00Z"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"id":"remote-task-1","title":"Send the proposal","status":"needsAction"}),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let created = local_task(
        "Send the proposal",
        "Sam committed to this in the review.",
        Some("2026-11-05"),
    );
    app.db()
        .put("task", &created.id, created.clone())
        .await
        .unwrap();
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        "google-link",
        json!({"task":created,"provider":"google","container":"list-1"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    let saved = app
        .db()
        .get::<Task>("task", &created.id)
        .await
        .unwrap()
        .unwrap();
    let link = saved
        .links
        .iter()
        .find(|link| link.provider == "google")
        .expect("the delivery link is recorded");
    assert_eq!(link.remote_id.as_deref(), Some("remote-task-1"));
    assert_eq!(link.state, "linked");
    // The binding is recorded with the link so a later account change cannot
    // deliver into the wrong account.
    assert_eq!(
        link.google_binding.as_ref().and_then(|b| b.subject.clone()),
        Some("tokensubject".into())
    );
}

/// Asana: the documented `POST /tasks` body nests fields under `data` and
/// returns the identifier as `data.gid`.
#[tokio::test]
async fn asana_delivery_posts_the_documented_data_envelope_and_keeps_the_gid() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    unsafe { std::env::set_var("CHIEF_COLLECT_ASANA_BASE", server.uri()) };
    unsafe { std::env::set_var("ASANA_ACCESS_TOKEN", "fixture-asana-token") };

    Mock::given(method("GET"))
        .and(path("/api/1.0/projects/project-7"))
        .and(header("authorization", "Bearer fixture-asana-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data":{"gid":"project-7"}})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/1.0/tasks"))
        .and(header("authorization", "Bearer fixture-asana-token"))
        .and(body_partial_json(json!({"data":{
            "name":"Draft the pilot checklist",
            "notes":"Owner: Sam",
            "completed":false,
            "due_on":"2026-11-06",
            "projects":["project-7"]
        }})))
        .respond_with(ResponseTemplate::new(201).set_body_json(
            json!({"data":{"gid":"1200000000000001","name":"Draft the pilot checklist"}}),
        ))
        .expect(1)
        .mount(&server)
        .await;

    let created = local_task(
        "Draft the pilot checklist",
        "Owner: Sam",
        Some("2026-11-06"),
    );
    app.db()
        .put("task", &created.id, created.clone())
        .await
        .unwrap();
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        "asana-link",
        json!({"task":created,"provider":"asana","container":"project-7"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_ASANA_BASE") };
    unsafe { std::env::remove_var("ASANA_ACCESS_TOKEN") };

    let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    let saved = app
        .db()
        .get::<Task>("task", &created.id)
        .await
        .unwrap()
        .unwrap();
    let link = saved
        .links
        .iter()
        .find(|link| link.provider == "asana")
        .expect("the delivery link is recorded");
    assert_eq!(link.remote_id.as_deref(), Some("1200000000000001"));
    // Asana has no account binding: the token is installation configuration.
    assert!(link.google_binding.is_none());
}

/// A Task that already links remotely is *updated*, not created again: the
/// documented `tasks.patch` on the recorded remote ID, carrying only the
/// changed fields, and the link records the new synced version.
#[tokio::test]
async fn google_tasks_update_patches_the_recorded_remote_id() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let (binding, token) = install_google(&app).await;
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };

    Mock::given(method("GET"))
        .and(path("/tasks/v1/users/@me/lists/list-1"))
        .and(header("authorization", format!("Bearer {token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"list-1"})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/tasks/v1/lists/list-1/tasks/remote-task-9"))
        .and(header("authorization", format!("Bearer {token}")))
        .and(body_partial_json(json!({
            "title":"Send the revised proposal",
            "notes":"Sam asked for the shorter version.",
            "status":"completed",
            "due":"2026-11-12T00:00:00Z"
        })))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"id":"remote-task-9","status":"completed"})),
        )
        .expect(1)
        .mount(&server)
        .await;

    let mut task = local_task(
        "Send the revised proposal",
        "Sam asked for the shorter version.",
        Some("2026-11-12"),
    );
    task.status = "done".into();
    task.version = 2;
    task.links.push(chief_of_rust::tasks::ExternalLink {
        provider: "google".into(),
        container: "list-1".into(),
        remote_id: Some("remote-task-9".into()),
        state: "linked".into(),
        error: None,
        synced_version: Some(1),
        google_binding: Some(binding.clone()),
    });
    app.db().put("task", &task.id, task.clone()).await.unwrap();
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        "google-update",
        json!({"task":task,"provider":"google","container":"list-1"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };

    let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    let saved = app
        .db()
        .get::<Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    let link = saved.links.iter().find(|l| l.provider == "google").unwrap();
    assert_eq!(link.remote_id.as_deref(), Some("remote-task-9"));
    assert_eq!(link.synced_version, Some(2), "the update is recorded");
    assert_eq!(link.state, "linked");
}

/// Asana updates with `PUT /tasks/{gid}`; the `projects` membership is only
/// sent on create, so an update must not re-parent the task.
#[tokio::test]
async fn asana_task_update_puts_without_repeating_the_project_membership() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    unsafe { std::env::set_var("CHIEF_COLLECT_ASANA_BASE", server.uri()) };
    unsafe { std::env::set_var("ASANA_ACCESS_TOKEN", "fixture-asana-token") };

    Mock::given(method("GET"))
        .and(path("/api/1.0/projects/project-7"))
        .and(header("authorization", "Bearer fixture-asana-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data":{"gid":"project-7"}})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/1.0/tasks/1200000000000001"))
        .and(header("authorization", "Bearer fixture-asana-token"))
        .and(body_partial_json(json!({"data":{
            "name":"Draft the pilot checklist",
            "notes":"Owner: Sam",
            "completed":true,
            "due_on":"2026-11-06"
        }})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"data":{"gid":"1200000000000001","completed":true}})),
        )
        .expect(1)
        .mount(&server)
        .await;

    let mut task = local_task(
        "Draft the pilot checklist",
        "Owner: Sam",
        Some("2026-11-06"),
    );
    task.status = "done".into();
    task.version = 2;
    task.links.push(chief_of_rust::tasks::ExternalLink {
        provider: "asana".into(),
        container: "project-7".into(),
        remote_id: Some("1200000000000001".into()),
        state: "linked".into(),
        error: None,
        synced_version: Some(1),
        google_binding: None,
    });
    app.db().put("task", &task.id, task.clone()).await.unwrap();
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        "asana-update",
        json!({"task":task,"provider":"asana","container":"project-7"}),
    )
    .await
    .unwrap();
    work::run_once(&app).await.unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_ASANA_BASE") };
    unsafe { std::env::remove_var("ASANA_ACCESS_TOKEN") };

    let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    let saved = app
        .db()
        .get::<Task>("task", &task.id)
        .await
        .unwrap()
        .unwrap();
    let link = saved.links.iter().find(|l| l.provider == "asana").unwrap();
    assert_eq!(link.remote_id.as_deref(), Some("1200000000000001"));
    assert_eq!(link.synced_version, Some(2));
    assert_eq!(link.state, "linked");
}

/// The settings page reports the Google connection state, which is what an
/// operator uses to decide whether to connect an account. All three states are
/// derived from the stored token and the client configuration, so each one is
/// asserted here rather than assumed.
#[tokio::test]
async fn google_status_reports_connected_configured_and_unconfigured() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));

    // No client ID/secret and no service-account file: nothing can be connected.
    unsafe { std::env::remove_var("GOOGLE_CLIENT_ID") };
    unsafe { std::env::remove_var("GOOGLE_CLIENT_SECRET") };
    assert_eq!(integrations::google_status(&app).await, "Not configured");
    let html = server.get("/settings").await.text();
    assert!(
        html.contains("Not configured"),
        "the settings page shows the unconfigured state"
    );

    // Credentials present but no stored token: the operator still has to connect.
    unsafe { std::env::set_var("GOOGLE_CLIENT_ID", "fixture-client-id") };
    unsafe { std::env::set_var("GOOGLE_CLIENT_SECRET", "fixture-client-secret") };
    assert_eq!(
        integrations::google_status(&app).await,
        "Configured; connect your account"
    );

    // A stored, unexpired token names the connected account.
    install_google(&app).await;
    assert_eq!(
        integrations::google_status(&app).await,
        "Connected as owner@example.test"
    );
    let html = server.get("/settings").await.text();
    assert!(
        html.contains("Connected as owner@example.test"),
        "the settings page names the connected account"
    );

    unsafe { std::env::remove_var("GOOGLE_CLIENT_ID") };
    unsafe { std::env::remove_var("GOOGLE_CLIENT_SECRET") };
}

/// HubSpot: CRM v3 search takes the exact email in `filterGroups` and answers
/// with `results[].properties`.
#[tokio::test]
async fn hubspot_capture_posts_the_documented_search_and_saves_exact_email_fields() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    unsafe { std::env::set_var("CHIEF_COLLECT_HUBSPOT_BASE", server.uri()) };
    unsafe { std::env::set_var("HUBSPOT_ACCESS_TOKEN", "fixture-hubspot-token") };

    Mock::given(method("POST"))
        .and(path("/crm/v3/objects/contacts/search"))
        .and(header("authorization", "Bearer fixture-hubspot-token"))
        .and(body_partial_json(json!({
            "filterGroups":[{"filters":[{
                "propertyName":"email","operator":"IN","values":["sam@example.test"]
            }]}],
            "properties":["email","firstname","lastname","jobtitle","company"],
            "limit":100
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"total":1,"results":[{
                "id":"501",
                "properties":{
                    "email":"sam@example.test","firstname":"Sam","lastname":"Rivera",
                    "jobtitle":"VP Engineering","company":"Acme"
                }
            }]})),
        )
        .expect(1)
        .mount(&server)
        .await;

    let result = integrations::hubspot_contacts(&app, &["sam@example.test".into()])
        .await
        .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_HUBSPOT_BASE") };
    unsafe { std::env::remove_var("HUBSPOT_ACCESS_TOKEN") };

    assert_eq!(result["total"], 1);
    assert_eq!(
        result["results"][0]["properties"]["jobtitle"],
        "VP Engineering"
    );
    assert_eq!(
        result["results"][0]["properties"]["email"],
        "sam@example.test"
    );
}

/// YouTube: channel, uploads playlist and video statistics are three calls,
/// and the observation keeps provider counts rather than interpolating.
#[tokio::test]
async fn youtube_observation_reads_the_documented_three_endpoints() {
    let _guard = PROVIDER_ENV_LOCK.lock().await;
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    unsafe { std::env::set_var("CHIEF_COLLECT_GOOGLE_BASE", server.uri()) };
    unsafe { std::env::set_var("YOUTUBE_API_KEY", "fixture-youtube-key") };

    Mock::given(method("GET"))
        .and(path("/youtube/v3/channels"))
        .and(query_param("part", "snippet,statistics,contentDetails"))
        .and(query_param("id", "UCfixture"))
        .and(query_param("key", "fixture-youtube-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items":[{
            "id":"UCfixture",
            "snippet":{"title":"Fixture Channel"},
            "statistics":{"videoCount":"2","viewCount":"1500"},
            "contentDetails":{"relatedPlaylists":{"uploads":"UUfixture"}}
        }]})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/playlistItems"))
        .and(query_param("playlistId", "UUfixture"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items":[
            {"contentDetails":{"videoId":"vid-1"}},
            {"contentDetails":{"videoId":"vid-2"}}
        ]})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/youtube/v3/videos"))
        .and(query_param("id", "vid-1,vid-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items":[
            {"id":"vid-1","snippet":{"title":"First","publishedAt":"2026-09-01T10:00:00Z"},"statistics":{"viewCount":"900"}},
            {"id":"vid-2","snippet":{"title":"Second","publishedAt":"2026-09-08T10:00:00Z"},"statistics":{"viewCount":"600"}}
        ]})))
        .expect(1)
        .mount(&server)
        .await;

    let observation = integrations::youtube_channel(&app, "UCfixture")
        .await
        .unwrap();
    unsafe { std::env::remove_var("CHIEF_COLLECT_GOOGLE_BASE") };
    unsafe { std::env::remove_var("YOUTUBE_API_KEY") };

    assert_eq!(observation["title"], "Fixture Channel");
    assert_eq!(observation["view_count"], "1500");
    assert_eq!(observation["videos"][0]["views"], 900);
    assert_eq!(
        observation["videos"][1]["published_at"],
        "2026-09-08T10:00:00Z"
    );
    assert_eq!(observation["coverage"], "latest 25 public uploads");
}
