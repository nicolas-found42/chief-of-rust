//! Opt-in real-provider evaluation; private corpus and outputs stay outside Git.
use chief_of_rust::{App, Config, db::Db, llm, meetings, work};
use serde_json::json;

#[tokio::test]
#[ignore = "Explicit live meeting corpus experiment: requires both installed provider keys"]
async fn live_meeting_corpus() {
    let corpus = std::env::var("MEETING_CORPUS_FILE").expect("Set MEETING_CORPUS_FILE");
    let output = std::env::var("MEETING_EVAL_OUTPUT").expect("Set private MEETING_EVAL_OUTPUT");
    assert!(
        std::path::Path::new(&output).is_absolute(),
        "Use an absolute private output path"
    );
    assert!(std::path::Path::new(&output).parent().unwrap().exists());
    let text = std::fs::read_to_string(&corpus).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::from_env();
    cfg.workspace_dir = dir.path().into();
    cfg.google_token_path = dir.path().join("no-google-tokens");
    let app = App {
        judge: chief_of_rust::judgments::from_config(&cfg),
        llm: llm::from_config(&cfg),
        db: Db::open(&cfg.db_path()).unwrap(),
        cfg,
    };
    let meeting = meetings::create_record(
        &app.db,
        meetings::MeetingInput {
            title: "Private transcript evaluation".into(),
            starts_at: "2026-10-13T14:00:00-04:00".into(),
            attendees: String::new(),
            purpose: String::new(),
            notes: String::new(),
            revision: None,
        },
    )
    .await
    .unwrap();
    let transcript = meetings::upload_record(
        &app.db,
        "Evaluation dialogue",
        &text,
        Some(meeting.id.clone()),
    )
    .await
    .unwrap();
    let job = work::enqueue(
        &app.db,
        "meetings.debrief",
        "evaluation",
        json!({"meeting":meeting,"transcripts":[transcript]}),
    )
    .await
    .unwrap();
    let start = std::time::Instant::now();
    work::run_once(&app).await.unwrap();
    let saved_job = work::find(&app.db, &job.id).await.unwrap().unwrap();
    let artifacts = app
        .db
        .list::<meetings::Artifact>("meeting_artifact")
        .await
        .unwrap();
    let traces = app
        .db
        .list::<serde_json::Value>("meeting_debrief_trace")
        .await
        .unwrap();
    std::fs::write(output, serde_json::to_vec_pretty(&json!({"elapsed_ms":start.elapsed().as_millis(),"job":saved_job,"artifacts":artifacts,"traces":traces})).unwrap()).unwrap();
    println!(
        "corpus bytes={} status={} artifacts={} elapsed_ms={}",
        text.len(),
        saved_job.status,
        artifacts.len(),
        start.elapsed().as_millis()
    );
    let expected = std::env::var("MEETING_EVAL_EXPECTED_STATUS").unwrap_or_else(|_| "done".into());
    assert_eq!(
        saved_job.status,
        expected,
        "{}",
        saved_job.error.clone().unwrap_or_default()
    );
    if expected == "done" {
        assert_eq!(artifacts.len(), 1);
        if let Ok(count) = std::env::var("MEETING_EVAL_ACTIONS") {
            assert_eq!(artifacts[0].actions.len(), count.parse::<usize>().unwrap());
        }
        if let Ok(kinds) = std::env::var("MEETING_EVAL_CATEGORIES") {
            let d = artifacts[0].debrief.as_ref().unwrap();
            for kind in kinds.split(',') {
                assert!(
                    d.items
                        .iter()
                        .any(|i| i.kind == kind && i.status == "supported"),
                    "Missing supported {kind}"
                );
            }
        }
    } else {
        assert!(artifacts.is_empty());
        let error = std::env::var("MEETING_EVAL_ERROR")
            .expect("Set MEETING_EVAL_ERROR for a negative case");
        assert!(saved_job.error.unwrap().contains(&error));
    }
}
