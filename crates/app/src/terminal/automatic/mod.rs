//! Automatic Terminal workflows. Intake, evidence collection and publication
//! are separate durable stages: uncertain or failed work cannot replace a
//! person's identity or the last successful dossier.
mod archive;
mod intake;
pub(crate) mod privacy;
mod reports;
mod research;
mod views;

use crate::{App, people::Person, terminal::Company};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use intake::{candidate_action, refresh, resolve, submit};
pub use reports::{refresh_report, report_detail, request_report};
pub use views::{company_detail, homepage, person_detail};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Identity {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    pub linkedin: String,
    #[serde(default)]
    pub website: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub jurisdiction: String,
}

impl Identity {
    pub(super) fn clear_inapplicable_fields(&mut self) {
        if self.kind == "company" {
            self.company.clear();
            self.role.clear();
        } else if self.kind == "person" {
            self.jurisdiction.clear();
        }
    }

    pub fn label(&self) -> String {
        let context = if self.kind == "person" {
            [&self.role, &self.company, &self.email]
        } else {
            [&self.website, &self.jurisdiction, &self.phone]
        };
        std::iter::once(self.name.as_str())
            .chain(
                context
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .map(String::as_str),
            )
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reference {
    pub source_id: String,
    pub quote: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IdentityChoice {
    pub identity: Identity,
    pub existing_id: Option<String>,
    pub explanation: String,
    pub references: Vec<Reference>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub identity: Identity,
    pub target_id: Option<String>,
    pub expected_version: Option<u64>,
    pub status: String,
    pub phase: String,
    pub choices: Vec<IdentityChoice>,
    pub sources: Vec<crate::research::SourceRecord>,
    pub selected: Option<IdentityChoice>,
    pub run_id: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dossier {
    pub id: String,
    pub subject_id: String,
    pub identity: Identity,
    pub subject_version: u64,
    pub body: String,
    pub sources: Vec<crate::research::SourceRecord>,
    pub coverage: Vec<crate::research::CoverageRow>,
    pub frontier: Vec<crate::research::FrontierItem>,
    pub claims: Vec<crate::research::ClaimRecord>,
    pub limitations: Vec<String>,
    pub created_at: i64,
    pub run_id: String,
    pub employment_history: Vec<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Collection {
    identity: Identity,
    sources: Vec<crate::research::SourceRecord>,
    coverage: Vec<crate::research::CoverageRow>,
    frontier: Vec<crate::research::FrontierItem>,
    limitations: Vec<String>,
    created_at: i64,
    #[serde(default)]
    screened: bool,
    #[serde(default)]
    generation_started: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub id: String,
    pub identity: Identity,
    pub reason: String,
    pub references: Vec<Reference>,
    pub sources: Vec<crate::research::SourceRecord>,
    pub discovered_from: Vec<String>,
    pub dismissed: bool,
    pub request_id: Option<String>,
}

pub fn subject_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

pub fn profile_url(kind: &str, id: &str) -> String {
    format!(
        "/terminal/{}/{id}",
        if kind == "person" {
            "people"
        } else {
            "companies"
        }
    )
}

pub(crate) fn person_identity(p: &Person) -> Identity {
    Identity {
        kind: "person".into(),
        name: p.name.clone(),
        email: p.email.clone(),
        role: p.role.clone(),
        company: p.company.clone(),
        website: if p.profile_url.contains("linkedin.com/") {
            String::new()
        } else {
            p.profile_url.clone()
        },
        linkedin: if p.profile_url.contains("linkedin.com/") {
            p.profile_url.clone()
        } else {
            String::new()
        },
        ..Default::default()
    }
}

pub(crate) fn company_identity(c: &Company) -> Identity {
    Identity {
        kind: "company".into(),
        name: c.name.clone(),
        website: c.website.clone(),
        jurisdiction: c.jurisdiction.clone(),
        ..Default::default()
    }
}

pub(crate) async fn identities(
    app: &App,
    kind: &str,
) -> anyhow::Result<Vec<(String, Identity, u64)>> {
    let mut rows = if kind == "person" {
        app.db
            .list::<Person>("person")
            .await?
            .into_iter()
            .filter(|p| !p.archived && p.merged_into.is_none())
            .map(|p| (p.id.clone(), person_identity(&p), p.version))
            .collect::<Vec<_>>()
    } else {
        app.db
            .list::<Company>("company")
            .await?
            .into_iter()
            .map(|c| (c.id.clone(), company_identity(&c), c.version))
            .collect()
    };
    for (id, identity, _) in &mut rows {
        if let Some(saved) = app
            .db
            .get("terminal_identity", &subject_key(kind, id))
            .await?
        {
            *identity = saved;
        }
    }
    Ok(rows)
}

pub async fn execute(
    app: &crate::connection::RunScope,
    job: &crate::work::Job,
) -> anyhow::Result<Value> {
    if job.kind == "terminal.report" {
        return reports::execute(app, job).await;
    }
    research::execute(app, job).await
}

/// Old revision URLs resolve to the current profile once replaced; retaining
/// a source snapshot in SQLite does not make it a browsable history feature.
pub(crate) async fn revision_redirect(
    app: &App,
    kind: &str,
    subject: &str,
    revision: &str,
    record_kind: &str,
    id_field: &str,
) -> crate::web::Result<Option<axum::response::Response>> {
    use axum::response::IntoResponse;
    // Revision URLs are aliases for the canonical profile, including before
    // the first automatic refresh. Only that profile chooses the latest result.
    let _ = (app, revision, record_kind, id_field);
    Ok(Some(
        axum::response::Redirect::to(&profile_url(kind, subject)).into_response(),
    ))
}

pub(super) async fn latest_legacy(
    app: &App,
    kind: &str,
    subject: &str,
) -> anyhow::Result<Option<(String, Value)>> {
    let kinds: &[&str] = if kind == "person" {
        &["person_brief", "dossier"]
    } else {
        &["company_brief"]
    };
    let id_field = if kind == "person" {
        "person_id"
    } else {
        "company_id"
    };
    let mut results = Vec::new();
    for record_kind in kinds {
        results.extend(
            app.db
                .list::<Value>(record_kind)
                .await?
                .into_iter()
                .filter(|v| v[id_field].as_str() == Some(subject))
                .map(|v| ((*record_kind).to_owned(), v)),
        );
    }
    Ok(results.into_iter().max_by_key(|(kind, v)| {
        (
            v["created_at"].as_i64().unwrap_or_default(),
            v["id"].as_str().unwrap_or_default().to_owned(),
            kind.clone(),
        )
    }))
}
