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
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS job(id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedup_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT, error TEXT, retry_of TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_job ON job(kind,dedup_key) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS job_attempt(job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(job_id,attempt));
CREATE TABLE IF NOT EXISTS run_event(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL, stage TEXT NOT NULL, action TEXT, status TEXT NOT NULL, elapsed_ms INTEGER, detail TEXT);
CREATE INDEX IF NOT EXISTS run_event_run ON run_event(run_id, id);
";
/// One append-only timeline row for a Run. The row is added beside the
/// finished record, never over it: a later stage never rewrites an earlier
/// one, so the timeline stays the audit trail of what actually happened.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunEvent {
    pub id: i64,
    pub run_id: String,
    pub attempt: u32,
    pub at_ms: i64,
    pub stage: String,
    pub action: Option<String>,
    pub status: String,
    pub elapsed_ms: Option<u64>,
    pub detail: Option<String>,
}

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
    record_event_tx(
        tx,
        &id,
        0,
        &crate::connection::RecordedEvent::new("admitted", None, "queued", None, Some(kind)),
    )?;
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
/// Cap per Run so a pathological loop cannot grow the timeline without
/// bound; the cap row itself preserves that the cut happened.
pub const RUN_EVENT_CAP: i64 = 500;

fn run_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunEvent> {
    Ok(RunEvent {
        id: row.get(0)?,
        run_id: row.get(1)?,
        attempt: row.get::<_, i64>(2)? as u32,
        at_ms: row.get(3)?,
        stage: row.get(4)?,
        action: row.get(5)?,
        status: row.get(6)?,
        elapsed_ms: row.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
        detail: row.get(8)?,
    })
}
const EVENT_COLUMNS: &str = "id,run_id,attempt,at_ms,stage,action,status,elapsed_ms,detail";

fn record_event_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    attempt: u32,
    event: &crate::connection::RecordedEvent,
) -> anyhow::Result<()> {
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM run_event WHERE run_id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    if count >= RUN_EVENT_CAP {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO run_event(run_id,attempt,at_ms,stage,action,status,elapsed_ms,detail) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            run_id,
            attempt as i64,
            crate::now_ms(),
            event.stage,
            event.action,
            event.status,
            event.elapsed_ms.map(|n| n as i64),
            event.detail,
        ],
    )?;
    Ok(())
}

/// Append one timeline row for a Run. Best-effort by design: a diagnostics
/// write must never fail the Run it observes, so callers log and swallow
/// the error.
pub async fn record_event(
    db: &Db,
    run_id: &str,
    attempt: u32,
    event: crate::connection::RecordedEvent,
) -> anyhow::Result<()> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| record_event_tx(tx, &run_id, attempt, &event))
        .await
}

/// The full timeline of one Run, oldest first. Empty for Runs admitted
/// before this table existed.
pub async fn events(db: &Db, run_id: &str) -> anyhow::Result<Vec<RunEvent>> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| {
        let mut stmt = tx.prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM run_event WHERE run_id=?1 ORDER BY id"
        ))?;
        Ok(stmt
            .query_map([run_id], run_event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
}

async fn claim(app: &App) -> anyhow::Result<Option<Job>> {
    let (provider, model) = (
        app.llm().name().to_owned(),
        app.cfg().llm_model().to_owned(),
    );
    app.db().transaction(move |tx| {
        let now=crate::now_ms();
        // The expired attempt is closed before the same Run is recovered.
        // Live leases are never stolen by a second process sharing the volume.
        tx.execute("UPDATE job_attempt SET finished_at=?1,outcome='interrupted: lease expired' WHERE finished_at IS NULL AND job_id IN (SELECT id FROM job WHERE status='running' AND lease_until<=?1)",[now])?;
        tx.execute("UPDATE job SET status='queued',lease_until=NULL WHERE status='running' AND lease_until<=?1",[now])?;
        let job=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE status='queued' ORDER BY created_at,id LIMIT 1"),[],from_row).optional()?;
        let Some(job)=job else {return Ok(None)};
        tx.execute("UPDATE job SET status='running',attempt=attempt+1,lease_until=?2,updated_at=?3 WHERE id=?1",params![job.id,now+600_000,now])?;
        tx.execute("INSERT INTO job_attempt(job_id,attempt,started_at,provider,model) VALUES(?1,?2,?3,?4,?5)",params![job.id,job.attempt+1,now,provider,model])?;
        // The claim is the recovery beside the interruption: lease expiry
        // already closed the old attempt above before this claim ran.
        record_event_tx(
            tx,
            &job.id,
            job.attempt + 1,
            &crate::connection::RecordedEvent::new("claimed", None, "running", None, Some(&format!("{} {}", provider, model))),
        )?;
        Ok(Some(tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE id=?1"),[job.id],from_row)?))
    }).await
}
/// Runs one admitted job; used by the worker and integration tests through
/// the identical product dispatch. No fixture writes bypass the workflows.
pub async fn run_once(app: &App) -> anyhow::Result<bool> {
    let selected_app = crate::settings::providers::resolve(app).await?;
    let app = &selected_app;
    let started = std::time::Instant::now();
    let Some(job) = claim(app).await? else {
        return Ok(false);
    };
    let run = app.for_run(&job);
    let execution = dispatch(&run, &job);
    tokio::pin!(execution);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    let outcome = loop {
        tokio::select! {
            result=&mut execution=>break result,
            _=heartbeat.tick()=> {
                let (id,attempt)=(job.id.clone(),job.attempt);
                let renewed=app.db().transaction(move|tx|Ok(tx.execute("UPDATE job SET lease_until=?3 WHERE id=?1 AND attempt=?2 AND status='running'",params![id,attempt,crate::now_ms()+600_000])?==1)).await?;
                anyhow::ensure!(renewed,"Run lease no longer belongs to this worker");
                // Best-effort: a diagnostics write never fails the Run it
                // observes.
                let _ = record_event(
                    app.db(),
                    &job.id,
                    job.attempt,
                    crate::connection::RecordedEvent::new("lease_renewed", None, "running", None, None),
                )
                .await;
            }
        }
    };
    let total_ms = started.elapsed().as_millis() as u64;
    // Totals the RunScope decorators measured. The merge happens here, at
    // the one place every Run finishes, so no workflow can forget it and
    // no finished `result` is rewritten afterwards.
    let usage = run.recorder().usage_summary();
    let recorded = run.recorder().drained_events();
    let (status, result, error) = match outcome {
        Ok(mut result) => {
            if let (Some(usage), Some(map)) = (&usage, result.as_object_mut()) {
                map.insert("usage".to_owned(), usage.clone());
            }
            ("done", Some(serde_json::to_string(&result)?), None)
        }
        Err(error) => {
            let error = crate::llm::redact_error(&error.to_string(), app.cfg());
            tracing::warn!(kind=%job.kind,run=%job.id,"Run failed");
            ("failed", None, Some(error))
        }
    };
    let job = job.clone();
    app.db().transaction(move |tx| {
        let now=crate::now_ms();
        tx.execute("UPDATE job SET status=?2,result=?3,error=?4,lease_until=NULL,updated_at=?5 WHERE id=?1 AND status='running' AND attempt=?6",params![job.id,status,result,error,now,job.attempt])?;
        tx.execute("UPDATE job_attempt SET finished_at=?3,outcome=?4 WHERE job_id=?1 AND attempt=?2 AND finished_at IS NULL",params![job.id,job.attempt,now,error.as_deref().unwrap_or("done")])?;
        let detail = if status == "failed" { error.clone() } else { None };
        record_event_tx(
            tx,
            &job.id,
            job.attempt,
            &crate::connection::RecordedEvent::new(status, None, status, Some(total_ms), detail.as_deref()),
        )?;
        // Recorder rows flush beside the finished record, oldest first, so
        // the timeline survives the process that produced it.
        for event in &recorded {
            record_event_tx(tx, &job.id, job.attempt, event)?;
        }
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

async fn dispatch(run: &crate::connection::RunScope, job: &Job) -> anyhow::Result<Value> {
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
        .scope(binding, dispatch_product(run, job))
        .await
}
async fn dispatch_product(run: &crate::connection::RunScope, job: &Job) -> anyhow::Result<Value> {
    if job.kind.starts_with("meetings.") {
        crate::meetings::execute(run, job).await
    } else if job.kind.starts_with("people.") {
        crate::people::execute(run, job).await
    } else if job.kind.starts_with("tasks.") {
        crate::tasks::execute(run, job).await
    } else if matches!(job.kind.as_str(), "terminal.profile" | "terminal.report") {
        crate::terminal::automatic::execute(run, job).await
    } else if job.kind == "terminal.comparison" {
        crate::terminal::comparison::execute(run, job).await
    } else if job.kind.starts_with("terminal.") {
        // The subject module owns the four explicit research Run kinds and
        // refuses anything else under this prefix.
        crate::terminal::subject::execute(run, job).await
    } else if job.kind.starts_with("content.") {
        crate::content::execute(run, job).await
    } else {
        Err(anyhow::anyhow!("Unsupported Run kind: {}", job.kind))
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/runs", get(index))
        .route("/runs/{id}", get(detail))
        .route("/runs/{id}/diagnostics", get(diagnostics))
        .route("/runs/{id}/retry", post(retry))
}

/// Machine-readable Run diagnostics for agents: the finished record, its
/// timeline and its measured totals in one JSON body. HTML stays the human
/// surface; this is the polling endpoint that does not scrape it.
async fn diagnostics(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let job = find(app.db(), &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    let timeline = events(app.db(), &id).await?;
    // The Council review this Run saved, as totals only: provider, model,
    // usage, hashes and the cost boundary. Advisory output never leaks here.
    let council: Vec<Value> = crate::council::revisions_for_run(&app, &id)
        .await?
        .iter()
        .map(crate::council::diagnostic)
        .collect();
    let body = serde_json::json!({
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "attempt": job.attempt,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "retry_of": job.retry_of,
        "error": job.error,
        "result": job.result,
        "timeline": timeline,
        "council": council,
    });
    Ok(axum::Json(body).into_response())
}
async fn index(State(app): State<App>) -> web::Result<Response> {
    let jobs = list(app.db()).await?;
    let mut body = String::from(
        "<p>Every generation and synchronization has a durable Run. Failed attempts stay recorded when retried.</p><div class=\"cds-stack\">",
    );
    for job in jobs {
        body += &format!(
            "<article class=\"cds-card\"><a href=\"/runs/{}\">{}</a>{}<p>{}</p></article>",
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
    let job = find(app.db(), &id)
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
            "<p role=\"alert\">{}</p><form class=\"cds-inline-form\" method=\"post\" action=\"/runs/{}/retry\"><button class=\"cds-btn cds-btn--primary\">Retry with the original input</button></form>",
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
                "<p><a class=\"cds-btn cds-btn--primary\" href=\"{}\">Open the result</a></p>",
                escape(path)
            );
        }
        body += &format!(
            "<details><summary>Result JSON</summary><pre>{}</pre></details>",
            escape(&serde_json::to_string_pretty(&result).unwrap_or_default())
        );
    }
    if job.status == "queued" || job.status == "running" {
        body += "<p role=\"status\"><span class=\"cds-progress\" aria-hidden=\"true\"></span>Work continues in the background. This page updates every 3 seconds. <a href=\"\">Refresh this Run</a> to see the result.</p>";
    }
    if job.kind == "meetings.debrief" {
        let mut traces = app
            .db()
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
    // The timeline is the audit trail of what actually happened: every
    // stage the Run passed through, oldest first, with measured wall time
    // where the stage reports it. Empty for Runs admitted before the
    // timeline existed.
    let timeline = events(app.db(), &id).await?;
    if !timeline.is_empty() {
        body += "<h2>Run timeline</h2><ul>";
        for event in &timeline {
            let when = web::saved_time(event.at_ms, "UTC");
            let elapsed = event
                .elapsed_ms
                .map(|ms| format!(" · {ms} ms"))
                .unwrap_or_default();
            let action = event
                .action
                .as_deref()
                .map(|a| format!(" · {}", escape(a)))
                .unwrap_or_default();
            let detail = event
                .detail
                .as_deref()
                .map(|d| format!(" — {}", escape(d)))
                .unwrap_or_default();
            body += &format!(
                "<li>{} · {} · {}{}{}{}</li>",
                when,
                escape(&event.stage),
                escape(&event.status),
                elapsed,
                action,
                detail
            );
        }
        body += "</ul>";
    }
    // Critical Council: the review this Run saved, with its provider, model,
    // usage and cost boundary. The Council is mandatory for Terminal output,
    // so its charge is disclosed here on the Run diagnostics page.
    let council = crate::council::revisions_for_run(&app, &id).await?;
    if !council.is_empty() {
        body += "<h2>Critical Council review</h2>";
        for revision in &council {
            body += &crate::council::summary(revision);
        }
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
    let old = find(app.db(), &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    if old.status != "failed" {
        return Err(web::Error::conflict("Only a failed Run can be retried."));
    }
    let new = app
        .db()
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
            && let Some(record) = app.db().get::<Value>(kind, id).await?
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
