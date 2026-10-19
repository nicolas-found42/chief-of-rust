//! Validated admissions, human decisions, and atomic content mutations.
use super::execution::enqueue_snapshot;
use super::views;
use super::*;
pub fn router() -> Router<App> {
    Router::new()
        .route("/content-scout", get(home))
        .route("/content-research", get(research_page))
        .route("/content-research/trends", get(youtube_page))
        .route("/content-engine/projects/{id}", get(project_page))
        .route("/content", get(home))
        .route("/content/brand", post(save_brand))
        .route("/content/sources", post(add_source))
        .route("/content/sources/{id}/toggle", post(toggle_source))
        .route("/content/scout", post(scout))
        .route("/content/opportunities/{id}/{decision}", post(decide))
        .route("/content/projects", post(create_project))
        .route("/content/projects/{id}", get(project_page))
        .route("/content/projects/{id}/revise", post(revise_project))
        .route("/content/projects/{id}/evidence", post(attach_evidence))
        .route(
            "/content/projects/{id}/evidence/{evidence}/exclude",
            post(exclude_evidence),
        )
        .route("/content/projects/{id}/review", post(review_evidence))
        .route("/content/projects/{id}/generate/{stage}", post(generate))
        .route("/content/projects/{id}/approve/{artifact}", post(approve))
        .route(
            "/content/projects/{id}/edit/{artifact}",
            post(edit_artifact),
        )
        .route("/content/projects/{id}/export", get(export))
        .route("/research", get(research_page))
        .route("/research/watches", post(add_watch))
        .route("/research/watches/{id}/toggle", post(toggle_watch))
        .route("/research/run", post(watch_run))
        .route("/research/reports/{id}", get(report_page))
        .route("/youtube", get(youtube_page))
        .route("/youtube/channels", post(add_channel))
        .route("/youtube/channels/{id}/toggle", post(toggle_channel))
        .route("/youtube/run", post(trends_run))
}

// Architecture review card 6: page handlers load every record their views
// render, so a page's interface states what it needs and no view reads the
// store behind the handler's back.
async fn home(State(app): State<App>) -> web::Result<Response> {
    let brand = app.db().get::<Brand>("brand", "current").await?;
    let sources = app.db().list::<Source>("content.source").await?;
    let opportunities = app.db().list::<Opportunity>("content.opportunity").await?;
    let projects = app.db().list::<Project>("content.project").await?;
    Ok(views::home(brand, &sources, &opportunities, &projects))
}
async fn project_page(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let project = load_project(&app, &id).await?;
    let has_brand = app.db().get::<Brand>("brand", "current").await?.is_some();
    Ok(views::project_page(&project, has_brand))
}
async fn research_page(State(app): State<App>) -> web::Result<Response> {
    let watches = app.db().list::<Watch>("content.watch").await?;
    let reports = app.db().list::<Report>("content.report").await?;
    Ok(views::research_page(&watches, &reports))
}
async fn report_page(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    uuid_path(&id)?;
    let report = app
        .db()
        .get::<Report>("content.report", &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Report not found."))?;
    Ok(views::report_page(&report))
}
async fn youtube_page(State(app): State<App>) -> web::Result<Response> {
    let channels = app.db().list::<Channel>("content.channel").await?;
    let observations = app.db().list::<Observation>("content.observation").await?;
    Ok(views::youtube_page(&channels, &observations))
}

#[derive(Deserialize)]
struct BrandForm {
    revision: u64,
    name: String,
    audience: String,
    voice: String,
    #[serde(default)]
    boundaries: String,
    #[serde(default)]
    evidence: String,
}
async fn save_brand(State(app): State<App>, Form(form): Form<BrandForm>) -> web::Result<Redirect> {
    let brand = Brand {
        revision: form
            .revision
            .checked_add(1)
            .ok_or_else(|| web::Error::bad_request("Invalid brand revision."))?,
        name: required(&form.name, "Brand name", 200)?,
        audience: required(&form.audience, "Audience", 2000)?,
        voice: required(&form.voice, "Voice", 12000)?,
        boundaries: bounded(&form.boundaries, 12000)?,
        evidence: bounded(&form.evidence, 30000)?,
        updated_at: now(),
    };
    let result = app
        .db()
        .transaction(move |tx| {
            let existing = store::get::<Brand>(tx, "brand", "current")?;
            anyhow::ensure!(
                existing.map_or(0, |b| b.revision) == form.revision,
                "stale brand revision"
            );
            store::put(tx, "brand", "current", &brand)
        })
        .await;
    conflict_result(result)?;
    Ok(Redirect::to("/content"))
}
fn bounded(value: &str, limit: usize) -> web::Result<String> {
    if value.len() > limit {
        return Err(web::Error::bad_request(format!(
            "Text must be at most {limit} bytes."
        )));
    }
    Ok(value.trim().into())
}

#[derive(Deserialize)]
struct SourceForm {
    label: String,
    url: String,
}
async fn add_source(State(app): State<App>, Form(form): Form<SourceForm>) -> web::Result<Redirect> {
    let source = Source {
        id: new_id(),
        label: required(&form.label, "Label", 200)?,
        url: public_url(&form.url)?,
        paused: false,
    };
    app.db()
        .put("content.source", &source.id.clone(), source)
        .await?;
    Ok(Redirect::to("/content"))
}
async fn toggle_source(State(app): State<App>, Path(id): Path<String>) -> web::Result<Redirect> {
    uuid_path(&id)?;
    app.db()
        .transaction(move |tx| {
            let mut s = store::get::<Source>(tx, "content.source", &id)?
                .ok_or_else(|| anyhow::anyhow!("Source not found"))?;
            s.paused = !s.paused;
            store::put(tx, "content.source", &id, &s)
        })
        .await?;
    Ok(Redirect::to("/content"))
}
async fn scout(State(app): State<App>) -> web::Result<Redirect> {
    let job = enqueue_snapshot(&app, "content.scout")
        .await
        .map_err(|e| web::Error::bad_request(e.to_string()))?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}

#[derive(Deserialize)]
struct ProjectForm {
    subject: String,
    objective: String,
    audience: String,
    target: String,
    #[serde(default)]
    material: String,
    #[serde(default)]
    revision: u64,
}

fn validate_project(form: ProjectForm) -> web::Result<Revision> {
    if !TARGETS.contains(&form.target.as_str()) {
        return Err(web::Error::bad_request(
            "Choose a supported publication format.",
        ));
    }
    Ok(Revision {
        number: 1,
        subject: required(&form.subject, "Subject", 1000)?,
        objective: required(&form.objective, "Objective", 3000)?,
        audience: required(&form.audience, "Audience", 3000)?,
        target: form.target,
        material: bounded(&form.material, 30000)?,
        evidence: Vec::new(),
        brand: None,
        evidence_reviewed: false,
        artifacts: Vec::new(),
        created_at: now(),
    })
}
async fn create_project(
    State(app): State<App>,
    Form(form): Form<ProjectForm>,
) -> web::Result<Redirect> {
    let project = Project {
        id: new_id(),
        opportunity_id: None,
        revisions: vec![validate_project(form)?],
        created_at: now(),
    };
    let url = format!("/content/projects/{}", project.id);
    app.db()
        .put("content.project", &project.id.clone(), project)
        .await?;
    Ok(Redirect::to(&url))
}
async fn decide(
    State(app): State<App>,
    Path((opportunity_id, decision)): Path<(String, String)>,
) -> web::Result<Redirect> {
    uuid_path(&opportunity_id)?;
    if !matches!(decision.as_str(), "select" | "skip") {
        return Err(web::Error::bad_request("Choose select or skip."));
    }
    let url = conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut opportunity =
                    store::get::<Opportunity>(tx, "content.opportunity", &opportunity_id)?
                        .ok_or_else(|| anyhow::anyhow!("Opportunity not found"))?;
                if let Some(project_id) = opportunity.project_id {
                    return Ok(format!("/content/projects/{project_id}"));
                }
                anyhow::ensure!(
                    opportunity.state == "shortlisted",
                    "already decided opportunity"
                );
                let url = if decision == "select" {
                    let project = Project {
                        id: new_id(),
                        opportunity_id: Some(opportunity.id.clone()),
                        revisions: vec![Revision {
                            number: 1,
                            subject: opportunity.title.clone(),
                            objective: opportunity.angle.clone(),
                            audience: opportunity.brand.audience.clone(),
                            target: TARGETS[0].into(),
                            material: String::new(),
                            evidence: opportunity.evidence.clone(),
                            brand: Some(opportunity.brand.clone()),
                            evidence_reviewed: false,
                            artifacts: Vec::new(),
                            created_at: now(),
                        }],
                        created_at: now(),
                    };
                    opportunity.project_id = Some(project.id.clone());
                    opportunity.state = "selected".into();
                    store::put(tx, "content.project", &project.id, &project)?;
                    format!("/content/projects/{}", project.id)
                } else {
                    opportunity.state = "skipped".into();
                    "/content".into()
                };
                store::put(tx, "content.opportunity", &opportunity.id, &opportunity)?;
                Ok(url)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}

async fn revise_project(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<ProjectForm>,
) -> web::Result<Redirect> {
    load_project(&app, &id).await?;
    let expected = form.revision;
    let mut revision = validate_project(form)?;
    let url = format!("/content/projects/{id}");
    conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut project = store::get::<Project>(tx, "content.project", &id)?
                    .ok_or_else(|| anyhow::anyhow!("Project not found"))?;
                anyhow::ensure!(
                    project.current().number == expected,
                    "stale project revision; reload before editing"
                );
                revision.number = expected + 1;
                revision.evidence = project.current().evidence.clone();
                project.revisions.push(revision);
                store::put(tx, "content.project", &id, &project)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}
#[derive(Deserialize)]
struct EvidenceForm {
    revision: u64,
    title: String,
    #[serde(default)]
    url: String,
    text: String,
}
async fn attach_evidence(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<EvidenceForm>,
) -> web::Result<Redirect> {
    load_project(&app, &id).await?;
    let evidence = Evidence {
        id: new_id(),
        title: required(&form.title, "Title", 1000)?,
        url: if form.url.trim().is_empty() {
            None
        } else {
            Some(public_url(&form.url)?)
        },
        text: required(&form.text, "Evidence text", 12000)?,
        observed_at: now(),
    };
    let url = format!("/content/projects/{id}");
    conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut project = store::get::<Project>(tx, "content.project", &id)?
                    .ok_or_else(|| anyhow::anyhow!("Project not found"))?;
                anyhow::ensure!(
                    project.current().number == form.revision,
                    "stale project revision; reload before attaching evidence"
                );
                let mut r = new_revision(project.current());
                anyhow::ensure!(r.evidence.len() < 40, "Evidence limit reached (40 items)");
                r.evidence.push(evidence);
                anyhow::ensure!(
                    evidence_size(&r.evidence) <= 160000,
                    "Evidence text limit reached; exclude sources or create a focused project"
                );
                project.revisions.push(r);
                store::put(tx, "content.project", &id, &project)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}
async fn exclude_evidence(
    State(app): State<App>,
    Path((id, evidence_id)): Path<(String, String)>,
    Form(form): Form<RevisionForm>,
) -> web::Result<Redirect> {
    let project = load_project(&app, &id).await?;
    if !project
        .current()
        .evidence
        .iter()
        .any(|e| e.id == evidence_id)
    {
        return Err(web::Error::not_found("Evidence not found."));
    }
    let url = format!("/content/projects/{id}");
    conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut p = store::get::<Project>(tx, "content.project", &id)?
                    .ok_or_else(|| anyhow::anyhow!("Project not found"))?;
                anyhow::ensure!(
                    p.current().number == form.revision,
                    "stale project revision"
                );
                let mut r = new_revision(p.current());
                r.evidence.retain(|e| e.id != evidence_id);
                p.revisions.push(r);
                store::put(tx, "content.project", &id, &p)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}

#[derive(Deserialize)]
struct RevisionForm {
    revision: u64,
}
async fn review_evidence(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<RevisionForm>,
) -> web::Result<Redirect> {
    let project = load_project(&app, &id).await?;
    if project.current().number != form.revision {
        return Err(web::Error::conflict(
            "The project changed. Reload before reviewing.",
        ));
    }
    if project.current().evidence.is_empty() && project.current().material.is_empty() {
        return Err(web::Error::bad_request(
            "Attach evidence or original material before review.",
        ));
    }
    if app.db().get::<Brand>("brand", "current").await?.is_none() {
        return Err(web::Error::bad_request(
            "Save your brand profile before reviewing evidence.",
        ));
    }
    let url = format!("/content/projects/{id}");
    conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut p = store::get::<Project>(tx, "content.project", &id)?
                    .ok_or_else(|| anyhow::anyhow!("Project not found"))?;
                anyhow::ensure!(
                    p.current().number == form.revision,
                    "stale project revision"
                );
                anyhow::ensure!(
                    !p.current().evidence.is_empty() || !p.current().material.is_empty(),
                    "Attach evidence or original material before review"
                );
                let brand = store::get::<Brand>(tx, "brand", "current")?.ok_or_else(|| {
                    anyhow::anyhow!("Save your brand profile before reviewing evidence")
                })?;
                let r = p.revisions.last_mut().expect("revision");
                if !r.evidence_reviewed {
                    r.brand = Some(brand);
                    r.evidence_reviewed = true;
                }
                store::put(tx, "content.project", &id, &p)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}
async fn generate(
    State(app): State<App>,
    Path((id, stage)): Path<(String, String)>,
    Form(form): Form<RevisionForm>,
) -> web::Result<Redirect> {
    let p = load_project(&app, &id).await?;
    let r = p.current();
    if r.number != form.revision {
        return Err(web::Error::conflict(
            "The project changed. Reload before generating.",
        ));
    }
    if !matches!(stage.as_str(), "research" | "outline" | "draft") {
        return Err(web::Error::bad_request(
            "Choose research, outline, or draft.",
        ));
    }
    if stage != "research" && !r.evidence_reviewed {
        return Err(web::Error::bad_request(
            "Review the evidence before generating an outline or draft.",
        ));
    }
    if stage == "draft" && !latest(r, "outline").is_some_and(|a| a.approved_at.is_some()) {
        return Err(web::Error::bad_request(
            "Approve the latest outline before generating a draft.",
        ));
    }
    let job = work::enqueue(
        app.db(),
        &format!("content.{stage}"),
        &format!(
            "content:{id}:{}:{stage}:{}",
            r.number,
            r.artifacts.last().map_or("initial", |a| a.id.as_str())
        ),
        json!({"project_id":id,"revision":r}),
    )
    .await?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}
async fn approve(
    State(app): State<App>,
    Path((id, artifact_id)): Path<(String, String)>,
    Form(form): Form<RevisionForm>,
) -> web::Result<Redirect> {
    load_project(&app, &id).await?;
    uuid_path(&artifact_id)?;
    let url = format!("/content/projects/{id}");
    conflict_result(
        app.db()
            .transaction(move |tx| {
                let mut p = store::get::<Project>(tx, "content.project", &id)?
                    .ok_or_else(|| anyhow::anyhow!("Project not found"))?;
                anyhow::ensure!(
                    p.current().number == form.revision,
                    "stale project revision"
                );
                let stage = p
                    .current()
                    .artifacts
                    .iter()
                    .find(|a| a.id == artifact_id)
                    .map(|a| a.stage.clone())
                    .ok_or_else(|| anyhow::anyhow!("Artifact not found"))?;
                anyhow::ensure!(
                    latest(p.current(), &stage).is_some_and(|a| a.id == artifact_id),
                    "stale artifact; review the latest version"
                );
                if stage == "draft" {
                    let draft = p
                        .current()
                        .artifacts
                        .iter()
                        .find(|a| a.id == artifact_id)
                        .expect("artifact");
                    anyhow::ensure!(
                        draft_current(p.current(), draft),
                        "stale draft; generate from the current approved outline"
                    );
                }
                let artifact = p
                    .revisions
                    .last_mut()
                    .expect("revision")
                    .artifacts
                    .iter_mut()
                    .find(|a| a.id == artifact_id)
                    .expect("artifact");
                if artifact.approved_at.is_none() {
                    artifact.approved_at = Some(now());
                }
                store::put(tx, "content.project", &id, &p)
            })
            .await,
    )?;
    Ok(Redirect::to(&url))
}
#[derive(Deserialize)]
struct EditArtifactForm {
    revision: u64,
    body: String,
}
async fn edit_artifact(
    State(app): State<App>,
    Path((id, artifact_id)): Path<(String, String)>,
    Form(form): Form<EditArtifactForm>,
) -> web::Result<Redirect> {
    load_project(&app, &id).await?;
    uuid_path(&artifact_id)?;
    let body = required(&form.body, "Edited copy", 100000)?;
    let url = format!("/content/projects/{id}");
    conflict_result(app.db().transaction(move|tx|{
        let mut p=store::get::<Project>(tx,"content.project",&id)?.ok_or_else(||anyhow::anyhow!("Project not found"))?;
        anyhow::ensure!(p.current().number==form.revision,"stale project revision");
        let mut previous=p.current().artifacts.iter().find(|a|a.id==artifact_id).cloned().ok_or_else(||anyhow::anyhow!("Artifact not found"))?;
        anyhow::ensure!(matches!(previous.stage.as_str(),"outline"|"draft"),"Only outlines and drafts can be edited");
        anyhow::ensure!(latest(p.current(),&previous.stage).is_some_and(|a|a.id==artifact_id),"stale artifact; edit the latest version");
        anyhow::ensure!(previous.stage!="draft"||draft_current(p.current(),&previous),"stale draft; generate from the current approved outline");
        previous.id=new_id();previous.body=body;previous.approved_at=None;previous.created_at=now();if !previous.model.starts_with("Human edit of "){previous.model=format!("Human edit of {}",previous.model);}
        // A human can introduce claims: retain the original citation ledger and visibly require a new review.
        let edit_warning="Human edits require checking every factual claim against the captured evidence.".to_owned();
        if !previous.unsupported_claims.contains(&edit_warning){previous.unsupported_claims.push(edit_warning);}
        p.revisions.last_mut().expect("revision").artifacts.push(previous);store::put(tx,"content.project",&id,&p)
    }).await)?;
    Ok(Redirect::to(&url))
}
async fn export(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let p = load_project(&app, &id).await?;
    let r = p.current();
    let draft = latest(r, "draft")
        .filter(|a| a.approved_at.is_some() && draft_current(r, a))
        .ok_or_else(|| {
            web::Error::bad_request(
                "Review and approve the latest draft for the current outline before exporting.",
            )
        })?;
    let mut text = format!(
        "# {}\n\n{}\n\n---\nFormat: {}\nProject revision: {}\nModel: {}\nReviewed: {}\n\n## Source evidence\n",
        r.subject,
        draft.body,
        r.target,
        r.number,
        draft.model,
        draft.approved_at.as_deref().unwrap_or("")
    );
    for e in &r.evidence {
        text.push_str(&format!(
            "- {}: {} {}\n",
            e.id,
            e.title,
            e.url.as_deref().unwrap_or("(manual evidence)")
        ));
    }
    if !draft.unsupported_claims.is_empty() {
        text.push_str("\n## Claims requiring verification\n");
        for claim in &draft.unsupported_claims {
            text.push_str(&format!("- {claim}\n"));
        }
    }
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/markdown; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=reviewed-draft.md",
            ),
        ],
        text,
    )
        .into_response())
}

#[derive(Deserialize)]
struct WatchForm {
    name: String,
    query: String,
}
async fn add_watch(State(app): State<App>, Form(form): Form<WatchForm>) -> web::Result<Redirect> {
    let watch = Watch {
        id: new_id(),
        name: required(&form.name, "Name", 200)?,
        query: required(&form.query, "Public query", 1000)?,
        paused: false,
    };
    app.db()
        .put("content.watch", &watch.id.clone(), watch)
        .await?;
    Ok(Redirect::to("/research"))
}
async fn toggle_watch(State(app): State<App>, Path(id): Path<String>) -> web::Result<Redirect> {
    uuid_path(&id)?;
    app.db()
        .transaction(move |tx| {
            let mut watch = store::get::<Watch>(tx, "content.watch", &id)?
                .ok_or_else(|| anyhow::anyhow!("Watch not found"))?;
            watch.paused = !watch.paused;
            store::put(tx, "content.watch", &id, &watch)
        })
        .await?;
    Ok(Redirect::to("/research"))
}
async fn watch_run(State(app): State<App>) -> web::Result<Redirect> {
    let job = enqueue_snapshot(&app, "content.watch")
        .await
        .map_err(|e| web::Error::bad_request(e.to_string()))?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}

#[derive(Deserialize)]
struct ChannelForm {
    id: String,
    title: String,
}
async fn add_channel(
    State(app): State<App>,
    Form(form): Form<ChannelForm>,
) -> web::Result<Redirect> {
    if !valid_channel_id(&form.id) {
        return Err(web::Error::bad_request(
            "Enter the stable 24-character YouTube channel ID starting with UC.",
        ));
    }
    let channel = Channel {
        id: form.id,
        title: required(&form.title, "Channel label", 200)?,
        paused: false,
    };
    app.db()
        .put("content.channel", &channel.id.clone(), channel)
        .await?;
    Ok(Redirect::to("/youtube"))
}
fn valid_channel_id(id: &str) -> bool {
    id.starts_with("UC")
        && id.len() == 24
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
async fn toggle_channel(State(app): State<App>, Path(id): Path<String>) -> web::Result<Redirect> {
    if !valid_channel_id(&id) {
        return Err(web::Error::not_found("Channel not found."));
    }
    app.db()
        .transaction(move |tx| {
            let mut channel = store::get::<Channel>(tx, "content.channel", &id)?
                .ok_or_else(|| anyhow::anyhow!("Channel not found"))?;
            channel.paused = !channel.paused;
            store::put(tx, "content.channel", &id, &channel)
        })
        .await?;
    Ok(Redirect::to("/youtube"))
}
async fn trends_run(State(app): State<App>) -> web::Result<Redirect> {
    let job = enqueue_snapshot(&app, "content.trends")
        .await
        .map_err(|e| web::Error::bad_request(e.to_string()))?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}
