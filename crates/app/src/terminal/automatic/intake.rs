use super::*;
use crate::{
    store,
    web::{Error, Result, required},
    work,
};
use axum::{
    extract::{Form, Path, State},
    response::Redirect,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Default, Deserialize)]
pub struct IntakeForm {
    #[serde(flatten)]
    pub identity: Identity,
    #[serde(default)]
    pub target_id: String,
    #[serde(default)]
    pub version: Option<u64>,
    #[serde(default)]
    pub supersedes: String,
}

pub(crate) fn validate(identity: &mut Identity) -> Result<()> {
    if !["person", "company"].contains(&identity.kind.as_str()) {
        return Err(Error::bad_request("Choose a person or company."));
    }
    identity.name = required(&identity.name, "Name", 200)?;
    for field in [
        &mut identity.role,
        &mut identity.company,
        &mut identity.jurisdiction,
    ] {
        *field = field.trim().to_owned();
        if field.len() > 200 {
            return Err(Error::bad_request("Identity detail is too long."));
        }
    }
    identity.email = identity.email.trim().to_lowercase();
    identity.phone = identity.phone.trim().to_owned();
    if identity.phone.len() > 100
        || identity.email.len() > 254
        || (!identity.email.is_empty()
            && (!identity.email.contains('@') || identity.email.contains(char::is_whitespace)))
    {
        return Err(Error::bad_request("Invalid email or phone number."));
    }
    for field in [&mut identity.website, &mut identity.linkedin] {
        *field = field.trim().to_owned();
        if !field.is_empty() {
            let url = url::Url::parse(field)
                .map_err(|_| Error::bad_request("Use an absolute HTTPS URL."))?;
            if field.len() > 4000
                || url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(Error::bad_request(
                    "Use an absolute HTTPS URL without credentials.",
                ));
            }
            *field = url.to_string();
        }
    }
    Ok(())
}

pub(crate) fn admit(
    tx: &rusqlite::Transaction<'_>,
    identity: Identity,
    target_id: Option<String>,
    expected_version: Option<u64>,
) -> anyhow::Result<Request> {
    let key = target_id
        .as_ref()
        .map(|id| subject_key(&identity.kind, id))
        .unwrap_or_else(|| {
            crate::research::content_hash(
                serde_json::to_string(&identity)
                    .unwrap_or_default()
                    .as_bytes(),
            )
        });
    let active = store::list::<Request>(tx, "terminal_request")?
        .into_iter()
        .find(|r| {
            r.identity.kind == identity.kind
                && r.target_id == target_id
                && (target_id.is_some()
                    || serde_json::to_value(&r.identity).ok()
                        == serde_json::to_value(&identity).ok())
                && r.status == "researching"
        });
    if let Some(request) = active {
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM job WHERE id=?1",
                [&request.run_id],
                |r| r.get(0),
            )
            .ok();
        anyhow::ensure!(
            !matches!(status.as_deref(), Some("queued" | "running")),
            "Research is already in progress for this subject."
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let run = work::enqueue_tx(tx, "terminal.profile", &key, json!({"request_id":id}))?;
    // The queue key represents the original inputs, while research may enrich
    // Request.identity. Never attach a new request to another request's job.
    anyhow::ensure!(
        run.input["request_id"].as_str() == Some(id.as_str()),
        "Research is already in progress for this subject."
    );
    let request = Request {
        id,
        identity,
        target_id,
        expected_version,
        status: "researching".into(),
        phase: "Queued for identity research".into(),
        choices: vec![],
        sources: vec![],
        selected: None,
        run_id: run.id,
        created_at: crate::now_ms(),
    };
    store::put(tx, "terminal_request", &request.id, &request)?;
    Ok(request)
}

pub async fn submit(State(app): State<App>, Form(mut form): Form<IntakeForm>) -> Result<Redirect> {
    validate(&mut form.identity)?;
    let target = (!form.target_id.is_empty()).then_some(form.target_id);
    if let Some(id) = &target {
        let (_, identity, version) = identities(&app, &form.identity.kind)
            .await?
            .into_iter()
            .find(|(existing, _, _)| existing == id)
            .ok_or_else(|| Error::not_found("Profile not found."))?;
        if identity.name != form.identity.name || Some(version) != form.version {
            return Err(Error::conflict(
                "Profile changed or name was edited. Reload the update form.",
            ));
        }
    }
    let request = app
        .db
        .transaction(move |tx| {
            let new = admit(tx, form.identity, target, form.version)?;
            if !form.supersedes.is_empty() {
                let mut old: Request = store::get(tx, "terminal_request", &form.supersedes)?
                    .ok_or_else(|| anyhow::anyhow!("Request missing"))?;
                anyhow::ensure!(
                    old.status == "needs-clarification",
                    "Request is no longer awaiting clarification"
                );
                old.status = "superseded".into();
                store::put(tx, "terminal_request", &old.id, &old)?;
            }
            Ok(new)
        })
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!("/terminal#request-{}", request.id)))
}

pub async fn refresh(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
) -> Result<Redirect> {
    let (_, identity, version) = identities(&app, &kind)
        .await?
        .into_iter()
        .find(|(existing, _, _)| existing == &id)
        .ok_or_else(|| Error::not_found("Profile not found."))?;
    let request = app
        .db
        .transaction(move |tx| admit(tx, identity, Some(id), Some(version)))
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!("/terminal#request-{}", request.id)))
}

#[derive(Deserialize)]
pub struct ResolutionForm {
    pub choice: usize,
}

pub async fn resolve(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<ResolutionForm>,
) -> Result<Redirect> {
    app.db
        .transaction(move |tx| {
            let mut request: Request = store::get(tx, "terminal_request", &id)?
                .ok_or_else(|| anyhow::anyhow!("Request missing"))?;
            anyhow::ensure!(
                request.status == "needs-clarification",
                "This request no longer needs clarification"
            );
            let choice = request
                .choices
                .get(form.choice)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Choose an available identity"))?;
            // Updating an existing person never silently changes the selected identity.
            anyhow::ensure!(
                request.target_id.is_none() || request.target_id == choice.existing_id,
                "This choice is a different person. Create a separate profile from the homepage."
            );
            validate(&mut choice.identity.clone())
                .map_err(|e| anyhow::anyhow!("Invalid identity choice: {e:?}"))?;
            request.identity = choice.identity.clone();
            if request.target_id.is_none() {
                request.target_id = choice.existing_id.clone();
            }
            if let Some(target) = &request.target_id {
                let kind = if request.identity.kind == "person" {
                    "person"
                } else {
                    "company"
                };
                let record: Value = store::get(tx, kind, target)?
                    .ok_or_else(|| anyhow::anyhow!("Profile no longer exists"))?;
                request.expected_version = record["version"].as_u64();
            }
            request.selected = Some(choice);
            store::purge(tx, "terminal_collection", &request.id)?;
            request.sources.clear();
            request.status = "researching".into();
            request.phase = "Identity selected; researching".into();
            let run = work::enqueue_tx(
                tx,
                "terminal.profile",
                &format!("resolve:{}:{}", request.id, form.choice),
                json!({"request_id":request.id}),
            )?;
            request.run_id = run.id;
            store::put(tx, "terminal_request", &id, &request)
        })
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to("/terminal"))
}

#[derive(Deserialize)]
pub struct CandidateForm {
    pub action: String,
}

pub async fn candidate_action(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<CandidateForm>,
) -> Result<Redirect> {
    app.db
        .transaction(move |tx| {
            let mut candidate: Candidate = store::get(tx, "terminal_candidate", &id)?
                .ok_or_else(|| anyhow::anyhow!("Candidate not found"))?;
            match form.action.as_str() {
                "dismiss" => candidate.dismissed = true,
                "research" => {
                    anyhow::ensure!(!candidate.dismissed, "Candidate was dismissed");
                    if let Some(request_id) = &candidate.request_id
                        && let Some(request) =
                            store::get::<Request>(tx, "terminal_request", request_id)?
                    {
                        anyhow::ensure!(
                            request.status != "researching" && request.status != "complete",
                            "Candidate research already started. Open its progress or profile."
                        );
                    }
                    let request = admit(tx, candidate.identity.clone(), None, None)?;
                    candidate.request_id = Some(request.id);
                }
                _ => anyhow::bail!("Unknown candidate action"),
            }
            store::put(tx, "terminal_candidate", &id, &candidate)
        })
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to("/terminal#candidates"))
}
