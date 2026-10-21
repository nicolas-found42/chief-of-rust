//! Terminal homepage and profile rendering.
//!
//! Architecture review card 6: the route handlers here load every record and
//! the `*_page` functions render them, so no rendering function reads the
//! store and each page's interface states the records it needs.
use super::*;
use crate::{
    web::{self, Error, Result, escape},
    work,
};
use axum::{
    extract::{Path, Query, State},
    response::Response,
};

#[derive(Default, Deserialize)]
pub struct HomeQuery {
    #[serde(default)]
    update: String,
    #[serde(default)]
    request: String,
}

fn intake_form(identity: &Identity, target: Option<(&str, u64)>, supersedes: &str) -> String {
    let mut html = format!(
        "<form class=\"cds-form cds-form--grid\" method=\"post\" action=\"/terminal/intake\"><input type=\"hidden\" name=\"kind\" value=\"{}\"><input type=\"hidden\" name=\"supersedes\" value=\"{}\">",
        identity.kind,
        escape(supersedes)
    );
    if let Some((id, version)) = target {
        html += &format!(
            "<input type=\"hidden\" name=\"target_id\" value=\"{}\"><input type=\"hidden\" name=\"version\" value=\"{version}\">",
            escape(id)
        );
    }
    html += &format!(
        "<label>Name<input name=\"name\" value=\"{}\" required maxlength=\"200\"{}></label>",
        escape(&identity.name),
        if target.is_some() { " readonly" } else { "" }
    );
    if identity.kind == "person" {
        html += &web::field("Email", "email", &identity.email, "email", Some(254), false);
        html += &web::field("Role", "role", &identity.role, "text", Some(200), false);
        html += &web::field(
            "Company",
            "company",
            &identity.company,
            "text",
            Some(200),
            false,
        );
        html += &web::field(
            "LinkedIn",
            "linkedin",
            &identity.linkedin,
            "url",
            Some(4000),
            false,
        );
        html += &web::field(
            "Personal website",
            "website",
            &identity.website,
            "url",
            Some(4000),
            false,
        );
    } else {
        html += &web::field(
            "Website",
            "website",
            &identity.website,
            "url",
            Some(4000),
            false,
        );
        html += &web::field(
            "Jurisdiction",
            "jurisdiction",
            &identity.jurisdiction,
            "text",
            Some(200),
            false,
        );
    }
    html += &web::field(
        "Phone number",
        "phone",
        &identity.phone,
        "tel",
        Some(100),
        false,
    );
    html += &format!(
        "<button class=\"cds-btn cds-btn--primary\">{}</button></form>",
        if target.is_some() {
            "Update profile and research"
        } else {
            "Create profile and research"
        }
    );
    html
}

/// Everything the Terminal homepage renders, loaded by the handler.
struct HomeData {
    people: Vec<(String, Identity, u64)>,
    companies: Vec<(String, Identity, u64)>,
    requests: Vec<(Request, Option<work::Job>)>,
    candidates: Vec<(Candidate, Option<Request>)>,
    reports: Vec<super::reports::Report>,
    people_records: Vec<Person>,
    companies_records: Vec<Company>,
    submitted: Option<Request>,
}

pub async fn homepage(State(app): State<App>, Query(query): Query<HomeQuery>) -> Result<Response> {
    let people = identities(&app, "person").await?;
    let companies = identities(&app, "company").await?;
    let mut requests = Vec::new();
    for request in app
        .db()
        .list::<Request>("terminal_request")
        .await?
        .into_iter()
        .filter(|r| r.status != "superseded")
        .take(30)
    {
        let run = work::find(app.db(), &request.run_id).await?;
        requests.push((request, run));
    }
    let mut candidates = Vec::new();
    for candidate in app
        .db()
        .list::<Candidate>("terminal_candidate")
        .await?
        .into_iter()
        .filter(|c| !c.dismissed)
    {
        let request = match &candidate.request_id {
            Some(id) => app.db().get("terminal_request", id).await?,
            None => None,
        };
        candidates.push((candidate, request));
    }
    let reports = app
        .db()
        .list::<super::reports::Report>("terminal_report")
        .await?;
    let people_records = app
        .db()
        .list::<Person>("person")
        .await?
        .into_iter()
        .filter(|p| p.merged_into.is_none())
        .collect();
    let companies_records = app.db().list::<Company>("company").await?;
    let submitted = if query.request.is_empty() {
        None
    } else {
        Some(
            app.db()
                .get::<Request>("terminal_request", &query.request)
                .await?
                .ok_or_else(|| Error::not_found("Request not found."))?,
        )
    };
    home_page(
        &query,
        &HomeData {
            people,
            companies,
            requests,
            candidates,
            reports,
            people_records,
            companies_records,
            submitted,
        },
    )
}

fn home_page(query: &HomeQuery, data: &HomeData) -> Result<Response> {
    let HomeData {
        people,
        companies,
        requests,
        candidates,
        reports,
        people_records,
        companies_records,
        submitted,
    } = data;
    let mut body = "<p class=\"cds-eyebrow\">Company and person intelligence</p><p class=\"cds-lead\">Enter what you know. Research resolves identity, builds the complete dossier and suggests related people and companies.</p><p><a href=\"/terminal/people\">Person Profiles</a> · <a href=\"/terminal/companies\">Company Profiles</a></p><section class=\"cds-section\" id=\"intake\"><h2>Create profile</h2><p>Only name is required. Optional details help distinguish people and companies with the same name.</p><div class=\"cds-cards\">".to_owned();
    for kind in [
        crate::terminal::subject::SubjectKind::Person,
        crate::terminal::subject::SubjectKind::Company,
    ] {
        let spec = kind.spec();
        let identity = Identity {
            kind: spec.kind_str.into(),
            ..Default::default()
        };
        body += &format!(
            "<article class=\"cds-card\"><h3>{}</h3>{}</article>",
            spec.noun,
            intake_form(&identity, None, "")
        );
    }
    body += "</div></section><section class=\"cds-section\"><h2>Update existing profile</h2><form class=\"cds-form\" method=\"get\" action=\"/terminal#update\"><label>Choose profile<select name=\"update\" required><option value=\"\">Select a profile</option>";
    for (id, identity, _) in people.iter().chain(companies) {
        let key = subject_key(&identity.kind, id);
        body += &format!(
            "<option value=\"{}\"{}>{}</option>",
            escape(&key),
            if key == query.update { " selected" } else { "" },
            escape(&identity.label())
        );
    }
    body += "</select></label><button class=\"cds-btn cds-btn--secondary\">Choose profile to update</button></form><p>Keep the name. Change any other input, then run fresh research.</p>";
    if let Some((kind, id)) = query.update.split_once(':') {
        if let Some((_, identity, version)) = people
            .iter()
            .chain(companies)
            .find(|(existing, identity, _)| existing == id && identity.kind == kind)
        {
            body += &format!(
                "<article class=\"cds-card\" id=\"update\"><h3>{}</h3>{}</article>",
                escape(&identity.label()),
                intake_form(identity, Some((id, *version)), "")
            );
        } else {
            return Err(Error::not_found("Profile not found."));
        }
    }
    if let Some(request) = submitted {
        body += &format!(
            "<article class=\"cds-card\"><h3>Add identifying information for {}</h3>{}</article>",
            escape(&request.identity.name),
            intake_form(
                &request.identity,
                request.target_id.as_deref().zip(request.expected_version),
                &request.id
            )
        );
    }
    body += "</section><section class=\"cds-section\"><h2>Research progress and identity clarification</h2>";
    let mut active = false;
    for (request, run) in requests {
        let running = run
            .as_ref()
            .is_some_and(|r| matches!(r.status.as_str(), "queued" | "running"));
        active |= running;
        body += &format!(
            "<article class=\"cds-card\" id=\"request-{}\"><h3>{}</h3><p>{}</p><p><a href=\"/runs/{}\">Progress and diagnostics</a></p>",
            escape(&request.id),
            escape(&request.identity.label()),
            escape(&request.phase),
            escape(&request.run_id)
        );
        if let Some(run) = run.as_ref()
            && let Some(error) = &run.error
        {
            body += &format!(
                "<p role=\"alert\">{}</p><form class=\"cds-inline-form\" method=\"post\" action=\"/runs/{}/retry\"><button class=\"cds-btn cds-btn--primary\">Retry research</button></form>",
                escape(error),
                escape(&run.id)
            );
        }
        if request.status == "needs-clarification" {
            body += "<p>Identity needs clarification. Select the intended subject or add more identifying information.</p>";
            for (index, choice) in request.choices.iter().enumerate() {
                body += &format!(
                    "<div><h4>{}</h4><p>{}</p>{}<form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/resolve/{}\"><input type=\"hidden\" name=\"choice\" value=\"{index}\"><button class=\"cds-btn cds-btn--primary\">Research this identity</button></form></div>",
                    escape(&choice.identity.label()),
                    escape(&choice.explanation),
                    reference_view(&choice.references, &request.sources),
                    escape(&request.id)
                );
            }
            body += &format!(
                "<p><a href=\"/terminal?request={}#intake\">Add identifying information</a></p>",
                escape(&request.id)
            );
        }
        if request.status == "complete"
            && let Some(id) = &request.target_id
        {
            body += &format!(
                "<p><a href=\"{}\">Open current dossier</a></p>",
                profile_url(&request.identity.kind, id)
            );
        }
        body += "</article>";
    }
    body += "</section><section class=\"cds-section\" id=\"candidates\"><h2>Research candidates</h2><p>Discovered employers, executives and competitors. Research starts only when you choose a candidate.</p>";
    for (candidate, candidate_request) in candidates {
        body += &format!(
            "<article class=\"cds-card\"><h3>{}</h3><p>{}</p>{}",
            escape(&candidate.identity.label()),
            escape(&candidate.reason),
            reference_view(&candidate.references, &candidate.sources)
        );
        let existing = people
            .iter()
            .chain(companies)
            .find(|(_, i, _)| same_anchor(i, &candidate.identity));
        if let Some((id, identity, _)) = existing {
            body += &format!(
                "<p><a href=\"{}\">Open existing profile</a></p>",
                profile_url(&identity.kind, id)
            );
        } else if let Some(request_id) = candidate.request_id.as_ref() {
            if let Some(request) = candidate_request.as_ref()
                && request.status == "complete"
                && let Some(id) = &request.target_id
                && people
                    .iter()
                    .chain(companies)
                    .any(|(existing, identity, _)| {
                        existing == id && identity.kind == candidate.identity.kind
                    })
            {
                body += &format!(
                    "<p><a href=\"{}\">Open existing profile</a></p>",
                    profile_url(&candidate.identity.kind, id)
                );
            } else {
                body += &format!(
                    "<p><a href=\"#request-{}\">Open research progress</a></p>",
                    escape(request_id)
                );
            }
        } else {
            body += &format!(
                "<form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/candidates/{}\"><button class=\"cds-btn cds-btn--primary\" name=\"action\" value=\"research\">Research</button></form>",
                escape(&candidate.id)
            );
        }
        body += &format!(
            "<form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/candidates/{}\"><button class=\"cds-btn cds-btn--secondary\" name=\"action\" value=\"dismiss\">Dismiss</button></form></article>",
            escape(&candidate.id)
        );
    }
    body += "</section><section class=\"cds-section\" id=\"reports\"><h2>Ask / compare</h2><p>Ask a specific question about one or more profiles. Reports use their dossiers plus supplemental web research.</p><form class=\"cds-form cds-form--grid\" method=\"post\" action=\"/terminal/reports\">";
    let options = people
        .iter()
        .chain(companies)
        .map(|(id, i, _)| {
            format!(
                "<option value=\"{}\">{}</option>",
                escape(&subject_key(&i.kind, id)),
                escape(&i.label())
            )
        })
        .collect::<String>();
    for index in 1..=6 {
        body += &format!(
            "<label>Subject {index}{}<select name=\"subject_{index}\"{}><option value=\"\">Choose a profile</option>{options}</select></label>",
            if index == 1 { "" } else { " (optional)" },
            if index == 1 { " required" } else { "" }
        );
    }
    body += "<label>Question<textarea name=\"question\" required maxlength=\"2000\" placeholder=\"For example: compare these two companies\"></textarea></label><button class=\"cds-btn cds-btn--primary\">Research report</button></form><h3>Reports</h3>";
    for report in reports {
        body += &format!(
            "<p><a href=\"/terminal/reports/{}\">{}</a></p>",
            escape(&report.id),
            escape(&report.question)
        );
    }
    body += "</section>";
    body += "<details id=\"profile-management\"><summary>Profile management</summary>";
    for person in people_records {
        body += &format!(
            "<article class=\"cds-card\"><h3>{}</h3><form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/people/{}/{}\"><button class=\"cds-btn cds-btn--primary\">{}</button></form><details><summary>Privacy deletion</summary><p>Permanent removal includes dossier archives and related reports.</p><form class=\"cds-form\" method=\"post\" action=\"/terminal/people/{}/privacy-delete\"><input type=\"hidden\" name=\"version\" value=\"{}\"><label>Type DELETE to confirm<input name=\"acknowledgement\" required></label><button class=\"cds-btn cds-btn--danger\">Permanently delete profile data</button></form></details></article>",
            escape(&person_identity(person).label()),
            escape(&person.id),
            if person.archived {
                "restore"
            } else {
                "archive"
            },
            if person.archived {
                "Restore person"
            } else {
                "Archive person"
            },
            escape(&person.id),
            person.version
        );
    }
    for company in companies_records {
        body += &format!(
            "<article class=\"cds-card\"><h3>{}</h3><details><summary>Privacy deletion</summary><p>Permanent removal includes dossier archives and related reports.</p><form class=\"cds-form\" method=\"post\" action=\"/terminal/companies/{}/privacy-delete\"><input type=\"hidden\" name=\"version\" value=\"{}\"><label>Type DELETE to confirm<input name=\"acknowledgement\" required></label><button class=\"cds-btn cds-btn--danger\">Permanently delete company data</button></form></details></article>",
            escape(&company_identity(company).label()),
            escape(&company.id),
            company.version
        );
    }
    body += "</details>";
    Ok(web::page_refresh(
        "Bloomberg Terminal",
        web::Body::new(body),
        active,
    ))
}

pub(super) fn same_anchor(a: &Identity, b: &Identity) -> bool {
    if a.kind != b.kind {
        return false;
    }
    if a.kind == "person" {
        !a.linkedin.is_empty() && a.linkedin == b.linkedin
    } else {
        !a.website.is_empty()
            && a.website == b.website
            && a.name.trim().eq_ignore_ascii_case(b.name.trim())
            && (a.jurisdiction.is_empty()
                || b.jurisdiction.is_empty()
                || a.jurisdiction
                    .trim()
                    .eq_ignore_ascii_case(b.jurisdiction.trim()))
    }
}

pub(super) fn reference_view(
    references: &[Reference],
    sources: &[crate::research::SourceRecord],
) -> String {
    references
        .iter()
        .map(|r| {
            web::quote(
                &r.quote,
                &escape(
                    &sources
                        .iter()
                        .find(|s| s.id == r.source_id)
                        .and_then(|s| s.source_url.clone().or(s.request_url.clone()))
                        .unwrap_or_else(|| r.source_id.clone()),
                ),
            )
        })
        .collect()
}

pub(super) fn source_view(sources: &[crate::research::SourceRecord]) -> String {
    let mut html =
        "<section class=\"cds-section\"><h2>Sources and retained evidence</h2>".to_owned();
    for source in sources {
        let citation = web::Citation::hashed(&source.id);
        let source_url = source
            .source_url
            .as_deref()
            .or(source.request_url.as_deref())
            .unwrap_or_default();
        let link = if url::Url::parse(source_url).is_ok_and(|u| {
            u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
        }) {
            format!(
                "<a href=\"{}\" rel=\"noreferrer\">Open source</a>",
                escape(source_url)
            )
        } else {
            escape(source_url)
        };
        html += &format!(
            "<details id=\"{}\"><summary>{} {}</summary><p>{} · {}</p>",
            citation.anchor(),
            citation.text(),
            escape(&source.title),
            link,
            escape(
                source
                    .inspection_details
                    .as_deref()
                    .unwrap_or(&source.notes)
            )
        );
        if let Some(provenance) = &source.search_provenance {
            let counts = &provenance.provider;
            html += &format!(
                "<p>Selected search snippet · {}: received {}, invalid {}, empty {}, within-provider duplicates {}, omitted {}, selected {}. Query: {}</p>",
                escape(&counts.provider),
                counts.received,
                counts.invalid,
                counts.empty,
                counts.duplicate,
                counts.omitted,
                counts.selected,
                escape(&provenance.query)
            );
        }
        for excerpt in &source.excerpts {
            html += &format!("<pre>{}</pre>", escape(&excerpt.text));
        }
        html += "</details>";
    }
    html += "</section>";
    html
}

pub(super) fn dossier_html(body: &str, sources: &[crate::research::SourceRecord]) -> String {
    let citations = sources
        .iter()
        .map(|source| web::Citation::hashed(&source.id))
        .collect::<Vec<_>>();
    web::cited(&web::brief_markdown(body), &citations)
}

pub async fn person_detail(State(app): State<App>, Path(id): Path<String>) -> Result<Response> {
    profile(&app, "person", &id).await
}
pub async fn company_detail(State(app): State<App>, Path(id): Path<String>) -> Result<Response> {
    profile(&app, "company", &id).await
}

/// Everything a Terminal profile page renders, loaded by the handler.
struct ProfileData<'a> {
    kind: &'a str,
    id: &'a str,
    identity: Identity,
    archived: bool,
    merged: Option<String>,
    dossier: Option<Dossier>,
    legacy: Option<(String, Value)>,
    latest_request: Option<(Request, Option<work::Job>)>,
}

async fn profile(app: &App, kind: &str, id: &str) -> Result<Response> {
    let (fallback, archived, merged) = if kind == "person" {
        let person: Person = app
            .db()
            .get("person", id)
            .await?
            .ok_or_else(|| Error::not_found("Profile not found."))?;
        (
            person_identity(&person),
            person.archived,
            person.merged_into,
        )
    } else {
        let company: Company = app
            .db()
            .get("company", id)
            .await?
            .ok_or_else(|| Error::not_found("Profile not found."))?;
        (company_identity(&company), false, None)
    };
    let identity: Identity = app
        .db()
        .get("terminal_identity", &subject_key(kind, id))
        .await?
        .unwrap_or(fallback);
    let dossier = app
        .db()
        .get::<Dossier>("terminal_dossier", &subject_key(kind, id))
        .await?;
    // Pre-cutover evidence is only read when no automatic dossier exists.
    let legacy = if dossier.is_none() {
        latest_legacy(app, kind, id).await?
    } else {
        None
    };
    let latest_request = match app
        .db()
        .list::<Request>("terminal_request")
        .await?
        .into_iter()
        .filter(|r| r.identity.kind == kind && r.target_id.as_deref() == Some(id))
        .take(1)
        .next()
    {
        Some(request) => {
            let run = work::find(app.db(), &request.run_id).await?;
            Some((request, run))
        }
        None => None,
    };
    profile_page(&ProfileData {
        kind,
        id,
        identity,
        archived,
        merged,
        dossier,
        legacy,
        latest_request,
    })
}

fn profile_page(data: &ProfileData) -> Result<Response> {
    let identity = &data.identity;
    let mut body = format!(
        "<h1>{}</h1><p>{}</p>",
        escape(&identity.name),
        escape(&identity.label())
    );
    if data.archived {
        body += &web::carbon_notification(
            "Archived Person",
            "<p>Restore from the Terminal homepage before updating or researching.</p><p><a href=\"/terminal#profile-management\">Profile management</a></p>",
            web::CarbonNotification::Warning,
        );
    } else if let Some(target) = &data.merged {
        body += &format!(
            "<p>Merged profile. <a href=\"{}\">Open canonical person</a>.</p>",
            profile_url("person", target)
        );
    } else {
        body += &format!(
            "<p><a href=\"/terminal?update={0}#update\">Update inputs on Terminal homepage</a></p><form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/profiles/{1}/{2}/refresh\"><button class=\"cds-btn cds-btn--primary\">Refresh dossier</button></form>",
            escape(&subject_key(data.kind, data.id)),
            escape(data.kind),
            escape(data.id)
        );
    }
    if let Some(dossier) = &data.dossier {
        body += &format!(
            "<article class=\"cds-prose\">{}</article>",
            dossier_html(&dossier.body, &dossier.sources)
        );
        if !dossier.employment_history.is_empty() {
            body += "<section class=\"cds-section\"><h2>Recorded career history</h2>";
            for employment in &dossier.employment_history {
                body += &format!(
                    "<p>{} · {} · {}</p>",
                    escape(employment["company"].as_str().unwrap_or_default()),
                    escape(employment["role"].as_str().unwrap_or_default()),
                    escape(
                        employment["effective_date"]
                            .as_str()
                            .unwrap_or("Date not established")
                    )
                );
            }
            body += "</section>";
        }
        body += &source_view(&dossier.sources);
        body += &super::super::coverage_view(&dossier.coverage);
        body += "<section class=\"cds-section\"><h2>Research limits and gaps</h2><ul>";
        for limit in &dossier.limitations {
            body += &format!("<li>{}</li>", escape(limit));
        }
        for item in &dossier.frontier {
            body += &format!(
                "<li>{}: {}</li>",
                escape(&item.next_action),
                escape(&item.reason)
            );
        }
        body += "</ul></section>";
    } else {
        // Pre-cutover evidence stays readable, but only the latest snapshot
        // appears. New research uses the automatic workflow.
        if let Some((record_kind, brief)) = &data.legacy {
            if record_kind == "dossier" {
                body += "<section class=\"cds-section\"><h2>Latest research dossier</h2>";
                if let Ok(dossier) = serde_json::from_value::<crate::people::Dossier>(brief.clone())
                {
                    body += &format!("<p>{}</p>", escape(&dossier.question));
                    if let Some(coverage) = &dossier.search_coverage {
                        body += &web::search_coverage(coverage);
                    }
                    for claim in dossier.claims {
                        body += &format!(
                            "<p>{}</p><blockquote>{}</blockquote>",
                            escape(&claim.text),
                            escape(&claim.quote)
                        );
                        if let Some(evidence) =
                            dossier.evidence.iter().find(|e| e.id == claim.source_id)
                        {
                            body += &format!(
                                "<p>Source: {} · {}</p>",
                                escape(&evidence.title),
                                escape(&evidence.url)
                            );
                        }
                    }
                    for unknown in dossier.unknowns {
                        body += &format!("<p>{}</p>", escape(&unknown));
                    }
                }
                body += "</section>";
            } else {
                body += &format!(
                    "<h2>{}</h2><article class=\"cds-prose\">{}</article>",
                    escape(brief["question"].as_str().unwrap_or("Dossier")),
                    web::brief_markdown(brief["brief"].as_str().unwrap_or_default())
                );
                if brief["ledger_check"]["valid"] == false {
                    body += &web::carbon_notification(
                        "Ledger warnings",
                        "<p>Read the retained coverage before relying on this dossier.</p>",
                        web::CarbonNotification::Warning,
                    );
                }
                if let Ok(sources) = serde_json::from_value::<Vec<crate::research::SourceRecord>>(
                    brief["sources"].clone(),
                ) {
                    body += &source_view(&sources);
                }
                if let Ok(coverage) = serde_json::from_value::<Vec<crate::research::CoverageRow>>(
                    brief["coverage"].clone(),
                ) {
                    body += &super::super::coverage_view(&coverage);
                }
                if let Ok(affiliation) = serde_json::from_value::<Vec<crate::research::SourceRecord>>(
                    brief["affiliation_context"].clone(),
                ) && !affiliation.is_empty()
                {
                    body += "<section class=\"cds-section\"><h2>Affiliation context</h2><p>Company evidence is affiliation context, not personal facts.</p>";
                    body += &source_view(&affiliation);
                    body += "</section>";
                }
                if let Ok(frontier) = serde_json::from_value::<Vec<crate::research::FrontierItem>>(
                    brief["frontier"].clone(),
                ) && !frontier.is_empty()
                {
                    body += "<section class=\"cds-section\"><h2>Unfinished work</h2><ul>";
                    for item in frontier {
                        body += &format!(
                            "<li>{}: {}</li>",
                            escape(&item.next_action),
                            escape(&item.reason)
                        );
                    }
                    body += "</ul></section>";
                }
            }
        } else {
            body += "<p>No complete dossier yet. Refresh dossier to start automatic research.</p>";
        }
    }
    let mut active = false;
    if let Some((request, Some(run))) = &data.latest_request {
        active = matches!(run.status.as_str(), "queued" | "running");
        body += &format!(
            "<p>{} · <a href=\"/terminal#request-{}\">Research progress</a></p>",
            escape(&request.phase),
            escape(&request.id)
        );
        if let Some(error) = &run.error {
            body += &format!(
                "<p role=\"alert\">{}</p><form class=\"cds-inline-form\" method=\"post\" action=\"/runs/{}/retry\"><button class=\"cds-btn cds-btn--primary\">Retry research</button></form>",
                escape(error),
                escape(&run.id)
            );
        }
    }
    body += "<p><a href=\"/terminal\">Back to Terminal</a></p>";
    Ok(web::page_refresh(
        &identity.name,
        web::Body::with_heading(body),
        active,
    ))
}
