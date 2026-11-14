use super::{
    queue::{Job, enqueue_tx, events, find, list},
    usage,
};
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
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

pub fn router() -> Router<App> {
    Router::new()
        .route("/runs", get(index))
        .route("/runs/{id}", get(detail))
        .route("/runs/{id}/diagnostics", get(diagnostics))
        .route("/runs/{id}/retry", post(retry))
}

#[derive(Serialize)]
struct Attempt {
    attempt: u32,
    started_at: i64,
    finished_at: Option<i64>,
    outcome: Option<String>,
    provider: String,
    model: String,
}

async fn attempts(db: &Db, run_id: &str) -> anyhow::Result<Vec<Attempt>> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| {
        let mut stmt = tx.prepare("SELECT attempt,started_at,finished_at,outcome,provider,model FROM job_attempt WHERE job_id=?1 ORDER BY attempt")?;
        Ok(stmt.query_map([run_id], |row| Ok(Attempt {
            attempt: row.get(0)?, started_at: row.get(1)?, finished_at: row.get(2)?,
            outcome: row.get(3)?, provider: row.get(4)?, model: row.get(5)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await
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
    let usage = usage::for_run(app.db(), &job).await?;
    // Truncation has two independent evidence paths: the stored marker, and
    // the recorder's dropped-event counter inside the saved usage. A timeline
    // that lost rows before it could reach the store must not look complete.
    let timeline_truncated = timeline
        .iter()
        .any(|event| event.stage == "diagnostics_truncated")
        || usage::dropped_events(&usage) > 0;
    let retried_by = {
        let run_id = id.clone();
        app.db()
            .transaction(move |tx| {
                let mut stmt =
                    tx.prepare("SELECT id FROM job WHERE retry_of=?1 ORDER BY created_at, id")?;
                Ok(stmt
                    .query_map([run_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await?
    };
    let body = serde_json::json!({
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "attempt": job.attempt,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "retry_of": job.retry_of,
        "retried_by": retried_by,
        "error": job.error,
        "result": job.result,
        "timeline": timeline,
        "timeline_truncated": timeline_truncated,
        "attempts": attempts(app.db(), &id).await?,
        "council": council,
        "usage": usage,
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
    let history = attempts(app.db(), &id).await?;
    if !history.is_empty() {
        body += &format!(
            "<details><summary>Attempt history</summary><pre>{}</pre></details>",
            escape(&serde_json::to_string_pretty(&history).map_err(anyhow::Error::from)?)
        );
    }
    if let Some(usage) = usage::for_run(app.db(), &job).await? {
        body += "<h2>Generation usage</h2>";
        let unmeasured = usage["llm_unmeasured_calls"].as_u64().unwrap_or_default();
        let cost = usage["llm_cost_usd"]
            .as_f64()
            .map(|cost| format!("Provider-reported cost: ${cost:.6}"))
            .unwrap_or_else(|| "Cost unavailable: not reported for every call".into());
        body += &format!(
            "<p>{} generation requests · {} measured input and {} measured output tokens · {}.</p>",
            usage["llm_calls"], usage["llm_input_tokens"], usage["llm_output_tokens"], cost
        );
        if unmeasured > 0 {
            body += &format!(
                "<p>{unmeasured} requests have unmeasured tokens. Unmeasured token counts are excluded; actual usage may be higher.</p>"
            );
        }
        if let Some(attempts) = usage["unrecorded_attempts"]
            .as_array()
            .filter(|attempts| !attempts.is_empty())
        {
            body += &format!(
                "<p>Usage unavailable for {} attempts. Measured totals exclude those attempts and may understate actual usage.</p>",
                attempts.len()
            );
        }
        body += &format!(
            "<details><summary>Per-call generation measurements</summary><pre>{}</pre></details>",
            escape(
                &serde_json::to_string_pretty(&usage["generation_calls"])
                    .map_err(anyhow::Error::from)?
            )
        );
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
    // A manual retry is also a web request: its correlation id lands on the
    // new Run's admission row.
    let correlation = crate::correlation::current();
    let new = app
        .db()
        .transaction(move |tx| {
            let new = enqueue_tx(
                tx,
                &old.kind,
                &old.key,
                old.input.clone(),
                correlation.as_deref(),
            )?;
            tx.execute(
                "UPDATE job SET retry_of=?2 WHERE id=?1 AND retry_of IS NULL",
                params![new.id, old.id],
            )?;
            crate::terminal::automatic::rebind_retry(tx, &old, &new.id)?;
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
