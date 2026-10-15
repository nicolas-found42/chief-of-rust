//! Real search HTTP and queued product execution, with credentials removed
//! in a child process so search configuration cannot race other tests.
use async_trait::async_trait;
use chief_of_rust::{App, Config, content::Report, db::Db, llm::LlmProvider, work};
use serde_json::{Value, json};
use std::{process::Command, sync::Arc};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};

struct EvidenceSummary;
#[async_trait]
impl LlmProvider for EvidenceSummary {
    fn name(&self) -> &'static str {
        "mock"
    }
    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        if let Some((_, sources)) = prompt.split_once(" Sources: ") {
            let evidence: Value = serde_json::from_str(sources)?;
            return Ok(json!({"claims":[{"text":"Fixture excerpt","source_id":evidence[0]["id"],"quote":"First useful source."}],"unknowns":["Identity attribution requires review."]}).to_string());
        }
        Ok(json!({"body":"Fixture summary; inspect the saved snippets.","source_ids":[],"unsupported_claims":["Fixture output does not verify source facts."]}).to_string())
    }
}

#[tokio::test]
async fn public_research_preserves_unique_useful_evidence_and_reports_gaps() {
    let search = MockServer::start().await;
    let mut rows = Vec::new();
    for fragment in 0..12 {
        rows.push(json!({"url":format!("https://example.com/a#part{fragment}"),"title":"A","content":"First useful source."}));
    }
    rows.extend([
        json!({"url":"ftp://example.com/file","content":"invalid scheme"}),
        json!({"url":"http://127.0.0.1/private","content":"private source"}),
        json!({"url":"https://user:password@example.com/secret","content":"embedded credentials"}),
        json!({"url":"https://example.com/empty","content":""}),
        json!({"url":"https://example.com/blank","content":"   "}),
    ]);
    for name in ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] {
        rows.push(json!({"url":format!("https://example.com/{name}"),"title":name.to_string(),"content":if name=='c'{"é".repeat(6001)}else{format!("Useful source {name}.")}}));
    }
    Mock::given(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"results":rows,"unresponsive_engines":[["example-engine","timeout"]]}),
        ))
        .mount(&search)
        .await;
    assert_child(run_isolated(&search.uri(), "mixed").await);
}

#[tokio::test]
async fn public_research_with_only_empty_snippets_fails_without_a_report() {
    let search = MockServer::start().await;
    Mock::given(path("/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":[{"url":"https://example.com/empty","content":""},{"url":"https://example.com/blank","content":" \n "}]})))
        .mount(&search)
        .await;
    assert_child(run_isolated(&search.uri(), "empty").await);
}

#[tokio::test]
async fn optional_empty_search_preserves_saved_person_evidence() {
    for rows in [
        json!([]),
        json!([{"url":"https://example.com/empty","content":"  "}]),
    ] {
        let search = MockServer::start().await;
        Mock::given(path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results":rows})))
            .mount(&search)
            .await;
        assert_child(run_isolated(&search.uri(), "manual").await);
    }
}

#[tokio::test]
async fn public_research_http_and_shape_failures_remain_failed_runs() {
    for (response, case) in [
        (
            ResponseTemplate::new(503).set_body_string("private upstream diagnostic"),
            "http_error",
        ),
        (
            ResponseTemplate::new(200).set_body_json(json!({"results":"wrong shape"})),
            "shape_error",
        ),
        (
            ResponseTemplate::new(200).set_body_string("not JSON"),
            "json_error",
        ),
    ] {
        let search = MockServer::start().await;
        Mock::given(path("/search"))
            .respond_with(response)
            .mount(&search)
            .await;
        assert_child(run_isolated(&search.uri(), case).await);
    }
}

async fn run_isolated(search_url: &str, case: &str) -> std::process::Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "research_child", "--nocapture"])
        .env_clear()
        .env("SEARXNG_BASE_URL", search_url)
        .env("CHIEF_RESEARCH_CASE", case);
    if case == "proxy" {
        command
            .env("HTTP_PROXY", search_url)
            .env("http_proxy", search_url);
    }
    let output = tokio::task::spawn_blocking(move || command.output().unwrap())
        .await
        .unwrap();
    let transcript = String::from_utf8_lossy(&output.stdout);
    println!("{transcript}");
    output
}

fn assert_child(output: std::process::Output) {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn public_source_dns_pinning_is_not_bypassed_by_ambient_proxy() {
    let proxy = MockServer::start().await;
    Mock::given(wiremock::matchers::method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .set_body_string("Unexpected proxy source"),
        )
        .mount(&proxy)
        .await;
    let output = run_isolated(&proxy.uri(), "proxy").await;
    let requests = proxy.received_requests().await.unwrap();
    println!(
        "local proxy received {} requests: {:?}",
        requests.len(),
        requests
            .iter()
            .map(|r| r.url.to_string())
            .collect::<Vec<_>>()
    );
    assert_child(output);
    assert!(requests.is_empty());
}

#[test]
fn research_child() {
    let Ok(case) = std::env::var("CHIEF_RESEARCH_CASE") else {
        return;
    };
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        if case == "proxy" {
            // A public IP literal avoids DNS and the two-second cancellation
            // bounds the direct-connection control after the fix.
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                chief_of_rust::integrations::fetch_public("http://93.184.215.14/fixture"),
            )
            .await;
            println!("proxy probe={result:?}");
            assert!(
                !matches!(result, Ok(Ok(ref text)) if text == "Unexpected proxy source"),
                "A proxy returned source bytes outside the pinned connection"
            );
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = Config::for_workspace(dir.path().to_owned());
        cfg.searxng_base_url = std::env::var("SEARXNG_BASE_URL").ok();
        let app = App {
            judge: chief_of_rust::judgments::from_config(&cfg),
            db: Db::open(&cfg.db_path()).unwrap(),
            cfg,
            llm: Arc::new(EvidenceSummary),
        };
        let server = axum_test::TestServer::new(chief_of_rust::routes::router(app.clone()));
        if case == "manual" {
            server
                .post("/terminal/people")
                .form(&[
                    ("name", "Manual Person"),
                    ("email", "fixture@example.test"),
                    ("role", "Tester"),
                    ("company", "Fictional organization"),
                ])
                .await
                .assert_status_see_other();
            let person = app
                .db
                .list::<chief_of_rust::people::Person>("person")
                .await
                .unwrap()
                .pop()
                .unwrap();
            server
                .post(&format!("/terminal/people/{}/evidence", person.id))
                .form(&[
                    ("title", "Saved manual source"),
                    ("text", "First useful source."),
                    ("url", ""),
                    ("kind", "manual"),
                ])
                .await
                .assert_status_see_other();
            server
                .post(&format!("/terminal/people/{}/research", person.id))
                .form(&[
                    ("question", "What did the saved source say?"),
                    ("search", "true"),
                ])
                .await
                .assert_status_see_other();
            assert!(work::run_once(&app).await.unwrap());
            let job = work::list(&app.db).await.unwrap().pop().unwrap();
            let dossiers = app
                .db
                .list::<chief_of_rust::people::Dossier>("dossier")
                .await
                .unwrap();
            println!(
                "manual evidence case: status={}, dossiers={}, error={:?}",
                job.status,
                dossiers.len(),
                job.error
            );
            assert_eq!(job.status, "done");
            assert_eq!(dossiers.len(), 1);
            assert_eq!(dossiers[0].evidence.len(), 1);
            assert_eq!(dossiers[0].evidence[0].kind, "manual");
            assert_eq!(dossiers[0].claims[0].quote, "First useful source.");
            assert_eq!(dossiers[0].search_coverage.as_ref().unwrap().selected, 0);
            return;
        }
        server
            .post("/research/watches")
            .form(&[("name", "Corpus watch"), ("query", "fixture subject")])
            .await
            .assert_status_see_other();
        server.post("/research/run").await.assert_status_see_other();
        assert!(work::run_once(&app).await.unwrap());
        let jobs = work::list(&app.db).await.unwrap();
        let reports = app.db.list::<Report>("content.report").await.unwrap();
        println!(
            "case={case}; job={}; reports={}; saved_urls={:?}",
            jobs[0].status,
            reports.len(),
            reports
                .iter()
                .flat_map(|r| r.evidence.iter().map(|e| e.url.clone()))
                .collect::<Vec<_>>()
        );
        println!(
            "saved_texts={:?}",
            reports
                .iter()
                .flat_map(|r| r.evidence.iter().map(|e| (
                    e.text.chars().count(),
                    e.text.chars().take(80).collect::<String>()
                )))
                .collect::<Vec<_>>()
        );
        if matches!(
            case.as_str(),
            "empty" | "http_error" | "shape_error" | "json_error"
        ) {
            assert_eq!(jobs[0].status, "failed");
            assert!(reports.is_empty());
            let expected = match case.as_str() {
                "empty" => "no usable",
                "http_error" => "HTTP 503",
                "shape_error" => "no result list",
                _ => "invalid JSON",
            };
            assert!(jobs[0].error.as_ref().unwrap().contains(expected));
            assert!(
                !jobs[0]
                    .error
                    .as_ref()
                    .unwrap()
                    .contains("private upstream diagnostic")
            );
            return;
        }
        assert_eq!(jobs[0].status, "done");
        assert_eq!(reports.len(), 1);
        let report = &reports[0];
        let urls: Vec<_> = report
            .evidence
            .iter()
            .map(|e| e.url.clone().unwrap())
            .collect();
        assert_eq!(
            urls,
            ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(|c| format!("https://example.com/{c}"))
        );
        assert!(report.evidence.iter().all(|e| !e.text.trim().is_empty()));
        let value: Value = serde_json::to_value(report).unwrap();
        let coverage = &value["search_coverage"];
        println!("coverage={coverage}");
        assert_eq!(coverage["providers"], json!(["searxng"]));
        assert_eq!(coverage["received"], 26);
        assert_eq!(coverage["duplicates"], 11);
        assert_eq!(coverage["invalid"], 3);
        assert_eq!(coverage["empty"], 2);
        assert_eq!(coverage["selected"], 8);
        assert_eq!(coverage["omitted"], 2);
        assert_eq!(coverage["truncated"], 1);
        assert_eq!(coverage["unresponsive_engines"], json!(["example-engine"]));
        assert_eq!(report.evidence[2].text.chars().count(), 6000);
        let html = server
            .get(&format!("/research/reports/{}", report.id))
            .await
            .text();
        assert!(html.contains("Search snippets"));
        assert!(html.contains("example-engine"));
        assert!(html.contains("First result page"));
        assert!(html.contains("2 unique results omitted"));
        // Reopening reads the full record, including coverage, rather than
        // trusting the Run's status or a summary count.
        let reopened = Db::open(&app.cfg.db_path()).unwrap();
        let saved: Value = reopened
            .get("content.report", &report.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved, value);
        server
            .post("/content/projects")
            .form(&[
                ("subject", "Corpus subject"),
                ("objective", "Check source coverage"),
                ("audience", "Test operators"),
                ("target", "website-blog-article"),
                ("material", "Original fixture context"),
            ])
            .await
            .assert_status_see_other();
        let project = app
            .db
            .list::<chief_of_rust::content::Project>("content.project")
            .await
            .unwrap()
            .pop()
            .unwrap();
        server
            .post(&format!(
                "/content/projects/{}/generate/research",
                project.id
            ))
            .form(&[("revision", "1")])
            .await
            .assert_status_see_other();
        assert!(work::run_once(&app).await.unwrap());
        let project: chief_of_rust::content::Project = app
            .db
            .get("content.project", &project.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(project.current().number, 2);
        assert_eq!(project.current().evidence.len(), 8);
        assert_eq!(
            project.current().artifacts[0]
                .search_coverage
                .as_ref()
                .unwrap()
                .duplicates,
            11
        );
        assert!(
            server
                .get(&format!("/content/projects/{}", project.id))
                .await
                .text()
                .contains("Search snippets")
        );
        server
            .post("/terminal/people")
            .form(&[
                ("name", "Corpus Person"),
                ("email", "fixture@example.test"),
                ("role", "Test researcher"),
                ("company", "Fictional organization"),
            ])
            .await
            .assert_status_see_other();
        let person = app
            .db
            .list::<chief_of_rust::people::Person>("person")
            .await
            .unwrap()
            .pop()
            .unwrap();
        server
            .post(&format!("/terminal/people/{}/research", person.id))
            .form(&[
                ("question", "What does the fixture say?"),
                ("search", "true"),
            ])
            .await
            .assert_status_see_other();
        assert!(work::run_once(&app).await.unwrap());
        let dossier = app
            .db
            .list::<chief_of_rust::people::Dossier>("dossier")
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(dossier.evidence.len(), 8);
        assert_eq!(dossier.claims[0].quote, "First useful source.");
        assert_eq!(dossier.search_coverage.as_ref().unwrap().duplicates, 11);
        assert!(
            server
                .get(&format!(
                    "/terminal/people/{}/dossiers/{}",
                    person.id, dossier.id
                ))
                .await
                .text()
                .contains("Search snippets")
        );
        println!(
            "watch, project and dossier persisted coverage; dossier quote matches original snippet"
        );
        let mut legacy = value;
        legacy.as_object_mut().unwrap().remove("search_coverage");
        legacy["artifact"]
            .as_object_mut()
            .unwrap()
            .remove("search_coverage");
        let old: Report = serde_json::from_value(legacy).unwrap();
        assert!(old.search_coverage.is_none());
        assert!(old.artifact.search_coverage.is_none());
    });
}
