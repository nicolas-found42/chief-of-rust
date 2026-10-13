//! Account transitions must fence queued work before any remote request.
use chief_of_rust::{App, Config, db::Db, integrations::GoogleBinding, llm, routes, work};
use serde_json::json;

fn app(dir: &tempfile::TempDir) -> App {
    let cfg = Config::for_workspace(dir.path().to_path_buf());
    App {
        db: Db::open(&cfg.db_path()).unwrap(),
        llm: llm::from_config(&cfg),
        cfg,
    }
}

async fn install_fixture(app: &App, generation: u64, subject: &str) -> GoogleBinding {
    let binding = GoogleBinding {
        generation,
        subject: Some(subject.into()),
    };
    app.db
        .put("google_connection", "current", binding.clone())
        .await
        .unwrap();
    std::fs::create_dir_all(app.cfg.google_token_path.parent().unwrap()).unwrap();
    std::fs::write(
        &app.cfg.google_token_path,
        json!({
            "access_token":"offline-fixture-token", "refresh_token":null,
            "expires_at":chief_of_rust::now_ms()+3_600_000,
            "email":"owner@example.test", "binding":binding,
        })
        .to_string(),
    )
    .unwrap();
    binding
}

#[tokio::test]
async fn disconnected_oauth_states_cannot_complete_or_restore_a_connection() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let secret = dir.path().join("test-client.json");
    std::fs::write(
        &secret,
        json!({"web":{"client_id":"fixture","client_secret":"fixture"}}).to_string(),
    )
    .unwrap();
    app.cfg.google_secret_path = Some(secret);
    let before = install_fixture(&app, 7, "owner-A").await;
    let server = axum_test::TestServer::new(routes::router(app.clone()));
    let response = server.get("/google/connect").await;
    response.assert_status_see_other();
    let url = url::Url::parse(response.header("location").to_str().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    server
        .post("/google/disconnect")
        .await
        .assert_status_see_other();
    assert!(!app.cfg.google_token_path.exists());
    let binding: GoogleBinding = app
        .db
        .get("google_connection", "current")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        binding,
        GoogleBinding {
            generation: 8,
            subject: None
        }
    );
    assert!(
        app.db
            .list::<serde_json::Value>("oauth_state")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        app.db
            .transaction(move |tx| before.assert_current(tx))
            .await
            .is_err()
    );
    let response = server
        .get(&format!(
            "/google/callback?state={state}&error=access_denied"
        ))
        .await;
    response.assert_status_bad_request();
    assert!(response.text().contains("expired or already used"));
    assert!(!app.cfg.google_token_path.exists());
}

#[tokio::test]
async fn account_switch_and_new_grant_reject_old_queued_work_before_network() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    for (initial, replacement, offset) in [("owner-A", "owner-B", 0), ("owner-A", "owner-A", 10)] {
        let binding = install_fixture(&app, 1 + offset, initial).await;
        let job = work::enqueue(
            &app.db,
            "meetings.calendar",
            &format!("calendar-{offset}"),
            json!({"calendar_id":"primary"}),
        )
        .await
        .unwrap();
        assert_eq!(
            job.input["_google_binding"],
            serde_json::to_value(binding).unwrap()
        );
        install_fixture(&app, 2 + offset, replacement).await;
        work::run_once(&app).await.unwrap();
        let failed = work::find(&app.db, &job.id).await.unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert!(failed.error.unwrap().contains("Google connection changed"));
        assert!(
            app.db
                .list::<serde_json::Value>("meeting")
                .await
                .unwrap()
                .is_empty()
        );
        let retry = work::enqueue(&app.db, &job.kind, &job.key, job.input.clone())
            .await
            .unwrap();
        assert_eq!(retry.input["_google_binding"], job.input["_google_binding"]);
        work::run_once(&app).await.unwrap();
        assert!(
            work::find(&app.db, &retry.id)
                .await
                .unwrap()
                .unwrap()
                .error
                .unwrap()
                .contains("Google connection changed")
        );
    }
}

#[tokio::test]
async fn preflight_rejects_missing_and_mismatched_token_caches_without_network() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    assert!(
        chief_of_rust::integrations::google_preflight(&app)
            .await
            .is_err()
    );
    install_fixture(&app, 1, "owner-A").await;
    chief_of_rust::integrations::google_preflight(&app)
        .await
        .unwrap();
    app.db
        .put(
            "google_connection",
            "current",
            GoogleBinding {
                generation: 2,
                subject: Some("owner-B".into()),
            },
        )
        .await
        .unwrap();
    assert!(
        chief_of_rust::integrations::google_preflight(&app)
            .await
            .unwrap_err()
            .to_string()
            .contains("changed")
    );
}

#[tokio::test]
async fn every_google_job_freezes_grant_identity_including_video_observations() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let binding = install_fixture(&app, 3, "owner-A").await;
    for kind in [
        "meetings.gmail",
        "meetings.drive",
        "meetings.calendar",
        "content.trends",
        "tasks.sync",
    ] {
        let job = work::enqueue(&app.db, kind, kind, json!({"provider":"google"}))
            .await
            .unwrap();
        assert_eq!(
            job.input["_google_binding"],
            serde_json::to_value(&binding).unwrap()
        );
    }
}

#[tokio::test]
async fn fresh_delivery_cannot_update_a_task_owned_by_another_google_account() {
    use chief_of_rust::tasks::{ExternalLink, Task};
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let original = install_fixture(&app, 1, "owner-A").await;
    let server = axum_test::TestServer::new(routes::router(app.clone()));
    server
        .post("/tasks")
        .form(&[("title", "Private A task")])
        .await
        .assert_status_see_other();
    let mut task = app.db.list::<Task>("task").await.unwrap().pop().unwrap();
    task.links.push(ExternalLink {
        provider: "google".into(),
        container: "@default".into(),
        remote_id: Some("remote-from-A".into()),
        state: "linked".into(),
        error: None,
        synced_version: Some(task.version),
        google_binding: Some(original),
    });
    app.db.put("task", &task.id, task.clone()).await.unwrap();
    install_fixture(&app, 2, "owner-B").await;
    let response = server
        .post(&format!("/tasks/{}/link", task.id))
        .form(&[("provider", "google"), ("container", "@default")])
        .await;
    response.assert_status_see_other();
    let job_id = response
        .header("location")
        .to_str()
        .unwrap()
        .trim_start_matches("/runs/")
        .to_owned();
    work::run_once(&app).await.unwrap();
    let failed = work::find(&app.db, &job_id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("another Google account"));
    let saved = app.db.get::<Task>("task", &task.id).await.unwrap().unwrap();
    assert_eq!(saved.links[0].remote_id.as_deref(), Some("remote-from-A"));
    assert_eq!(
        saved.links[0]
            .google_binding
            .as_ref()
            .unwrap()
            .subject
            .as_deref(),
        Some("owner-A")
    );
}

#[tokio::test]
async fn unlink_archives_the_copy_preserves_local_work_and_fences_stale_forms() {
    use chief_of_rust::tasks::{self, ExternalLink, Task};
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let action = tasks::propose(
        &app.db,
        "meeting-A",
        "artifact-A",
        "Follow up",
        Some("Owner".into()),
        None,
        "Reviewed source context",
    )
    .await
    .unwrap();
    let mut task = tasks::accept(&app.db, &action.id).await.unwrap();
    let binding = GoogleBinding {
        generation: 1,
        subject: Some("owner-A".into()),
    };
    task.links.push(ExternalLink {
        provider: "google".into(),
        container: "@default".into(),
        remote_id: Some("retained-remote-copy".into()),
        state: "linked".into(),
        error: None,
        synced_version: Some(task.version),
        google_binding: Some(binding.clone()),
    });
    app.db.put("task", &task.id, task.clone()).await.unwrap();
    let server = axum_test::TestServer::new(routes::router(app.clone()));
    let route = format!("/tasks/{}/unlink", task.id);
    server
        .post(&route)
        .form(&[("provider", "google"), ("version", "0")])
        .await
        .assert_status_conflict();
    assert!(
        app.db
            .list::<serde_json::Value>("task_unlinked_copy")
            .await
            .unwrap()
            .is_empty()
    );
    let mut uncertain = task.clone();
    uncertain.links[0].state = "uncertain".into();
    app.db.put("task", &task.id, uncertain).await.unwrap();
    server
        .post(&route)
        .form(&[("provider", "google"), ("version", "1")])
        .await
        .assert_status_conflict();
    app.db.put("task", &task.id, task.clone()).await.unwrap();
    server
        .post(&route)
        .form(&[("provider", "google"), ("version", "1")])
        .await
        .assert_status_see_other();
    let saved = app.db.get::<Task>("task", &task.id).await.unwrap().unwrap();
    assert_eq!(saved.title, task.title);
    assert_eq!(saved.notes, task.notes);
    assert_eq!(
        serde_json::to_value(saved.source).unwrap(),
        serde_json::to_value(task.source).unwrap()
    );
    assert_eq!(saved.version, 2);
    assert!(saved.links.is_empty());
    let archive = app
        .db
        .list::<serde_json::Value>("task_unlinked_copy")
        .await
        .unwrap();
    assert_eq!(archive.len(), 1);
    assert_eq!(archive[0]["task_id"], task.id);
    assert_eq!(archive[0]["link"]["remote_id"], "retained-remote-copy");
    assert_eq!(
        archive[0]["link"]["google_binding"],
        serde_json::to_value(binding).unwrap()
    );
    assert_eq!(archive[0]["remote_effect"], "none; remote copy retained");
    server
        .post(&route)
        .form(&[("provider", "google"), ("version", "1")])
        .await
        .assert_status_conflict();
    assert_eq!(
        app.db
            .list::<serde_json::Value>("task_unlinked_copy")
            .await
            .unwrap()
            .len(),
        1
    );
}
