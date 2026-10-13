use super::*;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub starts_at: String,
    pub attendees: String,
    pub purpose: String,
    pub notes: String,
    pub state: String,
    pub calendar_event_id: Option<String>,
    pub revision: u64,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transcript {
    pub id: String,
    pub title: String,
    pub text: String,
    pub meeting_id: Option<String>,
    pub association: String,
    pub source_url: Option<String>,
    pub source_id: Option<String>,
    pub revision: u64,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProposedAction {
    pub id: String,
    pub title: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    #[serde(default)]
    pub evidence_item_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub meeting_id: String,
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub debrief: Option<super::debrief::Debrief>,
    pub actions: Vec<ProposedAction>,
    pub approved_action_ids: Vec<String>,
    pub reviewed: bool,
    pub meeting_revision: u64,
    pub transcript_revisions: Vec<(String, u64)>,
    #[serde(default)]
    pub context_sources: Vec<ContextSource>,
    pub provider: String,
    pub created_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextSource {
    pub kind: String,
    pub id: String,
    pub body: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeeklyReview {
    pub id: String,
    pub body: String,
    pub from: String,
    pub to: String,
    pub meeting_ids: Vec<String>,
    pub provider: String,
    pub created_at: i64,
}
#[derive(Clone, Deserialize)]
pub struct MeetingInput {
    pub title: String,
    pub starts_at: String,
    #[serde(default)]
    pub attendees: String,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub revision: Option<u64>,
}
