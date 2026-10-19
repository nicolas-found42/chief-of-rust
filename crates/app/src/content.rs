//! Content development from attributable evidence, with immutable intent revisions.
use crate::{
    App, store,
    web::{self, escape, required},
    work,
};
use axum::{
    Form, Router,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

mod execution;
mod models;
mod routes;
mod views;
pub use execution::{enqueue_scheduled, execute};
pub use models::*;
pub use routes::router;

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn uuid_path(value: &str) -> web::Result<()> {
    Uuid::parse_str(value).map_err(|_| web::Error::not_found("Record not found."))?;
    Ok(())
}

fn public_url(value: &str) -> web::Result<String> {
    let url = url::Url::parse(value.trim())
        .map_err(|_| web::Error::bad_request("Enter an absolute public HTTPS URL."))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(web::Error::bad_request(
            "Enter a public HTTP or HTTPS URL without credentials.",
        ));
    }
    Ok(url.to_string())
}

fn conflict_result<T>(result: anyhow::Result<T>) -> web::Result<T> {
    result.map_err(|e| {
        if e.to_string().contains("stale") || e.to_string().contains("already") {
            web::Error::conflict(e.to_string())
        } else {
            e.into()
        }
    })
}

async fn load_project(app: &App, id: &str) -> web::Result<Project> {
    uuid_path(id)?;
    app.db()
        .get("content.project", id)
        .await?
        .ok_or_else(|| web::Error::not_found("Project not found."))
}

fn latest<'a>(revision: &'a Revision, stage: &str) -> Option<&'a Artifact> {
    revision.artifacts.iter().rev().find(|a| a.stage == stage)
}

fn draft_current(r: &Revision, draft: &Artifact) -> bool {
    latest(r, "outline").is_some_and(|o| {
        o.approved_at.is_some() && draft.outline_id.as_deref() == Some(o.id.as_str())
    })
}

fn evidence_size(evidence: &[Evidence]) -> usize {
    evidence.iter().map(|e| e.text.chars().count()).sum()
}

fn new_revision(previous: &Revision) -> Revision {
    let mut r = previous.clone();
    r.number += 1;
    r.evidence_reviewed = false;
    r.brand = None;
    r.artifacts.clear();
    r.created_at = now();
    r
}

fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0)
}

fn observed_total(data: &Value) -> u64 {
    if let Some(total) = data.get("view_count").filter(|v| !v.is_null()) {
        return count(Some(total));
    }
    data.get("videos")
        .and_then(Value::as_array)
        .map_or(0, |videos| {
            videos.iter().map(|v| count(v.get("views"))).sum()
        })
}

fn delta(rows: &[&Observation], days: i64) -> Option<i128> {
    let last = rows.last()?;
    let cutoff = chrono::DateTime::parse_from_rfc3339(&last.measured_at).ok()?
        - chrono::Duration::days(days);
    let baseline = rows.iter().rev().find(|o| {
        chrono::DateTime::parse_from_rfc3339(&o.measured_at).is_ok_and(|t| t <= cutoff)
    })?;
    let channel_count = |o: &Observation| o.data.get("view_count").is_some_and(|v| !v.is_null());
    if channel_count(last) != channel_count(baseline) {
        return None;
    }
    if !channel_count(last) {
        let video_ids = |o: &Observation| -> std::collections::BTreeSet<String> {
            o.data
                .get("videos")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        };
        if video_ids(last) != video_ids(baseline) {
            return None;
        }
    }
    Some(i128::from(observed_total(&last.data)) - i128::from(observed_total(&baseline.data)))
}
