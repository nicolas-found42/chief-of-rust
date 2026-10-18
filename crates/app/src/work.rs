//! Durable Runs: queue admission, leased execution and immutable attempts.
//! A retry is a new Run pointing to the failed one so the failure stays a fact.
use crate::{
    App,
    db::Db,
    web::{self, escape},
};
use axum::{
    Router,
    extract::{Path, State},
    response::{Redirect, Response},
    routing::{get, post},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS job(id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedup_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT, error TEXT, retry_of TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_job ON job(kind,dedup_key) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS job_attempt(job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(job_id,attempt));
";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub input: Value,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub attempt: u32,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub retry_of: Option<String>,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    fn json(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Value> {
        let text: String = row.get(idx)?;
        serde_json::from_str(&text).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
        })
    }
    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        key: row.get(2)?,
        input: json(row, 3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        attempt: row.get(7)?,
        result: if row.get::<_, Option<String>>(8)?.is_some() {
            Some(json(row, 8)?)
        } else {
            None
        },
        error: row.get(9)?,
        retry_of: row.get(10)?,
    })
}
const COLUMNS: &str =
    "id,kind,dedup_key,input,status,created_at,updated_at,attempt,result,error,retry_of";

pub(crate) fn enqueue_tx(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    key: &str,
    mut input: Value,
) -> anyhow::Result<Job> {
    if let Some(job)=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE kind=?1 AND dedup_key=?2 AND status IN ('queued','running')"),params![kind,key],from_row).optional()? { return Ok(job); }
    if crate::integrations::uses_google(kind, &input) && input.get("_google_binding").is_none() {
        input["_google_binding"] =
            serde_json::to_value(crate::integrations::GoogleBinding::load(tx)?)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::now_ms();
    tx.execute("INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'queued',?5,?5)",params![id,kind,key,serde_json::to_string(&input)?,now])?;
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS} FROM job WHERE id=?1"),
        [id],
        from_row,
    )?)
}

pub async fn enqueue(db: &Db, kind: &str, key: &str, input: Value) -> anyhow::Result<Job> {
    let (kind, key) = (kind.to_owned(), key.to_owned());
    db.transaction(move |tx| enqueue_tx(tx, &kind, &key, input))
        .await
}

pub async fn find(db: &Db, id: &str) -> anyhow::Result<Option<Job>> {
    let id = id.to_owned();
    db.transaction(move |tx| {
        Ok(tx
            .query_row(
                &format!("SELECT {COLUMNS} FROM job WHERE id=?1"),
                [id],
                from_row,
            )
            .optional()?)
    })
    .await
}

pub async fn list(db: &Db) -> anyhow::Result<Vec<Job>> {
    db.transaction(|tx| {
        let mut stmt = tx.prepare(&format!(
            "SELECT {COLUMNS} FROM job ORDER BY created_at DESC,id LIMIT 200"
        ))?;
        Ok(stmt
            .query_map([], from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
}

async fn claim(app: &App) -> anyhow::Result<Option<Job>> {
    let (provider, model) = (app.llm.name().to_owned(), app.cfg.llm_model().to_owned());
    app.db.transaction(move |tx| {
        let now=crate::now_ms();
        // The expired attempt is closed before the same Run is recovered.
        // Live leases are never stolen by a second process sharing the volume.
        tx.execute("UPDATE job_attempt SET finished_at=?1,outcome='interrupted: lease expired' WHERE finished_at IS NULL AND job_id IN (SELECT id FROM job WHERE status='running' AND lease_until<=?1)",[now])?;
        tx.execute("UPDATE job SET status='queued',lease_until=NULL WHERE status='running' AND lease_until<=?1",[now])?;
        let job=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE status='queued' ORDER BY created_at,id LIMIT 1"),[],from_row).optional()?;
        let Some(job)=job else {return Ok(None)};
        tx.execute("UPDATE job SET status='running',attempt=attempt+1,lease_until=?2,updated_at=?3 WHERE id=?1",params![job.id,now+600_000,now])?;
        tx.execute("INSERT INTO job_attempt(job_id,attempt,started_at,provider,model) VALUES(?1,?2,?3,?4,?5)",params![job.id,job.attempt+1,now,provider,model])?;
        Ok(Some(tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE id=?1"),[job.id],from_row)?))
    }).await
}

/// Runs one admitted job; used by the worker and integration tests through
/// the identical product dispatch. No fixture writes bypass the workflows.
pub async fn run_once(app: &App) -> anyhow::Result<bool> {
    let selected_app = crate::settings::providers::resolve(app).await?;
    let app = &selected_app;
    let Some(job) = claim(app).await? else {
        return Ok(false);
    };
    let mut run_app = app.clone();
    if let Some(provider) = app.llm.for_session(&job.id) {
        run_app.llm = provider;
    }
    if matches!(job.kind.as_str(), "terminal.profile" | "terminal.report")
        && let Some(provider) = run_app
            .llm
            .with_request_timeout(std::time::Duration::from_secs(
                app.cfg.terminal_limits.request_seconds,
            ))
    {
        run_app.llm = provider;
    }
    let execution = dispatch(&run_app, &job);
    tokio::pin!(execution);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    let outcome = loop {
        tokio::select! {
            result=&mut execution=>break result,
            _=heartbeat.tick()=> {
                let (id,attempt)=(job.id.clone(),job.attempt);
                let renewed=app.db.transaction(move|tx|Ok(tx.execute("UPDATE job SET lease_until=?3 WHERE id=?1 AND attempt=?2 AND status='running'",params![id,attempt,crate::now_ms()+600_000])?==1)).await?;
                anyhow::ensure!(renewed,"Run lease no longer belongs to this worker");
            }
        }
    };
    let (status, result, error) = match outcome {
        Ok(result) => ("done", Some(serde_json::to_string(&result)?), None),
        Err(error) => {
            let error = crate::llm::redact_error(&error.to_string(), &app.cfg);
            tracing::warn!(kind=%job.kind,run=%job.id,"Run failed");
            ("failed", None, Some(error))
        }
    };
    let job = job.clone();
    app.db.transaction(move |tx| {
        let now=crate::now_ms();
        tx.execute("UPDATE job SET status=?2,result=?3,error=?4,lease_until=NULL,updated_at=?5 WHERE id=?1 AND status='running' AND attempt=?6",params![job.id,status,result,error,now,job.attempt])?;
        tx.execute("UPDATE job_attempt SET finished_at=?3,outcome=?4 WHERE job_id=?1 AND attempt=?2 AND finished_at IS NULL",params![job.id,job.attempt,now,error.as_deref().unwrap_or("done")])?;
        if status == "failed" && job.kind == "terminal.profile"
            && let Some(id) = job.input["request_id"].as_str()
            && let Some(mut request) = crate::store::get::<crate::terminal::automatic::Request>(tx,"terminal_request",id)?
            && request.run_id == job.id && request.status != "complete" {
            request.status = "failed".into();
            request.phase = "Research failed; the previous dossier remains visible".into();
            crate::store::put(tx,"terminal_request",id,&request)?;
        }

        Ok(())
    }).await?;
    Ok(true)
}

async fn dispatch(app: &App, job: &Job) -> anyhow::Result<Value> {
    let binding = job
        .input
        .get("_google_binding")
        .map(|value| serde_json::from_value::<crate::integrations::GoogleBinding>(value.clone()))
        .transpose()?;
    anyhow::ensure!(
        !crate::integrations::uses_google(&job.kind, &job.input) || binding.is_some(),
        "Google Run has no account binding; request fresh work"
    );
    crate::integrations::GOOGLE_RUN_BINDING
        .scope(binding, dispatch_product(app, job))
        .await
}
async fn dispatch_product(app: &App, job: &Job) -> anyhow::Result<Value> {
    if job.kind.starts_with("meetings.") {
        crate::meetings::execute(app, job).await
    } else if job.kind.starts_with("people.") {
        crate::people::execute(app, job).await
    } else if job.kind.starts_with("tasks.") {
        crate::tasks::execute(app, job).await
    } else if matches!(job.kind.as_str(), "terminal.profile" | "terminal.report") {
        crate::terminal::automatic::execute(app, job).await
    } else if job.kind == "terminal.comparison" {
        crate::terminal::comparison::execute(app, job).await
    } else if job.kind == "terminal.person_research" {
        crate::terminal::person::execute(app, job).await
    } else if job.kind == "terminal.company_continue" {
        crate::terminal::execution::execute_continue(app, job).await
    } else if job.kind == "terminal.person_continue" {
        crate::terminal::person::execute_continue(app, job).await
    } else if job.kind.starts_with("terminal.") {
        crate::terminal::execution::execute(app, job).await
    } else if job.kind.starts_with("content.") {
        crate::content::execute(app, job).await
    } else {
        Err(anyhow::anyhow!("Unsupported Run kind: {}", job.kind))
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/runs", get(index))
        .route("/runs/{id}", get(detail))
        .route("/runs/{id}/retry", post(retry))
}
async fn index(State(app): State<App>) -> web::Result<Response> {
    let jobs = list(&app.db).await?;
    let mut body = String::from(
        "<p>Every generation and synchronization has a durable Run. Failed attempts stay recorded when retried.</p><div class=\"stack\">",
    );
    for job in jobs {
        body += &format!(
            "<article><a href=\"/runs/{}\">{}</a>{}<p>{}</p></article>",
            escape(&job.id),
            escape(&run_title(&app, &job).await?),
            web::badge(&job.status),
            web::saved_time(job.created_at, "UTC")
        );
    }
    body += "</div>";
    Ok(web::page("Runs", web::Body::new(body)))
}
async fn detail(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let job = find(&app.db, &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    let mut body = format!(
        "<p><strong>{}</strong> · {} · attempt {}</p>",
        escape(&run_title(&app, &job).await?),
        web::badge(&job.status),
        job.attempt
    );
    if let Some(prior) = &job.retry_of {
        body += &format!(
            "<p>Retry of <a href=\"/runs/{}\">the original failed Run</a></p>",
            escape(prior)
        );
    }
    if let Some(error) = &job.error {
        body += &format!(
            "<p role=\"alert\">{}</p><form method=\"post\" action=\"/runs/{}/retry\"><button class=\"btn-primary\">Retry with the original input</button></form>",
            escape(error),
            escape(&id)
        );
    }
    body += &format!(
        "<p>Created {} · Updated {}</p>",
        web::saved_time(job.created_at, "UTC"),
        web::saved_time(job.updated_at, "UTC")
    );
    if let Some(result) = &job.result {
        if let Some(valid) = result.get("ledger_valid").and_then(Value::as_bool) {
            body += &format!(
                "<p>Evidence ledger: {}</p>",
                web::badge(if valid { "reviewed" } else { "Ledger warnings" })
            );
        }
        if let Some(path) = result
            .get("url")
            .and_then(Value::as_str)
            .filter(|p| p.starts_with('/') && !p.starts_with("//"))
        {
            body += &format!(
                "<p><a class=\"button btn-primary\" href=\"{}\">Open the result</a></p>",
                escape(path)
            );
        }
        body += &format!(
            "<details><summary>Result JSON</summary><pre>{}</pre></details>",
            escape(&serde_json::to_string_pretty(&result).unwrap_or_default())
        );
    }
    if job.status == "queued" || job.status == "running" {
        body += "<p role=\"status\"><span class=\"progress\" aria-hidden=\"true\"></span>Work continues in the background. This page updates every 3 seconds. <a href=\"\">Refresh this Run</a> to see the result.</p>";
    }
    if job.kind == "meetings.debrief" {
        let mut traces = app
            .db
            .list::<Value>("meeting_debrief_trace")
            .await?
            .into_iter()
            .filter(|t| t["run_id"].as_str() == Some(&id))
            .collect::<Vec<_>>();
        traces.sort_by_key(|t| t["recorded_at"].as_i64().unwrap_or_default());
        body += "<h2>Debrief progress and evidence checks</h2><p>Completed stages remain recorded if a later stage fails. A Run result is saved only after all required checks finish.</p><ul>";
        for t in traces {
            body += &format!(
                "<li>Attempt {}: {} · segment {} of {}<details><summary>Stage evidence and usage</summary><pre>{}</pre></details></li>",
                t["attempt"],
                escape(t["phase"].as_str().unwrap_or("Unknown stage")),
                t["segment"],
                t["total_segments"],
                escape(&serde_json::to_string_pretty(&t["details"]).unwrap_or_default())
            );
        }
        body += "</ul>";
    }
    body += &format!(
        "<details><summary>Input snapshot</summary><pre>{}</pre></details>",
        escape(&serde_json::to_string_pretty(&job.input).unwrap_or_default())
    );
    Ok(web::page_refresh(
        "Run details",
        web::Body::new(body),
        matches!(job.status.as_str(), "queued" | "running"),
    ))
}
async fn retry(State(app): State<App>, Path(id): Path<String>) -> web::Result<Redirect> {
    let old = find(&app.db, &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    if old.status != "failed" {
        return Err(web::Error::conflict("Only a failed Run can be retried."));
    }
    let new = app
        .db
        .transaction(move |tx| {
            let new = enqueue_tx(tx, &old.kind, &old.key, old.input.clone())?;
            tx.execute(
                "UPDATE job SET retry_of=?2 WHERE id=?1 AND retry_of IS NULL",
                params![new.id, old.id],
            )?;
            if old.kind == "terminal.profile" {
                let request_id = old.input["request_id"].as_str().unwrap_or_default();
                let mut request: crate::terminal::automatic::Request =
                    crate::store::get(tx, "terminal_request", request_id)?
                        .ok_or_else(|| anyhow::anyhow!("Request missing"))?;
                anyhow::ensure!(
                    request.run_id == old.id,
                    "A newer request already replaced this failed run"
                );
                request.run_id = new.id.clone();
                request.status = "researching".into();
                request.phase = "Retry queued".into();
                crate::store::put(tx, "terminal_request", request_id, &request)?;
            }
            if old.kind == "terminal.report" {
                let report_id = old.input["report_id"].as_str().unwrap_or_default();
                let mut report: Value = crate::store::get(tx, "terminal_report", report_id)?
                    .ok_or_else(|| anyhow::anyhow!("Report missing"))?;
                anyhow::ensure!(
                    report["run_id"].as_str() == Some(&old.id),
                    "A newer report request exists"
                );
                report["run_id"] = serde_json::json!(new.id);
                crate::store::put(tx, "terminal_report", report_id, &report)?;
            }
            Ok(new)
        })
        .await?;
    Ok(Redirect::to(&format!("/runs/{}", new.id)))
}

async fn run_title(app: &App, job: &Job) -> anyhow::Result<String> {
    let kind = match job.kind.as_str() {
        "terminal.profile" => "Automatic Profile Research",
        "terminal.report" => "Terminal Research Report",
        "terminal.company_research" => "Company Research",
        "terminal.person_research" => "Person Research",
        "terminal.company_continue" => "Continue Company Research",
        "terminal.person_continue" => "Continue Person Research",
        "meetings.debrief" => "Meeting Debrief",
        "meetings.brief" => "Meeting Brief",
        "content.watch" => "Content Research",
        _ => return run_title_with_label(app, job, &web::display_label(&job.kind)).await,
    };
    run_title_with_label(app, job, kind).await
}
async fn run_title_with_label(app: &App, job: &Job, label: &str) -> anyhow::Result<String> {
    for path in [
        "/company/name",
        "/person/name",
        "/meeting/title",
        "/watch/name",
        "/task/title",
        "/revision/subject",
    ] {
        if let Some(target) = job
            .input
            .pointer(path)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Ok(format!("{label} — {target}"));
        }
    }
    for (field, name) in [("watches", "name"), ("channels", "title")] {
        if let Some(items) = job.input[field].as_array() {
            let names = items
                .iter()
                .filter_map(|v| v[name].as_str())
                .take(3)
                .collect::<Vec<_>>();
            if !names.is_empty() {
                return Ok(format!(
                    "{label} — {}{}",
                    names.join(", "),
                    if items.len() > 3 { "…" } else { "" }
                ));
            }
        }
    }
    for (field, kind, name) in [
        ("person_id", "person", "name"),
        ("company_id", "company", "name"),
        ("meeting_id", "meeting", "title"),
        ("project_id", "content.project", "subject"),
        ("task_id", "task", "title"),
    ] {
        if let Some(id) = job.input[field].as_str()
            && let Some(record) = app.db.get::<Value>(kind, id).await?
        {
            let target = record[name]
                .as_str()
                .or_else(|| record["revisions"].as_array()?.last()?[name].as_str());
            if let Some(target) = target {
                return Ok(format!("{label} — {target}"));
            }
        }
    }
    if let Some(name) = job
        .result
        .as_ref()
        .and_then(|r| r.get("target_label"))
        .and_then(Value::as_str)
    {
        return Ok(format!("{label} — {name}"));
    }
    Ok(label.to_owned())
}
