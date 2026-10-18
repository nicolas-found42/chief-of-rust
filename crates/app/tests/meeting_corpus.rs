//! Opt-in real-provider evaluation; private corpus and outputs stay outside Git.
use chief_of_rust::{Config, db::Db, llm, meetings, work};
use serde_json::json;

#[tokio::test]
#[ignore = "Explicit live meeting corpus experiment: requires both installed provider keys"]
async fn live_meeting_corpus() {
    let corpus = std::env::var("MEETING_CORPUS_FILE").expect("Set MEETING_CORPUS_FILE");
    assert!(
        !corpus.contains("83C2ZZFS"),
        "Excluded at the user's direction"
    );
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
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    let meeting = meetings::create_record(
        app.db(),
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
        app.db(),
        "Evaluation dialogue",
        &text,
        Some(meeting.id.clone()),
    )
    .await
    .unwrap();
    let job = work::enqueue(
        app.db(),
        "meetings.debrief",
        "evaluation",
        json!({"meeting":meeting,"transcripts":[transcript]}),
    )
    .await
    .unwrap();
    let start = std::time::Instant::now();
    work::run_once(&app).await.unwrap();
    let saved_job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    let artifacts = app
        .db()
        .list::<meetings::Artifact>("meeting_artifact")
        .await
        .unwrap();
    let traces = app
        .db()
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
#[tokio::test]
#[ignore = "Explicit live weekly consumer of an authorized saved long debrief"]
async fn live_weekly_from_saved_long_debrief() {
    let source = std::env::var("MEETING_WEEKLY_INPUT").expect("Set private MEETING_WEEKLY_INPUT");
    let output = std::env::var("MEETING_WEEKLY_OUTPUT").expect("Set private MEETING_WEEKLY_OUTPUT");
    assert!(std::path::Path::new(&output).is_absolute());
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
    let meeting: meetings::Meeting =
        serde_json::from_value(saved["job"]["input"]["meeting"].clone()).unwrap();
    let transcripts: Vec<meetings::Transcript> =
        serde_json::from_value(saved["job"]["input"]["transcripts"].clone()).unwrap();
    assert!(!transcripts.iter().any(|t| t.text.contains("83C2ZZFS")));
    let mut artifact: meetings::Artifact =
        serde_json::from_value(saved["artifacts"][0].clone()).unwrap();
    // A disposable reviewed fixture exercises the actual downstream consumer.
    artifact.reviewed = true;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::from_env();
    cfg.workspace_dir = dir.path().into();
    cfg.google_token_path = dir.path().join("no-google-tokens");
    let app = chief_of_rust::Installation::with_connections(
        cfg.clone(),
        Db::open(&cfg.db_path()).unwrap(),
        llm::from_config(&cfg),
        chief_of_rust::judgments::from_config(&cfg),
        std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
    )
    .app();
    app.db()
        .put("meeting", &meeting.id, meeting.clone())
        .await
        .unwrap();
    for t in transcripts {
        app.db().put("transcript", &t.id, t.clone()).await.unwrap();
    }
    app.db()
        .put("meeting_artifact", &artifact.id, artifact.clone())
        .await
        .unwrap();
    let job = work::enqueue(
        app.db(),
        "meetings.weekly",
        "long-weekly-consumer",
        json!({"from":"2026-10-12","to":"2026-10-18","meetings":[meeting],"artifacts":[artifact]}),
    )
    .await
    .unwrap();
    let start = std::time::Instant::now();
    work::run_once(&app).await.unwrap();
    let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
    let reviews = app
        .db()
        .list::<meetings::WeeklyReview>("meeting_weekly")
        .await
        .unwrap();
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"mode":"fresh live Mistral weekly consumer of saved debrief; disposable reviewed fixture","elapsed_ms":start.elapsed().as_millis(),"job":job,"reviews":reviews})).unwrap()).unwrap();
    println!(
        "live long-debrief weekly status={} reviews={} elapsed_ms={}",
        job.status,
        reviews.len(),
        start.elapsed().as_millis()
    );
    assert_eq!(job.status, "done", "{}", job.error.unwrap_or_default());
    assert_eq!(reviews.len(), 1);
    assert!(!reviews[0].body.is_empty());
}

#[tokio::test]
#[ignore = "Explicit fresh-provider scheduling comparison on authorized real transcript excerpts"]
async fn live_meeting_latency_benchmark() {
    let source = std::env::var("MEETING_BENCH_CASES").expect("Set private MEETING_BENCH_CASES");
    let output_dir =
        std::env::var("MEETING_BENCH_OUTPUT_DIR").expect("Set private MEETING_BENCH_OUTPUT_DIR");
    assert!(std::path::Path::new(&output_dir).is_absolute());
    let cases: serde_json::Value = serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
    assert!(!cases.to_string().contains("83C2ZZFS"));
    let modes = std::env::var("MEETING_BENCH_MODES").unwrap_or_else(|_| "1,2,4".into());
    let mut failures = Vec::new();
    for mode in modes.split(',') {
        let concurrency: usize = mode.parse().unwrap();
        assert!((1..=4).contains(&concurrency));
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::from_env();
        cfg.meeting_segment_concurrency = concurrency;
        cfg.workspace_dir = dir.path().into();
        cfg.google_token_path = dir.path().join("no-google-tokens");
        let app = chief_of_rust::Installation::with_connections(
            cfg.clone(),
            Db::open(&cfg.db_path()).unwrap(),
            llm::from_config(&cfg),
            chief_of_rust::judgments::from_config(&cfg),
            std::sync::Arc::new(chief_of_rust::collect::Pacer::system()),
        )
        .app();
        let meeting = meetings::create_record(
            app.db(),
            meetings::MeetingInput {
                title: "Private latency and accuracy benchmark".into(),
                starts_at: "2026-10-13T14:00:00-04:00".into(),
                attendees: String::new(),
                purpose: String::new(),
                notes: String::new(),
                revision: None,
            },
        )
        .await
        .unwrap();
        let mut transcripts = Vec::new();
        for case in cases.as_array().unwrap() {
            transcripts.push(
                meetings::upload_record(
                    app.db(),
                    case["title"].as_str().unwrap(),
                    case["text"].as_str().unwrap(),
                    Some(meeting.id.clone()),
                )
                .await
                .unwrap(),
            );
        }
        let job = work::enqueue(
            app.db(),
            "meetings.debrief",
            "latency-benchmark",
            json!({"meeting":meeting,"transcripts":transcripts}),
        )
        .await
        .unwrap();
        let start = std::time::Instant::now();
        work::run_once(&app).await.unwrap();
        let job = work::find(app.db(), &job.id).await.unwrap().unwrap();
        let artifacts = app
            .db()
            .list::<meetings::Artifact>("meeting_artifact")
            .await
            .unwrap();
        let traces = app
            .db()
            .list::<serde_json::Value>("meeting_debrief_trace")
            .await
            .unwrap();
        let path =
            std::path::Path::new(&output_dir).join(format!("concurrency-{concurrency}.json"));
        assert!(
            !path.exists(),
            "Preserve previous measurements; use a fresh output directory"
        );
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"mode":"fresh providers; real transcript excerpts; not full-meeting completeness","concurrency":concurrency,"elapsed_ms":start.elapsed().as_millis(),"job":job,"artifacts":artifacts,"traces":traces})).unwrap()).unwrap();
        println!(
            "concurrency={concurrency} status={} elapsed_ms={}",
            job.status,
            start.elapsed().as_millis()
        );
        if job.status != "done" {
            assert!(artifacts.is_empty(), "failed runs must publish nothing");
            failures.push(format!(
                "concurrency={concurrency}: {}",
                job.error.unwrap_or_default()
            ));
            continue;
        }
        assert_eq!(artifacts.len(), 1);
        assert_eq!(
            artifacts[0].debrief.as_ref().unwrap().segments.len(),
            cases.as_array().unwrap().len()
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("; "));
}
