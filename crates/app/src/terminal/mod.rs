//! Bloomberg Terminal: adjacent person and company research in one product.
//!
//! Canonical routes live under `/terminal`. The person section reuses the
//! existing person record kinds through the terminal router; the company
//! section adds Company Profile records with version-fenced identity edits.
//! Old `/people` routes are removed without redirects (spec cutover rule).

use crate::{
    App, store,
    web::{self, Error, Result, escape, required},
};
use axum::{
    Router,
    extract::{Form, Path, Query, State},
    response::{Redirect, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub mod comparison;
pub mod continuation;
pub mod execution;
pub mod person;

/// Company Profile: canonical identity plus research anchors. Researched
/// fields keep provenance in the research ledgers; user identity is never
/// silently overwritten by collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub id: String,
    pub name: String,
    pub website: String,
    pub domain: String,
    pub jurisdiction: String,
    pub identifiers: String,
    pub aliases: String,
    pub relationships: String,
    pub notes: String,
    pub version: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/terminal", get(index))
        .route("/terminal/companies", get(companies).post(create_company))
        .route(
            "/terminal/companies/{id}",
            get(company_detail).post(edit_company),
        )
        .route(
            "/terminal/companies/{id}/research",
            post(execution::research_company),
        )
        .route(
            "/terminal/companies/{id}/briefs/{brief}",
            get(execution::company_brief),
        )
        .route(
            "/terminal/companies/{id}/briefs/{brief}/continue",
            post(execution::continue_company),
        )
        .route(
            "/terminal/people/{id}/full-research",
            post(person::research_person),
        )
        .route(
            "/terminal/people/{id}/briefs/{brief}",
            get(person::person_brief),
        )
        .route(
            "/terminal/comparisons",
            post(comparison::request_comparison),
        )
        .route(
            "/terminal/comparisons/{id}",
            get(comparison::comparison_detail),
        )
        .route(
            "/terminal/companies/{id}/privacy-delete",
            post(company_privacy_delete),
        )
}

async fn index(State(app): State<App>) -> Result<Response> {
    let people = app.db.list::<serde_json::Value>("person").await?.len();
    let companies = app.db.list::<serde_json::Value>("company").await?.len();
    let mut body = String::from(
        "<p class=\"eyebrow\">Company and person intelligence</p><p class=\"lead\">Adjacent profiles, one research engine. Explicit full research only; saving identity never starts collection.</p><div class=\"grid cards\">",
    );
    body.push_str(&format!(
        "<article><h2>Person Profiles</h2><p>Canonical identities, saved evidence, question-driven dossiers and CRM capture.</p><p><a href=\"/terminal/people\">Open person directory</a></p><span class=\"badge\">{people} records</span><section><h3>Add a person</h3><form method=\"post\" action=\"/terminal/people\"><label>Name <input name=\"name\" required maxlength=\"200\"></label><label>Email <input type=\"email\" name=\"email\" maxlength=\"254\"></label><label>Role <input name=\"role\" maxlength=\"200\"></label><label>Company <input name=\"company\" maxlength=\"200\"></label><button>Add person</button></form></section></article>"
    ));
    body.push_str(&format!(
        "<article><h2>Company Profiles</h2><p>Canonical company identity with website, jurisdiction, identifiers, aliases and dated relationships.</p><p><a href=\"/terminal/companies\">Open company directory</a></p><span class=\"badge\">{companies} records</span><section><h3>Add a company</h3><form method=\"post\" action=\"/terminal/companies\"><label>Name <input name=\"name\" required maxlength=\"200\"></label><label>Website <input name=\"website\" type=\"url\" maxlength=\"4000\"></label><label>Jurisdiction <input name=\"jurisdiction\" maxlength=\"200\"></label><button>Add company</button></form></section></article>"
    ));
    body.push_str("</div>");
    Ok(web::page("Bloomberg Terminal", body))
}

#[derive(Default, Deserialize)]
struct CompanyFilter {
    #[serde(default)]
    q: String,
}

async fn companies(
    State(app): State<App>,
    Query(filter): Query<CompanyFilter>,
) -> Result<Response> {
    let all = app.db.list::<Company>("company").await?;
    let mut body = format!(
        "<h1>Company Profiles</h1><p>Identity anchors for research. Saving identity never starts external collection.</p><form method=\"get\"><label>Search <input name=\"q\" value=\"{}\"></label><button>Search companies</button></form><section><h2>Directory</h2>",
        escape(&filter.q)
    );
    let mut visible = 0;
    for c in all.into_iter().filter(|c| {
        filter.q.is_empty()
            || format!("{} {} {} {}", c.name, c.domain, c.jurisdiction, c.aliases)
                .to_lowercase()
                .contains(&filter.q.to_lowercase())
    }) {
        visible += 1;
        body.push_str(&format!(
            "<article><h3><a href=\"/terminal/companies/{}\">{}</a></h3><p>{} · {}</p></article>",
            c.id,
            escape(&c.name),
            escape(&c.domain),
            escape(&c.jurisdiction),
        ));
    }
    if visible == 0 {
        body.push_str("<p>No companies match this view. Add a company above to begin.</p>");
    }
    body.push_str("</section><p><a href=\"/terminal\">Back to terminal</a></p>");
    Ok(web::page("Company Profiles", body))
}

#[derive(Deserialize)]
struct CompanyForm {
    name: String,
    #[serde(default)]
    website: String,
    #[serde(default)]
    jurisdiction: String,
    #[serde(default)]
    identifiers: String,
    #[serde(default)]
    aliases: String,
    #[serde(default)]
    relationships: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    version: u64,
}

fn validate_company(form: &CompanyForm) -> Result<(String, String)> {
    required(&form.name, "Name", 200)?;
    if form.jurisdiction.len() > 200
        || form.identifiers.len() > 4000
        || form.aliases.len() > 4000
        || form.relationships.len() > 10000
        || form.notes.len() > 20000
    {
        return Err(Error::bad_request("Invalid company identity fields."));
    }
    if form.website.len() > 4000 {
        return Err(Error::bad_request("Website URL is too long."));
    }
    let mut website = String::new();
    let mut domain = String::new();
    if !form.website.trim().is_empty() {
        let parsed = url::Url::parse(form.website.trim())
            .map_err(|_| Error::bad_request("Use an absolute https:// website URL."))?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(Error::bad_request(
                "Use an absolute https:// website URL without credentials.",
            ));
        }
        domain = parsed.host_str().unwrap_or_default().to_lowercase();
        website = parsed.into();
    }
    Ok((website, domain))
}

async fn create_company(State(app): State<App>, Form(form): Form<CompanyForm>) -> Result<Redirect> {
    let (website, domain) = validate_company(&form)?;
    let now = crate::now_ms();
    let company = Company {
        id: Uuid::new_v4().to_string(),
        name: form.name.trim().into(),
        website,
        domain,
        jurisdiction: form.jurisdiction.trim().into(),
        identifiers: form.identifiers,
        aliases: form.aliases,
        relationships: form.relationships,
        notes: form.notes,
        version: 1,
        created_at: now,
        updated_at: now,
    };
    let id = company.id.clone();
    app.db
        .transaction(move |tx| {
            store::put(tx, "company", &company.id, &company)?;
            Ok(())
        })
        .await?;
    Ok(Redirect::to(&format!("/terminal/companies/{id}")))
}

async fn company_record(app: &App, id: &str) -> Result<Company> {
    app.db
        .get("company", id)
        .await?
        .ok_or_else(|| Error::not_found("Company not found."))
}

async fn company_detail(State(app): State<App>, Path(id): Path<String>) -> Result<Response> {
    let c = company_record(&app, &id).await?;
    let mut body = format!("<h1>{}</h1>", escape(&c.name));
    body.push_str(&format!(
        "<form method=\"post\"><input type=\"hidden\" name=\"version\" value=\"{}\"><label>Name <input name=\"name\" required maxlength=\"200\" value=\"{}\"></label><label>Website <input name=\"website\" type=\"url\" value=\"{}\" maxlength=\"4000\"></label><label>Jurisdiction <input name=\"jurisdiction\" value=\"{}\" maxlength=\"200\"></label><label>Identifiers <textarea name=\"identifiers\" maxlength=\"4000\">{}</textarea></label><label>Known aliases <textarea name=\"aliases\" maxlength=\"4000\">{}</textarea></label><label>Dated relationships <textarea name=\"relationships\" maxlength=\"10000\">{}</textarea></label><label>Notes <textarea name=\"notes\" maxlength=\"20000\">{}</textarea></label><button>Save identity</button></form>",
        c.version,
        escape(&c.name),
        escape(&c.website),
        escape(&c.jurisdiction),
        escape(&c.identifiers),
        escape(&c.aliases),
        escape(&c.relationships),
        escape(&c.notes),
    ));
    body.push_str("<section><h2>Full research</h2><p>Explicit full research runs collection through a durable Run. Saving identity above never starts collection.</p>");
    body.push_str(&format!(
        "<form method=\"post\" action=\"/terminal/companies/{}/research\"><label>Research question <input name=\"question\" required maxlength=\"2000\"></label><button>Run full research</button></form></section>",
        c.id
    ));
    body.push_str(&format!(
        "<section><h2>Privacy deletion</h2><p>Permanently removes this company, its briefs, its comparisons and comparison reports, and their research-run snapshots. Other companies and unrelated history remain. This action cannot be undone.</p><form method=\"post\" action=\"/terminal/companies/{}/privacy-delete\"><input type=\"hidden\" name=\"version\" value=\"{}\"><label>Type DELETE to acknowledge permanent removal <input name=\"acknowledgement\" required autocomplete=\"off\"></label><button>Permanently delete company data</button></form></section>",
        c.id, c.version
    ));
    Ok(web::page(&c.name, body))
}

async fn edit_company(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<CompanyForm>,
) -> Result<Redirect> {
    let (website, domain) = validate_company(&form)?;
    let destination = id.clone();
    let outcome = app
        .db
        .transaction(move |tx| {
            let mut c: Company = store::get(tx, "company", &id)?
                .ok_or_else(|| anyhow::anyhow!("Company missing"))?;
            if c.version != form.version {
                return Ok("stale");
            }
            c.name = form.name.trim().into();
            c.website = website;
            c.domain = domain;
            c.jurisdiction = form.jurisdiction.trim().into();
            c.identifiers = form.identifiers;
            c.aliases = form.aliases;
            c.relationships = form.relationships;
            c.notes = form.notes;
            c.version += 1;
            c.updated_at = crate::now_ms();
            store::put(tx, "company", &id, &c)?;
            // Atomically schedule regeneration of affected comparisons from
            // saved snapshots; the worker synthesizes without recollection.
            let affected: Vec<String> = store::list::<comparison::Comparison>(tx, "comparison")?
                .into_iter()
                .filter(|cmp| cmp.first_id == id || cmp.second_id == id)
                .map(|cmp| cmp.id)
                .collect();
            comparison::schedule_regeneration(tx, &affected, |cid| {
                store::get(tx, "comparison", cid)?
                    .ok_or_else(|| anyhow::anyhow!("Comparison missing"))
            })?;
            Ok("saved")
        })
        .await?;
    match outcome {
        "stale" => Err(Error::conflict("Company changed; reload before saving.")),
        _ => Ok(Redirect::to(&format!("/terminal/companies/{destination}"))),
    }
}
#[derive(Deserialize)]
struct CompanyPrivacyForm {
    version: u64,
    acknowledgement: String,
}

/// Company privacy deletion: purges the company, its briefs, comparisons
/// touching it (and their reports), revision rows holding their bodies, and
/// terminal research/comparison Run snapshots. Other companies, meetings,
/// Tasks and unrelated history remain.
async fn company_privacy_delete(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<CompanyPrivacyForm>,
) -> Result<Redirect> {
    if form.acknowledgement != "DELETE" {
        return Err(Error::bad_request(
            "Type DELETE to acknowledge permanent removal.",
        ));
    }
    let deleted = app
        .db
        .transaction(move |tx| {
            let c: Company = store::get(tx, "company", &id)?
                .ok_or_else(|| anyhow::anyhow!("Company missing"))?;
            if c.version != form.version {
                return Ok(false);
            }
            let comparisons: Vec<comparison::Comparison> =
                store::list::<comparison::Comparison>(tx, "comparison")?
                    .into_iter()
                    .filter(|cmp| cmp.first_id == id || cmp.second_id == id)
                    .collect();
            let comparison_ids: std::collections::HashSet<String> =
                comparisons.iter().map(|cmp| cmp.id.clone()).collect();
            // Revision rows holding removed/moved brief and report bodies.
            let mut stmt = tx.prepare(
                "SELECT kind,id,body FROM revision WHERE kind IN ('company_brief','comparison_report')",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut purge = std::collections::HashSet::new();
            for (kind, record_id, body) in rows {
                let body: serde_json::Value = serde_json::from_str(&body)?;
                let belongs = match kind.as_str() {
                    "company_brief" => body["company_id"].as_str() == Some(id.as_str()),
                    "comparison_report" => {
                        body["comparison_id"]
                            .as_str()
                            .is_some_and(|cid| comparison_ids.contains(cid))
                    }
                    _ => false,
                };
                if belongs {
                    purge.insert((kind, record_id));
                }
            }
            for (kind, record_id) in purge {
                store::purge(tx, &kind, &record_id)?;
            }
            for cmp in &comparisons {
                store::purge(tx, "comparison", &cmp.id)?;
            }
            store::purge(tx, "company", &id)?;
            // Terminal Run snapshots referencing the company or its
            // comparisons. Meeting history and Tasks are untouched.
            let mut stmt =
                tx.prepare("SELECT id,input FROM job WHERE kind LIKE 'terminal.%'")?;
            let jobs = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (job_id, input) in jobs {
                let input: serde_json::Value = serde_json::from_str(&input)?;
                let belongs = input
                    .pointer("/company/id")
                    .and_then(serde_json::Value::as_str)
                    == Some(id.as_str())
                    || input["comparison_id"]
                        .as_str()
                        .is_some_and(|cid| comparison_ids.contains(cid))
                    || input["first_id"].as_str() == Some(id.as_str())
                    || input["second_id"].as_str() == Some(id.as_str());
                if belongs {
                    tx.execute("DELETE FROM job_attempt WHERE job_id=?1", [&job_id])?;
                    tx.execute("DELETE FROM job WHERE id=?1", [&job_id])?;
                }
            }
            Ok(true)
        })
        .await?;
    if !deleted {
        return Err(Error::conflict(
            "This company changed. Reload before deleting.",
        ));
    }
    Ok(Redirect::to("/terminal/companies"))
}
