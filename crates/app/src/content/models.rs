//! Durable records and publication contracts.
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const TARGETS: [&str; 9] = [
    "linkedin-standard-post",
    "linkedin-carousel",
    "linkedin-long-article",
    "website-blog-article",
    "email-newsletter",
    "youtube-short",
    "youtube-long-video",
    "instagram-reel",
    "tiktok-video",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Brand {
    pub revision: u64,
    pub name: String,
    pub audience: String,
    pub voice: String,
    pub boundaries: String,
    pub evidence: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub label: String,
    pub url: String,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub text: String,
    pub observed_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Opportunity {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub angle: String,
    pub evidence: Vec<Evidence>,
    pub brand: Brand,
    pub state: String,
    pub project_id: Option<String>,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    #[serde(default)]
    pub outline_id: Option<String>,
    pub stage: String,
    pub body: String,
    pub source_ids: Vec<String>,
    pub unsupported_claims: Vec<String>,
    pub created_at: String,
    pub approved_at: Option<String>,
    pub model: String,
    #[serde(default)]
    pub search_coverage: Option<crate::integrations::SearchCoverage>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Revision {
    pub number: u64,
    pub subject: String,
    pub objective: String,
    pub audience: String,
    pub target: String,
    pub material: String,
    pub evidence: Vec<Evidence>,
    pub brand: Option<Brand>,
    pub evidence_reviewed: bool,
    pub artifacts: Vec<Artifact>,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub opportunity_id: Option<String>,
    pub revisions: Vec<Revision>,
    pub created_at: String,
}
impl Project {
    pub fn current(&self) -> &Revision {
        self.revisions.last().expect("project has a revision")
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Watch {
    pub id: String,
    pub name: String,
    pub query: String,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub watch_id: String,
    pub person_name: String,
    pub evidence: Vec<Evidence>,
    pub artifact: Artifact,
    pub created_at: String,
    #[serde(default)]
    pub search_coverage: Option<crate::integrations::SearchCoverage>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub title: String,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub id: String,
    pub channel_id: String,
    pub measured_at: String,
    pub data: Value,
}
