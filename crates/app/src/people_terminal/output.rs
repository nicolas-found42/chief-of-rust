use super::{
    corpus::{Scope, context},
    enabled, key,
    views::{all_context, ensure_worker, selector, workspace},
    watch::job_status,
};
use crate::{
    App,
    people::Person,
    store,
    web::{self, Error, Result, escape, required},
    work,
};
use axum::{
    extract::{Form, Path, Query, State},
    response::{IntoResponse, Redirect, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, fmt::Write};

const KIND: &str = "people_terminal_output";
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Brief,
    Report,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Brief => "Person Brief",
            Self::Report => "Research Report",
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Selection {
    id: String,
    snapshot: Option<String>,
    revision: u64,
}
#[derive(Serialize, Deserialize)]
struct Artifact {
    id: String,
    kind: Kind,
    question: String,
    person_ids: Vec<String>,
    selection: Vec<Selection>,
    scope: Scope,
    run: String,
    created: i64,
    manifest: Option<String>,
    selected: Vec<String>,
    generator: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct Prefill {
    person: String,
}
pub(crate) async fn index(
    State(app): State<App>,
    Query(query): Query<Prefill>,
) -> Result<Response> {
    enabled(&app)?;
    let people = app.db().list::<Person>("person").await?;
    let outputs = app.db().list::<Artifact>(KIND).await?;
    let mut out = format!(
        "<form method=\"post\" class=\"cds-form\"><label>Output <select name=\"kind\"><option value=\"brief\">Person Brief</option><option value=\"report\">Research Report</option></select></label>{}{}{}{}{}<button class=\"cds-btn cds-btn--primary\">Create from retained evidence</button></form><h2>Saved research</h2><ul>",
        selector(&people, "Person", "person", &query.person),
        selector(&people, "Second person for Report (optional)", "second", ""),
        selector(&people, "Third person for Report (optional)", "third", ""),
        web::field(
            "Independent research question (Report)",
            "question",
            "",
            "text",
            Some(1000),
            false
        ),
        super::views::date_scope(&Scope::default())
    );
    for artifact in outputs.iter().take(50) {
        let _ = write!(
            out,
            "<li><a href=\"/terminal/people/outputs/{}\">{}</a></li>",
            escape(&artifact.id),
            artifact.kind.name()
        );
    }
    out.push_str("</ul>");
    Ok(workspace("Briefs and Reports", out))
}

#[derive(Deserialize)]
pub(crate) struct Request {
    kind: Kind,
    question: String,
    person: String,
    second: String,
    third: String,
    #[serde(flatten)]
    scope: Scope,
}
pub(crate) async fn request(State(app): State<App>, Form(form): Form<Request>) -> Result<Redirect> {
    enabled(&app)?;
    let scope = form.scope.validate()?;
    let question = if form.kind == Kind::Report {
        required(&form.question, "Independent research question", 1000)?
    } else {
        String::new()
    };
    if !question.is_empty() {
        super::verify_independent_input(&app, &question).await?;
    }
    let mut seen = BTreeSet::new();
    let person_ids = [form.person, form.second, form.third]
        .into_iter()
        .filter(|p| !p.is_empty() && seen.insert(p.clone()))
        .collect::<Vec<_>>();
    if person_ids.is_empty() || (form.kind == Kind::Brief && person_ids.len() != 1) {
        return Err(Error::bad_request(
            "A Brief needs one person; a Report can include one to three people.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let artifact_id = id.clone();
    let correlation = crate::correlation::current();
    app.db()
        .transaction(move |tx| {
            let mut selection = Vec::new();
            for id in &person_ids {
                let c = context(tx, id, &scope)?
                    .ok_or_else(|| anyhow::anyhow!("Person or selected revision unavailable"))?;
                selection.push(Selection {
                    id: id.clone(),
                    revision: c.revision,
                    snapshot: c.snapshot,
                });
            }
            let run = work::enqueue_tx(
                tx,
                "people.terminal_output",
                &artifact_id,
                json!({"artifact_id":artifact_id,"person_ids":person_ids}),
                correlation.as_deref(),
                None,
            )?;
            let artifact = Artifact {
                id: artifact_id,
                kind: form.kind,
                question,
                person_ids,
                selection,
                scope,
                run: run.id,
                created: crate::now_ms(),
                manifest: None,
                selected: Vec::new(),
                generator: None,
            };
            store::put(tx, KIND, &artifact.id, &artifact)
        })
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!("/terminal/people/outputs/{id}")))
}

type Rows = Vec<(String, String, String, super::corpus::Fact)>;
fn eligible(tx: &rusqlite::Connection, a: &Artifact, writing: bool) -> anyhow::Result<Rows> {
    let mut out = Vec::new();
    for sel in &a.selection {
        let latest = context(tx, &sel.id, &Scope::default())?
            .ok_or_else(|| anyhow::anyhow!("Person no longer active"))?;
        anyhow::ensure!(
            !writing || latest.revision == sel.revision,
            "Person changed before output publication"
        );
        let Some(snapshot) = &sel.snapshot else {
            continue;
        };
        let scope = Scope {
            snapshot: snapshot.clone(),
            page: 0,
            ..a.scope.clone()
        };
        let c = all_context(tx, &sel.id, &scope)?
            .ok_or_else(|| anyhow::anyhow!("Selected snapshot is no longer available"))?;
        for f in c
            .claims
            .into_iter()
            .filter(|f| {
                f.state() != "Unresolved" && f.review != super::corpus::ReviewState::Rejected
            })
            .take(24)
        {
            out.push((c.person_id.clone(), c.name.clone(), snapshot.clone(), f));
        }
    }
    Ok(out)
}

pub(super) async fn execute(
    app: &crate::connection::RunScope,
    job: &work::Job,
) -> anyhow::Result<Value> {
    let started = std::time::Instant::now();
    let id = job.input["artifact_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Output request missing"))?
        .to_owned();
    let (mut a, rows) = app
        .db()
        .transaction({
            let id = id.clone();
            move |tx| {
                let a: Artifact = store::get(tx, KIND, &id)?
                    .ok_or_else(|| anyhow::anyhow!("Output request removed"))?;
                let rows = eligible(tx, &a, true)?;
                Ok((a, rows))
            }
        })
        .await?;
    if a.manifest.is_some() {
        return Ok(json!({"artifact_id":a.id,"already_saved":true}));
    }
    anyhow::ensure!(a.run == job.id, "Output request was replaced");
    let mut ids = Vec::new();
    if a.kind == Kind::Brief {
        ids.extend(rows.iter().take(8).map(|(_, _, _, f)| f.id.clone()));
    } else if app.judge().available() {
        // Jev can only select from the already assessed corpus. Rendering
        // copies the same fact and both sides of its citations.
        for batch in rows.chunks(8) {
            let candidates=batch.iter().map(|(_,name,_,f)|json!({"person":name,"statement":f.statement,"status":f.state()})).collect::<Vec<_>>();
            let questions=Value::Object((0..batch.len()).map(|i|(format!("relevant_{i}"),json!({
                "type":"noul","instructions":format!("Does candidates[{i}] answer a substantive part of question or directly qualify an answer to it?")
            }))).collect::<Map<_,_>>());
            let answer = app
                .judge()
                .evaluate(
                    json!({"question":a.question,"candidates":candidates}),
                    questions.clone(),
                )
                .await?;
            crate::judgments::validate(&questions, &answer)?;
            for (i, (_, _, _, f)) in batch.iter().enumerate() {
                if crate::judgments::probability(&answer.answers[&format!("relevant_{i}")]["noul"])?
                    >= 0.8
                {
                    ids.push(f.id.clone());
                }
            }
        }
    }
    a.selected = ids.into_iter().take(20).collect();
    a.manifest = Some(key(&manifest(&rows, &a.selected))?);
    a.generator = Some(if a.kind == Kind::Brief {
        "canonical brief v1".into()
    } else {
        format!("passage relevance v1 · {}", app.cfg().jev_model)
    });
    let url = format!("/terminal/people/outputs/{}", a.id);
    let published_id = job.id.clone();
    let attempt = job.attempt;
    let action = match a.kind {
        Kind::Brief => "brief",
        Kind::Report => "report",
    };
    let detail = format!("selected={} candidates={}", a.selected.len(), rows.len());
    app.db()
        .transaction(move |tx| {
            ensure_worker(tx, &published_id, attempt)?;
            let now = eligible(tx, &a, true)?;
            anyhow::ensure!(
                Some(key(&manifest(&now, &a.selected))?) == a.manifest,
                "Research changed while generating; request a new output"
            );
            store::put(tx, KIND, &id, &a)
        })
        .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    app.recorder().record_event(
        "output",
        Some(action),
        "ok",
        Some(elapsed_ms),
        Some(&detail),
    );
    Ok(json!({"url":url}))
}
fn manifest<'a>(
    rows: &'a Rows,
    ids: &[String],
) -> Vec<&'a (String, String, String, super::corpus::Fact)> {
    rows.iter()
        .filter(|(_, _, _, f)| ids.contains(&f.id))
        .collect()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Format {
    format: String,
}
pub(crate) async fn detail(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<Format>,
) -> Result<Response> {
    enabled(&app)?;
    let loaded = app
        .db()
        .transaction(move |tx| {
            let Some(a) = store::get::<Artifact>(tx, KIND, &id)? else {
                return Ok(None);
            };
            let status = job_status(tx, &a.run)?;
            let rows = eligible(tx, &a, false).ok();
            Ok(Some((a, rows, status)))
        })
        .await?;
    let (artifact, rows, status) =
        loaded.ok_or_else(|| Error::not_found("Research output no longer available."))?;
    let title = artifact.kind.name();
    if artifact.manifest.is_none() {
        if !query.format.is_empty() {
            return Err(Error::conflict("Output is not ready for export."));
        }
        let message = match status.as_ref().map(|(status, _)| status.as_str()) {
            Some("failed") => "Generation failed. See the Run for the reason.",
            Some("queued" | "running") => "Generating from the selected research snapshot.",
            _ => "Generation is unavailable.",
        };
        return Ok(workspace(
            title,
            format!(
                "<p>{message}</p><p><a href=\"/runs/{}\">Open Run</a></p>",
                escape(&artifact.run)
            ),
        ));
    }
    let rows = rows.ok_or_else(|| {
        Error::conflict("This output was invalidated by an access or research change.")
    })?;
    let facts = manifest(&rows, &artifact.selected);
    if Some(key(&facts)?) != artifact.manifest {
        return Err(Error::conflict(
            "This output was invalidated by a review or evidence change. Generate a fresh copy.",
        ));
    }
    if query.format == "markdown" {
        let mut md = format!(
            "# {title}\n\n{}\n\nTime scope: {:?} {}\n\n",
            md_text(&artifact.question),
            artifact.scope.mode,
            artifact.scope.date
        );
        if facts.is_empty() {
            md.push_str("Unknown: this scope does not contain a supported answer.\n")
        }
        for (id, name, snapshot, f) in &facts {
            let _ = writeln!(
                md,
                "- {}: {} — {} / {}. Person: `{}`, snapshot: `{}`, claim: `{}`.",
                md_text(name),
                md_text(&f.statement),
                f.state(),
                f.review.label(),
                id,
                snapshot,
                f.id
            );
            for (relation, link) in f
                .supports
                .iter()
                .map(|p| ("Supports", p))
                .chain(f.contradicts.iter().map(|p| ("Contradicts", p)))
            {
                let _ = writeln!(
                    md,
                    "  - {relation}: {} · {} · version `{}` · observed {} · {} · <{}>",
                    md_text(&link.title),
                    md_text(&link.anchor),
                    link.version,
                    md_text(&link.observed),
                    md_text(&link.inspection),
                    link.url.replace('>', "%3E")
                );
            }
        }
        return Ok((
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    "text/markdown; charset=utf-8",
                ),
                (
                    axum::http::header::CONTENT_DISPOSITION,
                    "attachment; filename=people-research.md",
                ),
            ],
            md,
        )
            .into_response());
    } else if !query.format.is_empty() {
        return Err(Error::bad_request("Output format must be markdown."));
    }
    let mut out = format!(
        "<p>{}</p><p>Scope: {:?} {} · Generated using {}</p><p><a href=\"?format=markdown\">Export Markdown</a></p><h2>Findings</h2>",
        escape(&artifact.question),
        artifact.scope.mode,
        escape(&artifact.scope.date),
        escape(artifact.generator.as_deref().unwrap_or_default())
    );
    if facts.is_empty() {
        out.push_str("<p>Unknown: this scope does not contain a supported answer.</p>");
    }
    for (id, name, snapshot, f) in facts {
        let _ = write!(
            out,
            "<article class=\"cds-card\"><p>{}: <a href=\"/terminal/people/{}?view=evidence&amp;snapshot={}&amp;claim={}#inspector\">{}</a></p><p>{} · {}</p></article>",
            escape(name),
            escape(id),
            escape(snapshot),
            escape(&f.id),
            escape(&f.statement),
            f.state(),
            f.review.label()
        );
    }
    out.push_str("<h2>Research gaps</h2><p>Only assessed findings from the saved evidence scope are shown. Unaddressed parts remain Unknown.</p>");
    Ok(workspace(title, out))
}
fn md_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\n', " ")
        .replace('[', "\\[")
        .replace(']', "\\]")
}
