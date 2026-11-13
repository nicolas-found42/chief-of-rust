//! Independent person research. The workspace, artifacts, and Meeting
//! enrichment share the same authorized snapshot selection.

mod corpus;
mod identity;
mod output;
mod views;
mod watch;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Serialize;

use crate::{
    App,
    people::Person,
    web::{Error, Result},
};
pub(crate) use corpus::{
    Context, SourceKind, active_context, apply_revocations, assess, person_has_revocation, purge,
    save, screen_originals, source_kind,
};
pub(crate) use watch::schedule;

pub(crate) fn router() -> Router<App> {
    Router::new()
        .route("/terminal/people/{id}/context", get(context))
        .route("/terminal/people/{id}/identity", post(identity::review))
        .route("/terminal/people/{id}/review", post(views::review))
        .route("/terminal/people/{id}/revoke", post(views::revoke_source))
        .route("/terminal/people/{id}/collection", post(views::collect))
        .route("/terminal/people/research", get(views::search))
        .route(
            "/terminal/people/compare",
            get(views::compare).post(views::save_comparison),
        )
        .route(
            "/terminal/people/compare/{id}",
            get(views::saved_comparison),
        )
        .route(
            "/terminal/people/watchlists",
            get(watch::index).post(watch::save),
        )
        .route(
            "/terminal/people/watchlists/{id}",
            get(watch::detail).post(watch::update),
        )
        .route(
            "/terminal/people/outputs",
            get(output::index).post(output::request),
        )
        .route("/terminal/people/outputs/{id}", get(output::detail))
        .route("/terminal/people/{id}/export", get(views::export))
}

pub(crate) use views::profile;

pub(crate) fn enabled(app: &App) -> Result<()> {
    if app.cfg().people_terminal {
        Ok(())
    } else {
        Err(Error::not_found("People Terminal beta is disabled."))
    }
}

async fn context(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(scope): Query<corpus::Scope>,
) -> Result<Json<Context>> {
    let scope = scope.validate()?;
    app.db()
        .transaction(move |tx| corpus::permitted_context(tx, &id, &scope))
        .await?
        .map(Json)
        .ok_or_else(|| Error::not_found("Active person not found."))
}

pub(crate) async fn execute(
    app: &App,
    job: &crate::work::Job,
) -> anyhow::Result<serde_json::Value> {
    match job.kind.as_str() {
        "people.terminal_output" => output::execute(app, job).await,
        "people.terminal_inspect" => views::execute_collect(app, job).await,
        _ => anyhow::bail!("Unknown People Terminal job"),
    }
}

fn active(person: &Person) -> bool {
    !person.archived && person.merged_into.is_none()
}

fn key(parts: &impl Serialize) -> anyhow::Result<String> {
    Ok(crate::research::content_hash(&serde_json::to_vec(parts)?))
}

/// Pasted prose has no trustworthy origin tag. Beta admissions reject
/// content that the configured judge cannot separate from meeting context.
pub(crate) async fn verify_independent_input(app: &App, text: &str) -> Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    if !app.judge().available() {
        return Err(Error::bad_request(
            "Use independently published sources. Free-text input requires a configured origin check.",
        ));
    }
    let questions = serde_json::json!({
        "meeting_origin":{"type":"noul","instructions":"Does input include, paraphrase, reference, or ask to use a private meeting, transcript, follow-up, or private interaction? An independently published interview or talk does not count."},
        "independent":{"type":"noul","instructions":"Is input clearly an independent professional research question or an annotation about an independently inspectable source, with no dependence on private interaction?"}
    });
    let result = app
        .judge()
        .evaluate(serde_json::json!({"input":text}), questions.clone())
        .await
        .map_err(|_| Error::bad_request("The research origin could not be checked."))?;
    crate::judgments::validate(&questions, &result)
        .map_err(|_| Error::bad_request("The research origin could not be checked."))?;
    let risk = crate::judgments::probability(&result.answers["meeting_origin"]["noul"])?;
    let independent = crate::judgments::probability(&result.answers["independent"]["noul"])?;
    if risk > 0.2 || independent < 0.8 {
        return Err(Error::bad_request(
            "Use an independent research question or an annotation about public evidence.",
        ));
    }
    Ok(())
}

/// A deployment rollback cannot expose legacy views after an evidence revocation.
pub(crate) async fn requires_safe_view(app: &App, id: &str) -> anyhow::Result<bool> {
    if app.cfg().people_terminal {
        return Ok(true);
    }
    let id = id.to_owned();
    app.db()
        .transaction(move |tx| person_has_revocation(tx, &id))
        .await
}
