//! Local tasks and reviewed meeting actions. Remote delivery never owns local work.
use crate::{
    App,
    db::Db,
    store,
    web::{self, Error, Result, escape, required},
    work,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub owner: String,
    pub priority: String,
    pub due: Option<String>,
    pub status: String,
    pub list_id: Option<String>,
    pub trashed: bool,
    pub version: u64,
    pub source: Option<ActionItem>,
    pub links: Vec<ExternalLink>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalLink {
    pub provider: String,
    pub container: String,
    pub remote_id: Option<String>,
    pub state: String,
    pub error: Option<String>,
    pub synced_version: Option<u64>,
    #[serde(default)]
    pub google_binding: Option<crate::integrations::GoogleBinding>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskList {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub id: String,
    pub meeting_id: String,
    pub source_id: String,
    pub title: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub context: String,
    pub state: String,
    pub task_id: Option<String>,
    pub created_at: i64,
}

pub async fn propose(
    db: &Db,
    meeting_id: &str,
    source_id: &str,
    title: &str,
    owner: Option<String>,
    due: Option<String>,
    context: &str,
) -> anyhow::Result<ActionItem> {
    anyhow::ensure!(
        !title.trim().is_empty() && title.len() <= 500,
        "Action title must contain 1–500 bytes"
    );
    if let Some(date) = due.as_deref() {
        validate_date(date).map_err(|e| anyhow::anyhow!(e.message))?;
    }
    let (meeting_id, source_id, title, context) = (
        meeting_id.to_owned(),
        source_id.to_owned(),
        title.trim().to_owned(),
        context.to_owned(),
    );
    db.transaction(move |tx| propose_in(tx, &meeting_id, &source_id, &title, owner, due, &context))
        .await
}
pub fn propose_in(
    conn: &rusqlite::Connection,
    meeting_id: &str,
    source_id: &str,
    title: &str,
    owner: Option<String>,
    due: Option<String>,
    context: &str,
) -> anyhow::Result<ActionItem> {
    anyhow::ensure!(
        !title.trim().is_empty() && title.len() <= 500,
        "Action title must contain 1–500 bytes"
    );
    if let Some(date) = due.as_deref() {
        validate_date(date).map_err(|e| anyhow::anyhow!(e.message))?;
    }
    if let Some(existing) = store::list::<ActionItem>(conn, "action")?
        .into_iter()
        .find(|a| {
            a.meeting_id == meeting_id
                && a.source_id == source_id
                && a.title.to_lowercase() == title.trim().to_lowercase()
        })
    {
        return Ok(existing);
    }
    let action = ActionItem {
        id: Uuid::new_v4().to_string(),
        meeting_id: meeting_id.to_owned(),
        source_id: source_id.to_owned(),
        title: title.trim().to_owned(),
        owner,
        due,
        context: context.to_owned(),
        state: "pending".into(),
        task_id: None,
        created_at: crate::now_ms(),
    };
    store::put(conn, "action", &action.id, &action)?;
    Ok(action)
}

/// Acceptance is atomic and idempotent even when two requests arrive together.
pub async fn accept(db: &Db, id: &str) -> anyhow::Result<Task> {
    let id = id.to_owned();
    db.transaction(move |tx| {
        let mut action: ActionItem = store::get(tx, "action", &id)?
            .ok_or_else(|| anyhow::anyhow!("Action item not found"))?;
        if let Some(task_id) = &action.task_id {
            return store::get(tx, "task", task_id)?
                .ok_or_else(|| anyhow::anyhow!("Linked task missing"));
        }
        anyhow::ensure!(
            action.state == "pending",
            "Only pending actions may be accepted; undo dismissal first"
        );
        let mut task = new_task(action.title.clone());
        task.owner = action.owner.clone().unwrap_or_default();
        task.due = action.due.clone();
        task.notes = action.context.clone();
        action.state = "accepted".into();
        action.task_id = Some(task.id.clone());
        task.source = Some(action.clone());
        store::put(tx, "task", &task.id, &task)?;
        store::put(tx, "action", &action.id, &action)?;
        Ok(task)
    })
    .await
}
fn new_task(title: String) -> Task {
    let now = crate::now_ms();
    Task {
        id: Uuid::new_v4().to_string(),
        title,
        notes: String::new(),
        owner: String::new(),
        priority: "normal".into(),
        due: None,
        status: "open".into(),
        list_id: None,
        trashed: false,
        version: 1,
        source: None,
        links: Vec::new(),
        created_at: now,
        updated_at: now,
    }
}
fn validate_date(date: &str) -> Result<()> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| Error::bad_request("Due date must use YYYY-MM-DD."))?;
    Ok(())
}
pub(super) fn optional_date(date: &str) -> Result<Option<String>> {
    if date.trim().is_empty() {
        Ok(None)
    } else {
        validate_date(date)?;
        Ok(Some(date.to_owned()))
    }
}

mod execution;
mod routes;

pub use execution::execute;
pub use routes::router;
