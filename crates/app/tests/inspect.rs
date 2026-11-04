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
