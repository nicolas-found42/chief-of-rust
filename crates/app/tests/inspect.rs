//! The documented reconstruction path, exercised as an operator runs it: build
//! a store through the real code paths, then read it back through the shipped
//! binary with only environment configuration.
use chief_of_rust::Installation;
use serde_json::Value;
use std::process::Command;

fn inspect(workspace: &std::path::Path, args: &[&str]) -> (Option<i32>, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_chief-of-rust"))
        .arg("inspect")
        .args(args)
        .env("WORKSPACE_DIR", workspace)
        .output()
        .expect("run the shipped binary");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// One failed Run, one queued Run, and worker boot/heartbeat evidence,
/// produced through the same seams the server uses.
async fn seeded_workspace(dir: &tempfile::TempDir) -> (String, String) {
    let app = Installation::for_workspace(dir.path().to_path_buf()).app();
    let failed = chief_of_rust::work::enqueue(
        app.db(),
        "unsupported-inspect",
        "failed-key",
        serde_json::json!({}),
    )
    .await
    .unwrap();
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let queued = chief_of_rust::work::enqueue(
        app.db(),
        "unsupported-inspect",
        "queued-key",
        serde_json::json!({}),
    )
    .await
    .unwrap();
    app.db()
        .record_ops_event("worker", "started", None)
        .await
        .unwrap();
    app.db().record_tick(chief_of_rust::now_ms()).await.unwrap();
    (failed.id, queued.id)
}

#[tokio::test]
async fn symptom_first_investigation_finds_the_run_and_its_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let (failed_id, queued_id) = seeded_workspace(&dir).await;

    // Start from a symptom and an approximate window: "failures yesterday",
    // expressed as an RFC 3339 instant two days back.
    let since = (chrono::Utc::now() - chrono::Duration::days(2))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (code, stdout, stderr) = inspect(
        dir.path(),
        &["runs", "--status", "failed", "--since", &since],
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let runs: Value = serde_json::from_str(&stdout).unwrap();
    let rows = runs.as_array().unwrap();
    assert_eq!(rows.len(), 1, "one failed Run in the window: {stdout}");
    assert_eq!(rows[0]["id"], serde_json::json!(failed_id));
    assert_eq!(rows[0]["kind"], serde_json::json!("unsupported-inspect"));
    assert!(rows[0]["created_at_utc"].as_str().unwrap().ends_with('Z'));

    // Follow the identifier into attempts, timeline and usage.
    let (code, stdout, stderr) = inspect(dir.path(), &["run", &failed_id]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let detail: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(detail["status"], serde_json::json!("failed"));
    assert_eq!(detail["timeline_truncated"], serde_json::json!(false));
    let attempts = detail["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 1);
    assert!(attempts[0]["finished_at_utc"].is_string());
    let timeline = detail["timeline"].as_array().unwrap();
    assert!(
        timeline
            .iter()
            .any(|event| event["stage"] == serde_json::json!("admitted")),
        "timeline: {stdout}"
    );

    // The queued Run is not reported as failed, so a symptom query does not
    // over-report the blast radius.
    let (_, stdout, _) = inspect(dir.path(), &["runs", "--status", "failed"]);
    assert!(!stdout.contains(&queued_id));
}

#[tokio::test]
async fn ops_and_health_are_readable_without_the_server() {
    let dir = tempfile::tempdir().unwrap();
    let _ = seeded_workspace(&dir).await;
    let (code, stdout, stderr) = inspect(dir.path(), &["ops"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let events: Value = serde_json::from_str(&stdout).unwrap();
    assert!(
        events
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["source"] == serde_json::json!("worker")
                && event["event"] == serde_json::json!("started")),
        "ops: {stdout}"
    );

    let (code, stdout, stderr) = inspect(dir.path(), &["health"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let health: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(health["store"], serde_json::json!("ok"));
    assert_eq!(health["failed"], serde_json::json!(1));
    assert_eq!(health["queued"], serde_json::json!(1));
    assert!(health["worker_tick_age_ms"].as_i64().unwrap() < 60_000);
}

#[tokio::test]
async fn health_surfaces_distinguish_an_unreadable_heartbeat_from_a_cold_worker() {
    let dir = tempfile::tempdir().unwrap();
    let app = Installation::for_workspace(dir.path().to_path_buf()).app();
    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    let (code, stdout, stderr) = inspect(dir.path(), &["health"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let health: Value = serde_json::from_str(&stdout).unwrap();
    assert!(health.get("worker_tick_age_ms").unwrap().is_null());

    app.db()
        .transaction(|tx| Ok(tx.execute("DROP TABLE tick", [])?))
        .await
        .unwrap();
    let probe = server.get("/healthz").await;
    probe.assert_status_ok();
    probe.assert_text_contains("worker_tick_age_ms=unreadable");
    let (code, stdout, stderr) = inspect(dir.path(), &["health"]);
    assert_eq!(code, Some(1), "stderr: {stderr}");
    assert!(stdout.is_empty());
    assert!(stderr.contains("no such table: tick"), "stderr: {stderr}");
}

#[tokio::test]
async fn wrong_identifiers_and_missing_stores_fail_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let _ = seeded_workspace(&dir).await;
    let (code, stdout, stderr) = inspect(dir.path(), &["run", "no-such-run"]);
    assert_eq!(code, Some(1), "unknown ids exit non-zero");
    assert!(stdout.is_empty());
    assert!(stderr.contains("no-such-run"), "stderr: {stderr}");

    let empty = tempfile::tempdir().unwrap();
    let (code, _, stderr) = inspect(empty.path(), &["runs"]);
    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Workspace store not found"),
        "absence of evidence is reported, not rendered as empty: {stderr}"
    );

    // A misspelled flag must not return an unfiltered window that reads as
    // a correct answer.
    let (code, _, stderr) = inspect(dir.path(), &["runs", "--sine", "2026-11-03T00:00:00Z"]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("--sine"), "stderr: {stderr}");

    // Epoch seconds read as milliseconds would silently land in 1970.
    let seconds = (chrono::Utc::now().timestamp()).to_string();
    let (code, _, stderr) = inspect(dir.path(), &["runs", "--since", &seconds]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("epoch seconds"), "stderr: {stderr}");

    // A flag whose value is missing must not swallow the next flag.
    let (code, _, stderr) = inspect(dir.path(), &["runs", "--since", "--kind", "x"]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("--since needs a value"), "stderr: {stderr}");

    // `health` takes no --limit; accepting and ignoring it would hide a typo.
    let (code, _, stderr) = inspect(dir.path(), &["health", "--limit", "5"]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("--limit"), "stderr: {stderr}");

    let (code, stdout, _) = inspect(dir.path(), &["--help"]);
    assert_eq!(code, Some(0), "--help is not an error");
    assert!(stdout.contains("USAGE:"));

    std::fs::write(dir.path().join("chief.db"), b"not a database").unwrap();
    let (code, _, stderr) = inspect(dir.path(), &["health"]);
    assert_eq!(code, Some(1));
    assert!(stderr.contains("Cannot open"), "stderr: {stderr}");
}

#[tokio::test]
async fn request_id_retry_links_and_health_boundaries_are_retrievable() {
    let dir = tempfile::tempdir().unwrap();
    let app = Installation::for_workspace(dir.path().to_path_buf()).app();
    let correlated = chief_of_rust::correlation::scope("req-obs-42".to_owned(), async {
        chief_of_rust::work::enqueue(
            app.db(),
            "unsupported-inspect",
            "corr-key",
            serde_json::json!({}),
        )
        .await
        .unwrap()
    })
    .await;
    assert!(chief_of_rust::work::run_once(&app).await.unwrap());
    let other = chief_of_rust::work::enqueue(
        app.db(),
        "unsupported-inspect",
        "other-key",
        serde_json::json!({}),
    )
    .await
    .unwrap();

    let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
    let retry_resp = server.post(&format!("/runs/{}/retry", correlated.id)).await;
    retry_resp.assert_status_see_other();
    let retried_id = retry_resp
        .header("location")
        .to_str()
        .unwrap()
        .trim_start_matches("/runs/")
        .to_owned();

    // Filter by --request-id: finds only the correlated Run, not the uncorrelated one.
    let (code, stdout, stderr) = inspect(dir.path(), &["runs", "--request-id", "req-obs-42"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let rows: Value = serde_json::from_str(&stdout).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], serde_json::json!(correlated.id));
    assert_ne!(rows[0]["id"], serde_json::json!(other.id));

    // Truncation notice on stderr when --limit is reached.
    let (code, _, stderr) = inspect(dir.path(), &["runs", "--limit", "1"]);
    assert_eq!(code, Some(0));
    assert!(stderr.contains("may be truncated"), "stderr: {stderr}");

    // Forward retry link on the original failed Run.
    let (code, stdout, stderr) = inspect(dir.path(), &["run", &correlated.id]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let detail: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(detail["retried_by"], serde_json::json!([retried_id]));

    // Health reports version, store_path, and retention_caps.
    let (code, stdout, stderr) = inspect(dir.path(), &["health"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let health: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        health["version"],
        serde_json::json!(env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(
        health["retention_caps"]["ops_events"],
        serde_json::json!(200)
    );
    assert_eq!(
        health["retention_caps"]["run_events_per_run"],
        serde_json::json!(500)
    );
}

#[tokio::test]
async fn cross_run_and_pre_run_evidence_is_retrievable_by_symptom() {
    let dir = tempfile::tempdir().unwrap();
    let (failed_id, queued_id) = seeded_workspace(&dir).await;
    let app = Installation::for_workspace(dir.path().to_path_buf()).app();

    // A 500 that never admitted a Run, recovered by the browser request id.
    app.db()
        .record_http_error(
            "incident-request-7",
            "POST",
            "/meetings/abc/debrief",
            500,
            "provider request failed (timeout; operation timed out)",
        )
        .await
        .unwrap();

    // A workflow checkpoint beside the failed Run: not a timeline row.
    app.db()
        .put(
            "meeting_debrief_trace",
            "trace-1",
            serde_json::json!({
                "id": "trace-1", "run_id": failed_id, "attempt": 1,
                "phase": "Dialogue screened", "segment": 1, "total_segments": 2,
                "recorded_at": chief_of_rust::now_ms(), "details": {"reason": "first segment"}
            }),
        )
        .await
        .unwrap();

    // Saved schedule state: the last attempt is when the scheduler last fired.
    app.db()
        .put(
            "schedule",
            "content.scout",
            chief_of_rust::settings::Schedule {
                kind: "content.scout".into(),
                interval_minutes: 5,
                enabled: true,
                last_enqueued_at: Some(chief_of_rust::now_ms()),
                last_error: Some("Add an active source before running Scout".into()),
            },
        )
        .await
        .unwrap();

    let (code, stdout, stderr) =
        inspect(dir.path(), &["http", "--request-id", "incident-request-7"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let rows: Value = serde_json::from_str(&stdout).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1, "{stdout}");
    assert_eq!(rows[0]["path"], serde_json::json!("/meetings/abc/debrief"));
    assert_eq!(rows[0]["status"], serde_json::json!(500));
    assert!(
        rows[0]["detail"]
            .as_str()
            .unwrap()
            .contains("operation timed out")
    );

    // Cross-Run search: the symptom class is findable without opening Runs.
    let since = (chrono::Utc::now() - chrono::Duration::days(2))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let (code, stdout, stderr) = inspect(
        dir.path(),
        &[
            "events", "--stage", "admitted", "--status", "queued", "--since", &since,
        ],
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let events: Value = serde_json::from_str(&stdout).unwrap();
    let events = events.as_array().unwrap();
    assert_eq!(events.len(), 2, "one admitted row per queued Run: {stdout}");
    assert!(
        events
            .iter()
            .all(|event| event["run_id"].is_string() && event["at_utc"].is_string())
    );

    // The failed Run's checkpoint survives beside its timeline, as progress
    // metadata: the detail values stay out of the diagnostics surface.
    let (code, stdout, stderr) = inspect(dir.path(), &["run", &failed_id]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let detail: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(detail["traces_truncated"], serde_json::json!(false));
    let traces = detail["traces"].as_array().unwrap();
    assert_eq!(traces.len(), 1, "{stdout}");
    assert_eq!(
        traces[0]["kind"],
        serde_json::json!("meeting_debrief_trace")
    );
    assert_eq!(traces[0]["phase"], serde_json::json!("Dialogue screened"));
    assert_eq!(
        traces[0]["details_keys"],
        serde_json::json!(["reason"]),
        "detail values stay out; only their names are projected"
    );

    // Schedule state carries the last attempt time and its bounded error.
    let (code, stdout, stderr) = inspect(dir.path(), &["schedules"]);
    assert_eq!(code, Some(0), "stderr: {stderr}");
    let schedules: Value = serde_json::from_str(&stdout).unwrap();
    let schedules = schedules.as_array().unwrap();
    assert_eq!(schedules.len(), 1, "{stdout}");
    assert_eq!(schedules[0]["kind"], serde_json::json!("content.scout"));
    assert!(schedules[0]["last_enqueued_at_utc"].is_string());
    assert!(
        schedules[0]["last_error"]
            .as_str()
            .unwrap()
            .contains("source")
    );
    assert_eq!(queued_id.len(), 36);
}
