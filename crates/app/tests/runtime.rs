//! Exercise the real admission/router/provider boundary and inspect durable SQL.
use async_trait::async_trait;
use chief_of_rust::{
    App, Config,
    db::Db,
    llm::{self, LlmProvider},
    people::Person,
    settings::{self, Schedule},
    work,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{body_partial_json, method, path},
};

fn app(dir: &tempfile::TempDir) -> App {
    chief_of_rust::Installation::for_workspace(dir.path().to_path_buf()).app()
}
fn server(app: &App) -> axum_test::TestServer {
    axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()))
}
fn sql(app: &App) -> Connection {
    let conn = Connection::open(app.cfg().db_path()).unwrap();
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    conn
}
fn count(conn: &Connection, query: &str) -> i64 {
    conn.query_row(query, [], |r| r.get(0)).unwrap()
}

struct GatedResearch {
    entered: Notify,
    release: Notify,
    calls: AtomicUsize,
}
#[async_trait]
impl LlmProvider for GatedResearch {
    fn name(&self) -> &'static str {
        "runtime-fixture"
    }
    async fn complete(&self, _: &str) -> anyhow::Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.release.notified().await;
        Ok(
            json!({"claims":[],"unknowns":["No supporting source passage answers this question."]})
                .to_string(),
        )
    }
}
async fn queue_research(app: &App) -> String {
    let server = server(app);
    server
        .post("/terminal/people")
        .form(&[
            ("name", "Runtime Person"),
            ("email", "runtime@example.test"),
        ])
        .await
        .assert_status_see_other();
    let person = app
        .db()
        .list::<Person>("person")
        .await
        .unwrap()
        .pop()
        .unwrap();
    server
        .post(&format!("/terminal/people/{}/evidence", person.id))
        .form(&[
            ("title", "Evidence"),
            ("text", "Runtime Person joined Example in 2024."),
            ("kind", "manual"),
        ])
        .await
        .assert_status_see_other();
    let route = format!("/terminal/people/{}/research", person.id);
    let (first, second) = tokio::join!(
        server.post(&route).form(&[("question", "What is known?")]),
        server.post(&route).form(&[("question", "What is known?")])
    );
    first.assert_status_see_other();
    second.assert_status_see_other();
    assert_eq!(first.header("location"), second.header("location"));
    first
        .header("location")
        .to_str()
        .unwrap()
        .trim_start_matches("/runs/")
        .to_owned()
}
#[tokio::test]
async fn durable_admission_deduplicates_and_two_workers_execute_once_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let gated = Arc::new(GatedResearch {
        entered: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let first = app(&dir).with_llm(gated.clone());
    let id = queue_research(&first).await;
    // A second worker over the same workspace, with its own database handle.
    let second = app(&dir).with_llm(gated.clone());
    let running_app = first.clone();
    let worker = tokio::spawn(async move { work::run_once(&running_app).await });
    gated.entered.notified().await;
    assert!(!work::run_once(&second).await.unwrap());
    assert_eq!(gated.calls.load(Ordering::SeqCst), 1);
    gated.release.notify_one();
    assert!(worker.await.unwrap().unwrap());
    let conn = sql(&first);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM job"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM job_attempt"), 1);
    let attempt:(String,u32,Option<i64>,String)=conn.query_row("SELECT j.status,a.attempt,a.finished_at,a.outcome FROM job j JOIN job_attempt a ON a.job_id=j.id WHERE j.id=?1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(attempt.0, "done");
    assert_eq!(attempt.1, 1);
    assert!(attempt.2.is_some());
    assert_eq!(attempt.3, "done");
    drop(conn);
    let reopened = Db::open(&first.cfg().db_path()).unwrap();
    assert_eq!(
        work::find(&reopened, &id).await.unwrap().unwrap().status,
        "done"
    );
    assert_eq!(reopened.list::<Value>("dossier").await.unwrap().len(), 1);
}
#[tokio::test]
async fn failed_retry_preserves_original_attempt_and_links_new_run() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let original = work::enqueue(
        app.db(),
        "unsupported-test",
        "stable-key",
        json!({"immutable":"original input"}),
    )
    .await
    .unwrap();
    assert!(work::run_once(&app).await.unwrap());
    let conn = sql(&app);
    let before:(String,String,i64)=conn.query_row("SELECT j.error,a.outcome,a.finished_at FROM job j JOIN job_attempt a ON a.job_id=j.id WHERE j.id=?1",[&original.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    drop(conn);
    let server = server(&app);
    let response = server.post(&format!("/runs/{}/retry", original.id)).await;
    response.assert_status_see_other();
    let new_id = response
        .header("location")
        .to_str()
        .unwrap()
        .trim_start_matches("/runs/")
        .to_owned();
    assert_ne!(new_id, original.id);
    let retry = work::find(app.db(), &new_id).await.unwrap().unwrap();
    assert_eq!(retry.retry_of, Some(original.id.clone()));
    assert_eq!(retry.input, original.input);
    assert_eq!(retry.status, "queued");
    assert!(work::run_once(&app).await.unwrap());
    let conn = sql(&app);
    let after:(String,String,i64)=conn.query_row("SELECT j.error,a.outcome,a.finished_at FROM job j JOIN job_attempt a ON a.job_id=j.id WHERE j.id=?1",[&original.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(before, after);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM job_attempt"), 2);
    server
        .post(&format!("/runs/{}/retry", original.id))
        .await
        .assert_status_see_other();
}
#[tokio::test]
async fn expired_lease_is_recovered_without_stealing_a_live_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let expired = work::enqueue(app.db(), "unsupported-expired", "expired", json!({}))
        .await
        .unwrap();
    let active = work::enqueue(app.db(), "unsupported-active", "active", json!({}))
        .await
        .unwrap();
    let now = chief_of_rust::now_ms();
    let conn = sql(&app);
    for (id, lease) in [(&expired.id, now - 1000), (&active.id, now + 600_000)] {
        conn.execute(
            "UPDATE job SET status='running',attempt=1,lease_until=?2 WHERE id=?1",
            params![id, lease],
        )
        .unwrap();
        conn.execute("INSERT INTO job_attempt(job_id,attempt,started_at,provider,model) VALUES(?1,1,?2,'fixture','mistral-large-4')",params![id,now-10000]).unwrap();
    }
    drop(conn);
    assert!(work::run_once(&app).await.unwrap());
    assert!(!work::run_once(&app).await.unwrap());
    let expired_record = work::find(app.db(), &expired.id).await.unwrap().unwrap();
    assert_eq!(expired_record.status, "failed");
    assert_eq!(expired_record.attempt, 2);
    let active_record = work::find(app.db(), &active.id).await.unwrap().unwrap();
    assert_eq!(active_record.status, "running");
    assert_eq!(active_record.attempt, 1);
    let conn = sql(&app);
    let recovered: (Option<i64>, String) = conn
        .query_row(
            "SELECT finished_at,outcome FROM job_attempt WHERE job_id=?1 AND attempt=1",
            [&expired.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(recovered.0.is_some());
    assert_eq!(recovered.1, "interrupted: lease expired");
    let finished: Option<i64> = conn
        .query_row(
            "SELECT finished_at FROM job_attempt WHERE job_id=?1",
            [&active.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(finished.is_none());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM job_attempt"), 3);
}
#[tokio::test]
async fn misconfiguration_never_substitutes_mock_or_leaks_installation_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let mut changed = app.cfg().clone();
    changed.llm_provider = "unsupported".into();
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.mistral.api_key = Some("secret-installation-key".into());
    app = app.with_cfg(changed);
    app = app.with_llm(llm::from_config(app.cfg()));
    assert_eq!(app.llm().name(), "unavailable");
    let error = app.llm().complete("hello").await.unwrap_err().to_string();
    assert!(error.contains("Unknown LLM_PROVIDER"));
    assert!(!error.contains("secret-installation-key"));
    let server = server(&app);
    let response = server.post("/llm").form(&[("prompt", "hello")]).await;
    response.assert_status_internal_server_error();
    assert!(!response.text().contains("secret-installation-key"));
    assert!(app.db().stats().await.unwrap().last_call.is_none());
    let mut changed = app.cfg().clone();
    changed.llm_provider = "mistral".into();
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.mistral.api_key = None;
    app = app.with_cfg(changed);
    app = app.with_llm(llm::from_config(app.cfg()));
    assert!(app.llm().complete("hello").await.is_err());
    assert_eq!(app.llm().name(), "mistral");
}
#[tokio::test]
async fn provider_http_failure_is_durable_and_uses_only_mistral_large_4() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .and(body_partial_json(json!({"model":"mistral-large-4"})))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("Retry-After", "0")
                .set_body_json(json!({"error":"provider echoed secret-runtime-key"})),
        )
        .expect(2)
        .mount(&mock)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let mut changed = app.cfg().clone();
    changed.llm_provider = "mistral".into();
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.mistral.api_key = Some("secret-runtime-key".into());
    app = app.with_cfg(changed);
    let mut changed = app.cfg().clone();
    changed.mistral.base_url = Some(mock.uri());
    app = app.with_cfg(changed);
    app = app.with_llm(llm::from_config(app.cfg()));
    let id = queue_research(&app).await;
    assert!(work::run_once(&app).await.unwrap());
    let failed = work::find(app.db(), &id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    let error = failed.error.unwrap();
    assert!(error.contains("429"));
    assert!(!error.contains("secret-runtime-key"));
    assert!(app.db().list::<Value>("dossier").await.unwrap().is_empty());
    let conn = sql(&app);
    let (provider, model, outcome): (String, String, String) = conn
        .query_row(
            "SELECT provider,model,outcome FROM job_attempt WHERE job_id=?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(provider, "mistral");
    assert_eq!(model, "mistral-large-4");
    assert!(!outcome.contains("secret-runtime-key"));
    let response = server(&app).get(&format!("/runs/{id}")).await;
    assert!(!response.text().contains("secret-runtime-key"));
}
#[tokio::test]
async fn preferences_validate_timezone_and_fence_stale_updates_in_the_revision_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/settings")
        .form(&[
            ("revision", "18446744073709551615"),
            ("timezone", "America/New_York"),
            ("calendar_id", "primary"),
        ])
        .await
        .assert_status_bad_request();
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("timezone", "Not/AZone"),
            ("calendar_id", "primary"),
        ])
        .await
        .assert_status_bad_request();
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("owner_name", "Nicolas"),
            ("timezone", "Europe/Paris"),
            ("calendar_id", "primary"),
        ])
        .await
        .assert_status_see_other();
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("owner_name", "Stale name"),
            ("timezone", "America/New_York"),
            ("calendar_id", "other"),
        ])
        .await
        .assert_status_conflict();
    let saved = settings::load(app.db()).await.unwrap();
    assert_eq!(saved.timezone, "Europe/Paris");
    assert_eq!(saved.owner_name, "Nicolas");
    assert_eq!(saved.revision, 1);
    let conn = sql(&app);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM revision WHERE kind='settings'"),
        1
    );
    let revision: i64 = conn
        .query_row(
            "SELECT revision FROM record WHERE kind='settings' AND id='workspace'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(revision, 1);
    let reopened = Db::open(&app.cfg().db_path()).unwrap();
    assert_eq!(
        settings::load(&reopened).await.unwrap().timezone,
        "Europe/Paris"
    );
}
#[tokio::test]
async fn disabled_schedules_admit_nothing_and_revoked_drive_consent_blocks_queued_work() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    settings::tick(&app).await.unwrap();
    assert!(work::list(app.db()).await.unwrap().is_empty());
    server
        .post("/settings/schedules")
        .form(&[("kind", "meetings.calendar"), ("interval_minutes", "5")])
        .await
        .assert_status_see_other();
    settings::tick(&app).await.unwrap();
    assert!(work::list(app.db()).await.unwrap().is_empty());
    let schedule: Schedule = app
        .db()
        .get("schedule", "meetings.calendar")
        .await
        .unwrap()
        .unwrap();
    assert!(!schedule.enabled);
    assert!(schedule.last_enqueued_at.is_none());
    server
        .post("/settings/schedules")
        .form(&[
            ("kind", "meetings.drive"),
            ("interval_minutes", "5"),
            ("enabled", "true"),
        ])
        .await
        .assert_status_bad_request();
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("timezone", "America/New_York"),
            ("calendar_id", "primary"),
            ("drive_folder_id", "folder-1"),
            ("drive_consent", "true"),
        ])
        .await
        .assert_status_see_other();
    server
        .post("/settings/schedules")
        .form(&[
            ("kind", "meetings.drive"),
            ("interval_minutes", "5"),
            ("enabled", "true"),
        ])
        .await
        .assert_status_see_other();
    chief_of_rust::meetings::enqueue_scheduled(&app, "meetings.drive")
        .await
        .unwrap();
    let queued = work::list(app.db()).await.unwrap().pop().unwrap();
    server
        .post("/settings")
        .form(&[
            ("revision", "1"),
            ("timezone", "America/New_York"),
            ("calendar_id", "primary"),
            ("drive_folder_id", "folder-1"),
        ])
        .await
        .assert_status_see_other();
    assert!(work::run_once(&app).await.unwrap());
    let failed = work::find(app.db(), &queued.id).await.unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.error.unwrap().contains("consent"));
    assert!(
        app.db()
            .list::<Value>("transcript")
            .await
            .unwrap()
            .is_empty()
    );
    settings::tick(&app).await.unwrap();
    assert_eq!(work::list(app.db()).await.unwrap().len(), 1);
    let schedule: Schedule = app
        .db()
        .get("schedule", "meetings.drive")
        .await
        .unwrap()
        .unwrap();
    assert!(schedule.last_error.unwrap().contains("consent"));
}
#[tokio::test]
async fn local_router_rejects_remote_hosts_origins_and_cross_site_requests() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .get("/healthz")
        .add_header("host", "remote.example")
        .await
        .assert_status_forbidden();
    server
        .post("/tasks")
        .add_header("host", "localhost:5317")
        .add_header("origin", "https://evil.example")
        .form(&[("title", "Injected")])
        .await
        .assert_status_forbidden();
    server
        .post("/tasks")
        .add_header("host", "localhost:5317")
        .add_header("origin", "http://localhost:9999")
        .form(&[("title", "Wrong port")])
        .await
        .assert_status_forbidden();
    server
        .post("/tasks")
        .add_header("host", "localhost:5317")
        .add_header("sec-fetch-site", "same-site")
        .form(&[("title", "Other local website")])
        .await
        .assert_status_forbidden();
    assert!(app.db().list::<Value>("task").await.unwrap().is_empty());
    let response = server
        .get("/healthz")
        .add_header("host", "localhost:5317")
        .add_header("origin", "http://localhost:5317")
        .await;
    response.assert_status_ok();
    assert_eq!(response.header("cache-control"), "no-store");
    assert_eq!(response.header("x-content-type-options"), "nosniff");
}
#[tokio::test]
async fn oauth_callback_consumes_state_once_even_when_sign_in_is_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app(&dir);
    let client_path = dir.path().join("google-client.json");
    std::fs::write(
        &client_path,
        json!({"web":{"client_id":"test-google-client","client_secret":"test-google-secret"}})
            .to_string(),
    )
    .unwrap();
    let mut changed = app.cfg().clone();
    changed.google_secret_path = Some(client_path);
    app = app.with_cfg(changed);
    let server = server(&app);
    let connect = server.get("/google/connect").await;
    connect.assert_status_see_other();
    let url = url::Url::parse(connect.header("location").to_str().unwrap()).unwrap();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    assert!(
        !connect
            .header("location")
            .to_str()
            .unwrap()
            .contains("test-google-secret")
    );
    let route = format!("/google/callback?state={state}&error=access_denied");
    let first = server
        .get(&route)
        .add_header("sec-fetch-site", "cross-site")
        .await;
    first.assert_status_bad_request();
    assert!(first.text().contains("cancelled"));
    let replay = server
        .get(&route)
        .add_header("sec-fetch-site", "cross-site")
        .await;
    replay.assert_status_bad_request();
    assert!(replay.text().contains("already used"));
    let conn = sql(&app);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM record WHERE kind='oauth_state'"
        ),
        0
    );
    assert!(!app.cfg().google_token_path.exists());
    server
        .get("/google/callback?state=unknown&error=access_denied")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn concurrent_independent_workspace_connections_share_one_admission() {
    let dir = tempfile::tempdir().unwrap();
    let first = app(&dir);
    let second = Db::open(&first.cfg().db_path()).unwrap();
    for round in 0..20 {
        let key = format!("independent-{round}");
        let (a, b) = tokio::join!(
            work::enqueue(
                first.db(),
                "unsupported-concurrent",
                &key,
                json!({"source":"first"})
            ),
            work::enqueue(
                &second,
                "unsupported-concurrent",
                &key,
                json!({"source":"second"})
            )
        );
        let (a, b) = (
            a.expect("first connection admits or reuses the run"),
            b.expect("second connection admits or reuses the run"),
        );
        assert_eq!(a.id, b.id);
        assert_eq!(a.input, b.input);
    }
    let conn = sql(&first);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM job"), 20);
}

#[tokio::test]
async fn logical_deletion_and_record_recreation_continue_the_durable_revision_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    app.db()
        .put("runtime-record", "stable-id", json!({"value":"first"}))
        .await
        .unwrap();
    app.db()
        .put("runtime-record", "stable-id", json!({"value":"corrected"}))
        .await
        .unwrap();
    app.db()
        .delete("runtime-record", "stable-id")
        .await
        .unwrap();
    assert!(
        app.db()
            .get::<Value>("runtime-record", "stable-id")
            .await
            .unwrap()
            .is_none()
    );
    let reopened = Db::open(&app.cfg().db_path()).unwrap();
    reopened
        .put("runtime-record", "stable-id", json!({"value":"recreated"}))
        .await
        .unwrap();
    let conn = sql(&app);
    let current: i64 = conn
        .query_row(
            "SELECT revision FROM record WHERE kind='runtime-record' AND id='stable-id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(current, 3);
    let mut stmt=conn.prepare("SELECT revision,body FROM revision WHERE kind='runtime-record' AND id='stable-id' ORDER BY revision").unwrap();
    let history = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        history.iter().map(|(rev, _)| *rev).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&history[0].1).unwrap()["value"],
        "first"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&history[1].1).unwrap()["value"],
        "corrected"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&history[2].1).unwrap()["value"],
        "recreated"
    );
}

#[tokio::test]
async fn selected_live_providers_persist_actual_models_across_reopen() {
    for (name, model) in [
        ("opencode", "gpt-5.6-luna"),
        ("zai", "glm-5.3"),
        ("ollama-cloud", "deepseek-v4-pro:0813"),
    ] {
        let mock = MockServer::start().await;
        let answer = json!({"claims":[], "unknowns":["No supporting source passage answers this question."]}).to_string();
        let response = if name == "opencode" {
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":answer}]}]})
        } else {
            json!({"choices":[{"finish_reason":"stop","message":{"content":answer}}]})
        };
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .expect(1)
            .mount(&mock)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().to_path_buf());
        let config = match name {
            "opencode" => &mut cfg.opencode,
            "zai" => &mut cfg.zai,
            _ => &mut cfg.ollama_cloud,
        };
        config.api_key = Some("fixture-key".into());
        config.base_url = Some(mock.uri());
        let app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
        server(&app)
            .post("/settings/providers")
            .form(&[("revision", "0"), ("generation", name), ("search", "")])
            .await
            .assert_status_see_other();
        server(&app)
            .post("/settings/providers/models")
            .form(&[
                ("revision", "1"),
                ("provider", name),
                ("model", model),
                ("reasoning_effort", "high"),
            ])
            .await
            .assert_status_see_other();
        let id = queue_research(&app).await;
        assert!(work::run_once(&app).await.unwrap());
        let job = work::find(app.db(), &id).await.unwrap().unwrap();
        assert_eq!(job.status, "done", "{:?}", job.error);
        let reopened = Db::open(&app.cfg().db_path()).unwrap();
        let dossier = reopened
            .get::<chief_of_rust::people::Dossier>("dossier", &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            dossier.unknowns,
            vec!["No supporting source passage answers this question."]
        );
        let (provider, recorded_model): (String, String) = sql(&app)
            .query_row(
                "SELECT provider,model FROM job_attempt WHERE job_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(provider, name);
        assert_eq!(recorded_model, model);
        if name == "opencode" {
            let requests = mock.received_requests().await.unwrap();
            assert_eq!(requests[0].headers["x-opencode-session"], dossier.run_id);
        }
    }
}

#[tokio::test]
async fn contact_and_workspace_forms_preserve_each_others_saved_fields() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let server = server(&app);
    server
        .post("/settings")
        .form(&[
            ("revision", "0"),
            ("owner_name", "Elena García"),
            ("timezone", "Europe/Madrid"),
            ("calendar_id", "team@example.test"),
            ("drive_folder_id", "transcripts-folder"),
            ("drive_consent", "true"),
        ])
        .await
        .assert_status_see_other();
    let html = server.get("/settings").await.text();
    assert!(html.contains("action=\"/settings/contact\""));
    server
        .post("/settings/contact")
        .form(&[
            ("revision", "1"),
            ("research_contact", " elena@example.test "),
        ])
        .await
        .assert_status_see_other();
    let saved = settings::load(app.db()).await.unwrap();
    assert_eq!(saved.owner_name, "Elena García");
    assert_eq!(saved.timezone, "Europe/Madrid");
    assert_eq!(saved.calendar_id, "team@example.test");
    assert_eq!(saved.drive_folder_id, "transcripts-folder");
    assert!(saved.drive_consent);
    assert_eq!(
        saved.research_contact.as_deref(),
        Some("elena@example.test")
    );
    assert_eq!(saved.revision, 2);
    server
        .post("/settings")
        .form(&[
            ("revision", "2"),
            ("owner_name", "Elena García updated"),
            ("timezone", "Europe/Madrid"),
            ("calendar_id", "team@example.test"),
            ("drive_folder_id", "transcripts-folder"),
        ])
        .await
        .assert_status_see_other();
    let saved = settings::load(app.db()).await.unwrap();
    assert_eq!(saved.owner_name, "Elena García updated");
    assert!(!saved.drive_consent);
    assert_eq!(
        saved.research_contact.as_deref(),
        Some("elena@example.test")
    );
    assert_eq!(saved.revision, 3);
    server
        .post("/settings/contact")
        .form(&[
            ("revision", "2"),
            ("research_contact", "stale@example.test"),
        ])
        .await
        .assert_status_conflict();
    server
        .post("/settings/contact")
        .form(&[("revision", "3"), ("research_contact", "not-an-email")])
        .await
        .assert_status_bad_request();
    server
        .post("/settings/contact")
        .form(&[
            ("revision", "18446744073709551615"),
            ("research_contact", "elena@example.test"),
        ])
        .await
        .assert_status_bad_request();
    assert_eq!(settings::load(app.db()).await.unwrap().revision, 3);
    server
        .post("/settings/contact")
        .form(&[("revision", "3"), ("research_contact", "")])
        .await
        .assert_status_see_other();
    let reopened = Db::open(&app.cfg().db_path()).unwrap();
    let saved = settings::load(&reopened).await.unwrap();
    assert_eq!(saved.revision, 4);
    assert_eq!(saved.owner_name, "Elena García updated");
    assert_eq!(saved.drive_folder_id, "transcripts-folder");
    assert_eq!(saved.calendar_id, "team@example.test");
    assert_eq!(saved.timezone, "Europe/Madrid");
    assert!(saved.research_contact.is_none());
}

#[tokio::test]
async fn stale_worker_cannot_append_a_second_outcome_to_a_recovered_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let gated = Arc::new(GatedResearch {
        entered: Notify::new(),
        release: Notify::new(),
        calls: AtomicUsize::new(0),
    });
    let first = app(&dir).with_llm(gated.clone());
    let id = queue_research(&first).await;
    let running_app = first.clone();
    let worker = tokio::spawn(async move { work::run_once(&running_app).await });
    gated.entered.notified().await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if work::events(first.db(), &id)
                .await
                .unwrap()
                .iter()
                .any(|event| event.stage == "lease_renewed")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    sql(&first)
        .execute("UPDATE job SET lease_until=0 WHERE id=?1", [&id])
        .unwrap();
    assert!(work::run_once(&app(&dir)).await.unwrap());
    let before = work::find(first.db(), &id).await.unwrap().unwrap();
    gated.release.notify_one();
    assert!(worker.await.unwrap().unwrap());
    let after = work::find(first.db(), &id).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    let events = work::events(first.db(), &id).await.unwrap();
    assert!(
        !events
            .iter()
            .any(|e| e.attempt == 1 && matches!(e.status.as_str(), "done" | "failed"))
    );
    let (closed, outcome): (Option<i64>, String) = sql(&first)
        .query_row(
            "SELECT finished_at,outcome FROM job_attempt WHERE job_id=?1 AND attempt=1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(closed.is_some());
    assert_eq!(outcome, "interrupted: lease expired");
}

#[tokio::test]
async fn full_diagnostic_timeline_still_retains_the_terminal_record() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let job = work::enqueue(app.db(), "unsupported-capped", "capped", json!({}))
        .await
        .unwrap();
    for _ in 0..work::RUN_EVENT_CAP {
        work::record_event(
            app.db(),
            &job.id,
            0,
            chief_of_rust::connection::RecordedEvent::new(
                "diagnostic",
                None,
                "running",
                None,
                None,
            ),
        )
        .await
        .unwrap();
    }
    assert!(work::run_once(&app).await.unwrap());
    let events = work::events(app.db(), &job.id).await.unwrap();
    assert_eq!(events.len(), work::RUN_EVENT_CAP as usize + 1);
    let terminal = events.last().unwrap();
    assert_eq!(terminal.status, "failed");
    assert_eq!(terminal.attempt, 1);
    assert!(
        terminal
            .detail
            .as_deref()
            .unwrap()
            .contains("Unsupported Run kind")
    );
}

#[tokio::test]
async fn recovered_run_totals_include_every_billed_attempt_and_disclose_missing_usage() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let seen = requests.clone();
    let gate = release.clone();
    let router = axum::Router::new().route("/chat/completions", axum::routing::post(move || {
        let seen = seen.clone();
        let gate = gate.clone();
        async move {
            let first = seen.fetch_add(1, Ordering::SeqCst) == 0;
            if first { gate.notified().await; }
            axum::Json(json!({
                "choices":[{"finish_reason":"stop","message":{"content":"{\"claims\":[],\"unknowns\":[\"No supporting source passage answers this question.\"]}"}}],
                "usage":{"prompt_tokens":if first {5} else {11},"completion_tokens":if first {3} else {7},"cost":if first {0.002} else {0.004}}
            }))
        }
    }));
    let mock_server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut cfg = Config::for_workspace(dir.path().into());
    cfg.llm_provider = "opencode".into();
    cfg.opencode.model = "beam-free".into();
    cfg.opencode.reasoning_effort = "low".into();
    cfg.opencode.api_key = Some("recovered-usage-secret".into());
    cfg.opencode.base_url = Some(endpoint);
    let app = chief_of_rust::Installation::for_config(cfg).unwrap().app();
    let id = queue_research(&app).await;
    let running = app.clone();
    let first = tokio::spawn(async move { work::run_once(&running).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if requests.load(Ordering::SeqCst) == 1
                && work::events(app.db(), &id)
                    .await
                    .unwrap()
                    .iter()
                    .any(|event| event.stage == "lease_renewed")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    sql(&app)
        .execute("UPDATE job SET lease_until=0 WHERE id=?1", [&id])
        .unwrap();
    assert!(work::run_once(&app).await.unwrap());
    let server = server(&app);
    let pending: Value = server.get(&format!("/runs/{id}/diagnostics")).await.json();
    assert_eq!(pending["usage"]["unrecorded_attempts"], json!([1]));
    assert_eq!(pending["usage"]["llm_input_tokens"], 11);
    assert!(pending["usage"]["llm_cost_usd"].is_null());
    server
        .get(&format!("/runs/{id}"))
        .await
        .assert_text_contains("Usage unavailable for 1 attempts");
    release.notify_one();
    assert!(first.await.unwrap().unwrap());
    let diagnostics: Value = server.get(&format!("/runs/{id}/diagnostics")).await.json();
    let usage = &diagnostics["usage"];
    assert_eq!(usage["llm_input_tokens"], 16);
    assert_eq!(usage["llm_output_tokens"], 10);
    assert!((usage["llm_cost_usd"].as_f64().unwrap() - 0.006).abs() < 1e-12);
    assert_eq!(usage["unrecorded_attempts"], json!([]));
    assert_eq!(usage["generation_calls"].as_array().unwrap().len(), 2);
    assert_eq!(usage["generation_calls"][0]["attempt"], 1);
    assert_eq!(usage["generation_calls"][1]["attempt"], 2);
    for (attempt, input) in [(1, 5), (2, 11)] {
        let saved: Value = app
            .db()
            .get("run_usage", &format!("{id}:{attempt}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved["llm_input_tokens"], input);
        assert!(!saved.to_string().contains("recovered-usage-secret"));
    }
    server
        .get(&format!("/runs/{id}"))
        .await
        .assert_text_contains("16 measured input and 10 measured output tokens");
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    mock_server.abort();
}
