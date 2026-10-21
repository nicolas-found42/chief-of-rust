//! Local tasks and reviewed meeting actions. Remote delivery never owns local work.
use crate::{
    App,
    db::Db,
    store,
    web::{self, Error, Result, escape, required},
    work,
};
use axum::{
    Router,
    extract::{Form, Path, Query, State},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
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
fn optional_date(date: &str) -> Result<Option<String>> {
    if date.trim().is_empty() {
        Ok(None)
    } else {
        validate_date(date)?;
        Ok(Some(date.to_owned()))
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/tasks", get(index).post(create))
        .route("/tasks/lists", post(create_list))
        .route("/tasks/{id}", get(detail).post(edit))
        .route("/tasks/{id}/trash", post(trash))
        .route("/tasks/{id}/complete", post(complete))
        .route("/tasks/{id}/restore", post(restore))
        .route("/tasks/{id}/link", post(link))
        .route("/tasks/{id}/unlink", post(unlink))
        .route("/tasks/{id}/reconcile", post(reconcile))
        .route("/tasks/{id}/resolve-absent", post(resolve_absent))
        .route("/actions/{id}/{decision}", post(decide))
}
#[derive(Default, Deserialize)]
struct Filters {
    #[serde(default)]
    q: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    list: String,
    #[serde(default)]
    trash: String,
}
async fn index(State(app): State<App>, Query(filter): Query<Filters>) -> Result<Response> {
    let mut tasks = app.db().list::<Task>("task").await?;
    tasks.retain(|t| {
        t.trashed == (filter.trash == "true")
            && (filter.status.is_empty() || t.status == filter.status)
            && (filter.list.is_empty() || t.list_id.as_deref() == Some(&filter.list))
            && (filter.q.is_empty()
                || format!("{} {} {}", t.title, t.notes, t.owner)
                    .to_lowercase()
                    .contains(&filter.q.to_lowercase()))
    });
    tasks.sort_by(|a, b| {
        a.status
            .cmp(&b.status)
            .then_with(|| {
                a.due
                    .as_deref()
                    .unwrap_or("9999")
                    .cmp(b.due.as_deref().unwrap_or("9999"))
            })
            .then(b.updated_at.cmp(&a.updated_at))
    });
    let lists = app.db().list::<TaskList>("task_list").await?;
    let mut body = format!(
        "<h1>Tasks{}</h1><p>Your local work, with reviewed meeting actions and optional external delivery.</p><form class=\"cds-toolbar\" method=\"get\">{}<label>Search <input name=\"q\" value=\"{}\"></label><label>Status <select name=\"status\">{} </select></label><label>List <select name=\"list\"><option value=\"\">All lists</option>{}</select></label><button class=\"cds-btn cds-btn--secondary\">Filter</button></form><p><a href=\"/tasks\">Active tasks</a> · <a href=\"/tasks?trash=true\">Trash</a></p>",
        if filter.trash == "true" {
            " · Trash"
        } else {
            ""
        },
        if filter.trash == "true" {
            "<input type=\"hidden\" name=\"trash\" value=\"true\">"
        } else {
            ""
        },
        escape(&filter.q),
        web::value_options(["", "open", "in_progress", "done"], &filter.status, "Any"),
        web::options(
            lists.iter().map(|l| (l.id.as_str(), escape(&l.name))),
            &filter.list
        )
    );
    if filter.trash != "true" {
        body.push_str("<section class=\"cds-section\"><h2>Capture a task</h2><form class=\"cds-toolbar\" method=\"post\" action=\"/tasks\"><label>Title <input name=\"title\" required maxlength=\"500\"></label><button class=\"cds-btn cds-btn--primary\">Add task</button></form></section>");
        let actions = app.db().list::<ActionItem>("action").await?;
        let pending = actions.iter().filter(|a| a.state == "pending").count();
        body.push_str(&format!(
            "<section class=\"cds-section\" id=\"meeting-actions\"><h2>Meeting actions to review {}</h2>",
            web::badge(&web::pluralize(
                pending,
                "pending proposal",
                "pending proposals"
            ))
        ));
        for a in actions.iter().filter(|a| a.state != "accepted") {
            body.push_str(&format!("<article class=\"cds-card\"><h3>{}</h3><details><summary>Source context and deadline notes</summary><p class=\"cds-pre-wrap\">{}</p></details><p><a href=\"/meetings/{}\">Source meeting</a> · {}</p><form class=\"cds-inline-form\" method=\"post\" action=\"/actions/{}/{}\"><button class=\"{}\">{}</button></form>{}</article>",escape(&a.title),escape(&a.context),escape(&a.meeting_id),web::badge(&a.state),a.id,if a.state=="dismissed"{"undo"}else{"accept"},if a.state=="dismissed"{"cds-btn cds-btn--secondary"}else{"cds-btn cds-btn--primary"},if a.state=="dismissed"{"Undo dismissal"}else{"Accept into Tasks"},if a.state=="pending"{format!("<form class=\"cds-inline-form\" method=\"post\" action=\"/actions/{}/dismiss\"><button class=\"cds-btn cds-btn--secondary\">Dismiss</button></form>",a.id)}else{String::new()}));
        }
        if pending == 0 {
            body.push_str("<p class=\"cds-empty\">No pending meeting actions.</p>");
        }
        body.push_str("</section>");
    }
    body.push_str(if filter.trash == "true" {
        "<section class=\"cds-section\"><h2>Trash</h2>"
    } else {
        "<section class=\"cds-section\"><h2>Task list</h2>"
    });
    if tasks.is_empty() {
        body.push_str("<p class=\"cds-empty\">No tasks match this view.</p>");
    }
    for t in tasks {
        body.push_str(&format!(
            "<article class=\"cds-card\"><h3><a href=\"/tasks/{}\">{}</a></h3><p>{} · {} priority · Due {} · {}</p>",
            t.id,
            escape(&t.title),
            web::badge(&t.status),
            escape(&web::display_label(&t.priority)),
            escape(t.due.as_deref().unwrap_or("not set")),
            escape(&t.owner)
        ));
        if t.trashed {
            body.push_str(&format!("<form class=\"cds-inline-form\" method=\"post\" action=\"/tasks/{}/restore\"><button class=\"cds-btn cds-btn--secondary\">Restore task</button></form>",t.id));
        } else {
            body.push_str(&format!("<form class=\"cds-inline-form\" method=\"post\" action=\"/tasks/{}/complete\"><input type=\"hidden\" name=\"version\" value=\"{}\"><input type=\"hidden\" name=\"status\" value=\"{}\"><button class=\"cds-btn cds-btn--secondary\">{}</button></form>",t.id,t.version,if t.status=="done"{"open"}else{"done"},if t.status=="done"{"Reopen task"}else{"Mark done"}));
        }
        body.push_str("</article>");
    }
    body.push_str("</section>");
    if filter.trash != "true" {
        body.push_str("<details><summary>Create a list</summary><form class=\"cds-form\" method=\"post\" action=\"/tasks/lists\"><label>Name <input name=\"name\" required maxlength=\"120\"></label><button class=\"cds-btn cds-btn--primary\">Create list</button></form></details>");
    }
    Ok(web::page("Tasks", web::Body::with_heading(body)))
}
#[derive(Deserialize)]
struct Capture {
    title: String,
}
async fn create(State(app): State<App>, Form(form): Form<Capture>) -> Result<Redirect> {
    let task = new_task(required(&form.title, "Title", 500)?);
    let id = task.id.clone();
    app.db().put("task", &id, task).await?;
    Ok(Redirect::to(&format!("/tasks/{id}")))
}
#[derive(Deserialize)]
struct ListForm {
    name: String,
}
async fn create_list(State(app): State<App>, Form(form): Form<ListForm>) -> Result<Redirect> {
    let name = required(&form.name, "List name", 120)?;
    let id = Uuid::new_v4().to_string();
    app.db()
        .put(
            "task_list",
            &id,
            TaskList {
                id: id.clone(),
                name,
            },
        )
        .await?;
    Ok(Redirect::to(&format!("/tasks?list={id}")))
}
async fn task(app: &App, id: &str) -> Result<Task> {
    app.db()
        .get("task", id)
        .await?
        .ok_or_else(|| Error::not_found("Task not found."))
}
async fn detail(State(app): State<App>, Path(id): Path<String>) -> Result<Response> {
    let t = task(&app, &id).await?;
    render_task(&app, t, None, None).await
}
async fn render_task(
    app: &App,
    t: Task,
    submitted: Option<&Edit>,
    error: Option<&str>,
) -> Result<Response> {
    let lists = app.db().list::<TaskList>("task_list").await?;
    let defaults = Edit::from(&t);
    let form = submitted.unwrap_or(&defaults);
    let alert = error.map(|message| format!("<p role=\"alert\">{} Your edits are kept below.</p><p><a href=\"/tasks/{}\">Reload saved task</a></p>", escape(message), t.id)).unwrap_or_default();
    let date_type = if optional_date(&form.due).is_ok() {
        "date"
    } else {
        "text"
    };
    let mut body = format!(
        "<h1>{}</h1>{alert}<form class=\"cds-form\" method=\"post\"><input type=\"hidden\" name=\"version\" value=\"{}\"><label>Title <input name=\"title\" required maxlength=\"500\" value=\"{}\"></label><label>Notes <textarea name=\"notes\" maxlength=\"20000\">{}</textarea></label><label>Owner <input name=\"owner\" value=\"{}\" maxlength=\"200\"></label><label>Due <input type=\"{date_type}\" name=\"due\" value=\"{}\"></label><label>Priority <select name=\"priority\">{}</select></label><label>Status <select name=\"status\">{}</select></label><label>List <select name=\"list_id\"><option value=\"\">No list</option>{}</select></label><button class=\"cds-btn cds-btn--primary\">Save task</button></form><form class=\"cds-form\" method=\"post\" action=\"/tasks/{}/{}\"><button class=\"{}\">{}</button></form>",
        escape(&t.title),
        form.version,
        escape(&form.title),
        escape(&form.notes),
        escape(&form.owner),
        escape(&form.due),
        web::value_options(["low", "normal", "high", "urgent"], &form.priority, ""),
        web::value_options(["open", "in_progress", "done"], &form.status, ""),
        web::options(
            lists.iter().map(|l| (l.id.as_str(), escape(&l.name))),
            &form.list_id
        ),
        t.id,
        if t.trashed { "restore" } else { "trash" },
        web::carbon_button_class(if t.trashed {
            "Restore task"
        } else {
            "Move to trash"
        }),
        if t.trashed {
            "Restore task"
        } else {
            "Move to trash"
        }
    );
    if let Some(source) = t.source {
        body.push_str(&format!("<section class=\"cds-section\"><h2>Source action snapshot</h2><p>{}</p><p>{}</p><a href=\"/meetings/{}\">Source meeting</a></section>",escape(&source.title),escape(&source.context),escape(&source.meeting_id)));
    }
    body.push_str("<section class=\"cds-section\"><h2>External delivery</h2><p>Link to Google Tasks or Asana. Ambiguous creates require reconciliation before retrying, so a timeout cannot create duplicate work.</p>");
    for l in &t.links {
        body.push_str(&format!(
            "<article class=\"cds-card\"><p>{}: {} · remote {} · synced version {}</p><p>{}</p></article>",
            escape(&l.provider),
            web::badge(&l.state),
            escape(l.remote_id.as_deref().unwrap_or("unknown")),
            l.synced_version.map(|v| v.to_string()).unwrap_or_default(),
            escape(l.error.as_deref().unwrap_or(""))
        ));
        if l.state != "uncertain" {
            body.push_str(&format!("<form class=\"cds-form\" method=\"post\" action=\"/tasks/{}/unlink\"><input type=\"hidden\" name=\"provider\" value=\"{}\"><input type=\"hidden\" name=\"version\" value=\"{}\"><p>Unlinking archives this local association and leaves the remote copy untouched. A later delivery creates a separate external copy.</p><button class=\"cds-btn cds-btn--secondary\">Unlink external copy</button></form>",t.id,escape(&l.provider),t.version));
        }
    }
    body.push_str("<form class=\"cds-form\" method=\"post\" action=\"/tasks/");
    body.push_str(&t.id);
    body.push_str("/link\"><label>Provider <select name=\"provider\"><option value=\"google\">Google Tasks</option><option value=\"asana\">Asana</option></select></label><label>Container ID (Google task list or Asana project) <input name=\"container\" required></label><button class=\"cds-btn cds-btn--primary\">Deliver current task</button></form>");
    for delivery in t.links.iter().filter(|l| l.state == "uncertain") {
        body.push_str(&format!("<section class=\"cds-section\"><h3>Reconcile {} delivery</h3><form class=\"cds-form\" method=\"post\" action=\"/tasks/{}/reconcile\"><input type=\"hidden\" name=\"provider\" value=\"{}\"><label>Remote task ID found after checking provider <input name=\"remote_id\" required></label><button class=\"cds-btn cds-btn--primary\">Attach verified existing remote task</button></form><form class=\"cds-form\" method=\"post\" action=\"/tasks/{}/resolve-absent\"><input type=\"hidden\" name=\"provider\" value=\"{}\"><label>How you checked the remote outcome <input name=\"note\" required maxlength=\"1000\"></label><label><input type=\"checkbox\" name=\"confirmed\" value=\"true\" required>I checked the provider and confirm no task was created.</label><button class=\"cds-btn cds-btn--secondary\">Record absence and allow a fresh delivery</button></form></section>",escape(&web::display_label(&delivery.provider)),t.id,escape(&delivery.provider),t.id,escape(&delivery.provider)));
    }
    let archived = app.db().list::<Value>("task_unlinked_copy").await?;
    for copy in archived.iter().filter(|copy| copy["task_id"] == t.id) {
        body.push_str(&format!("<details><summary>Previously unlinked {} copy</summary><p>Remote ID: {}. The remote copy was left untouched.</p><pre>{}</pre></details>",escape(copy["link"]["provider"].as_str().unwrap_or("external")),escape(copy["link"]["remote_id"].as_str().unwrap_or("unknown")),escape(&serde_json::to_string_pretty(copy).unwrap_or_default())));
    }
    body.push_str("</section><a href=\"/tasks\">All tasks</a>");
    Ok(web::page(&t.title, web::Body::with_heading(body)))
}
#[derive(Clone, Deserialize)]
struct Edit {
    version: u64,
    title: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    due: String,
    priority: String,
    status: String,
    #[serde(default)]
    list_id: String,
}
impl From<&Task> for Edit {
    fn from(task: &Task) -> Self {
        Self {
            version: task.version,
            title: task.title.clone(),
            notes: task.notes.clone(),
            owner: task.owner.clone(),
            due: task.due.clone().unwrap_or_default(),
            priority: task.priority.clone(),
            status: task.status.clone(),
            list_id: task.list_id.clone().unwrap_or_default(),
        }
    }
}
impl Edit {
    fn validate(&self) -> Result<(String, Option<String>)> {
        let title = required(&self.title, "Title", 500)?;
        let due = optional_date(&self.due)?;
        if !["low", "normal", "high", "urgent"].contains(&self.priority.as_str())
            || !["open", "in_progress", "done"].contains(&self.status.as_str())
            || self.notes.len() > 20000
            || self.owner.len() > 200
        {
            return Err(Error::bad_request(
                "Check task priority, status, and the length of notes and owner.",
            ));
        }
        Ok((title, due))
    }
}

async fn edit(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<Edit>,
) -> Result<Response> {
    let (title, due) = match form.validate() {
        Ok(values) => values,
        Err(error) => {
            let saved = task(&app, &id).await?;
            let page = render_task(&app, saved, Some(&form), Some(&error.message)).await?;
            return Ok((error.status, page).into_response());
        }
    };
    let destination = id.clone();
    let submitted = form.clone();
    let outcome = app
        .db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            if t.version != form.version {
                return Ok(false);
            }
            if !form.list_id.is_empty() {
                anyhow::ensure!(
                    store::get::<TaskList>(tx, "task_list", &form.list_id)?.is_some(),
                    "List not found"
                );
            }
            t.title = title;
            t.due = due;
            t.notes = form.notes;
            t.owner = form.owner;
            t.priority = form.priority;
            t.status = form.status;
            t.list_id = if form.list_id.is_empty() {
                None
            } else {
                Some(form.list_id)
            };
            t.version += 1;
            t.updated_at = crate::now_ms();
            store::put(tx, "task", &id, &t)?;
            Ok(true)
        })
        .await?;
    if !outcome {
        let saved = task(&app, &destination).await?;
        let page = render_task(&app, saved, Some(&submitted), Some("This task changed since you opened it. Copy your edits before reloading the saved task. Reload before saving.")).await?;
        return Ok((axum::http::StatusCode::CONFLICT, page).into_response());
    }
    Ok(Redirect::to(&format!("/tasks/{destination}")).into_response())
}

#[derive(Deserialize)]
struct Completion {
    version: u64,
    status: String,
}
async fn complete(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<Completion>,
) -> Result<Redirect> {
    if !["open", "done"].contains(&form.status.as_str()) {
        return Err(Error::bad_request("Choose open or done."));
    }
    let changed = app
        .db()
        .transaction(move |tx| {
            let mut task: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            if task.version != form.version || task.trashed {
                return Ok(false);
            }
            task.status = form.status;
            task.version += 1;
            task.updated_at = crate::now_ms();
            store::put(tx, "task", &id, &task)?;
            Ok(true)
        })
        .await?;
    if !changed {
        return Err(Error::conflict(
            "Task changed; reload before completing it.",
        ));
    }
    Ok(Redirect::to("/tasks"))
}

async fn set_trash(app: &App, id: String, trashed: bool) -> Result<Redirect> {
    let destination = id.clone();
    app.db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            t.trashed = trashed;
            t.version += 1;
            t.updated_at = crate::now_ms();
            store::put(tx, "task", &id, &t)
        })
        .await?;
    Ok(Redirect::to(&format!("/tasks/{destination}")))
}
async fn trash(State(app): State<App>, Path(id): Path<String>) -> Result<Redirect> {
    set_trash(&app, id, true).await
}
async fn restore(State(app): State<App>, Path(id): Path<String>) -> Result<Redirect> {
    set_trash(&app, id, false).await
}
async fn decide(
    State(app): State<App>,
    Path((id, decision)): Path<(String, String)>,
) -> Result<Redirect> {
    if app.db().get::<ActionItem>("action", &id).await?.is_none() {
        return Err(Error::not_found("Action item not found."));
    }
    if decision == "accept" {
        let t = accept(app.db(), &id)
            .await
            .map_err(|e| Error::conflict(e.to_string()))?;
        return Ok(Redirect::to(&format!("/tasks/{}", t.id)));
    }
    if !["dismiss", "undo"].contains(&decision.as_str()) {
        return Err(Error::bad_request("Unknown action decision."));
    }
    let changed = app
        .db()
        .transaction(move |tx| {
            let mut a: ActionItem =
                store::get(tx, "action", &id)?.ok_or_else(|| anyhow::anyhow!("Action missing"))?;
            if a.state == "accepted" {
                return Ok(false);
            }
            a.state = if decision == "dismiss" {
                "dismissed"
            } else {
                "pending"
            }
            .into();
            store::put(tx, "action", &id, &a)?;
            Ok(true)
        })
        .await?;
    if !changed {
        return Err(Error::conflict("Accepted actions are managed as Tasks."));
    }
    Ok(Redirect::to("/tasks"))
}
#[derive(Deserialize)]
struct LinkForm {
    provider: String,
    container: String,
}
#[derive(Deserialize)]
struct UnlinkForm {
    provider: String,
    version: u64,
}
async fn unlink(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<UnlinkForm>,
) -> Result<Redirect> {
    if !["google", "asana"].contains(&form.provider.as_str()) {
        return Err(Error::bad_request("Unknown provider."));
    }
    let destination = id.clone();
    app.db().transaction(move |tx| {
        let mut task: Task = store::get(tx,"task",&id)?.ok_or_else(|| anyhow::anyhow!("Task not found"))?;
        anyhow::ensure!(task.version == form.version, "Task changed; reload before unlinking");
        let index = task.links.iter().position(|link|link.provider == form.provider).ok_or_else(|| anyhow::anyhow!("External link no longer exists"))?;
        anyhow::ensure!(task.links[index].state != "uncertain", "Reconcile the uncertain remote outcome before unlinking");
        let running:bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM job WHERE kind='tasks.sync' AND status='running' AND json_extract(input,'$.task.id')=?1 AND json_extract(input,'$.provider')=?2)", rusqlite::params![id,form.provider], |row|row.get(0))?;
        anyhow::ensure!(!running, "Delivery is running; wait for its outcome before unlinking");
        let removed = task.links.remove(index);
        let archived = json!({"task_id":id,"link":removed,"task_version":task.version,"unlinked_at":crate::now_ms(),"remote_effect":"none; remote copy retained"});
        store::put(tx,"task_unlinked_copy",&Uuid::new_v4().to_string(),&archived)?;
        task.version += 1;
        task.updated_at = crate::now_ms();
        store::put(tx,"task",&id,&task)
    }).await.map_err(|error|Error::conflict(error.to_string()))?;
    Ok(Redirect::to(&format!("/tasks/{destination}")))
}
async fn link(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<LinkForm>,
) -> Result<Redirect> {
    if !["google", "asana"].contains(&form.provider.as_str()) {
        return Err(Error::bad_request("Unknown provider."));
    }
    let container = required(&form.container, "Container ID", 200)?;
    let t = task(&app, &id).await?;
    if t.trashed {
        return Err(Error::conflict(
            "Restore the task before external delivery.",
        ));
    }
    if t.links
        .iter()
        .any(|l| l.provider == form.provider && l.state == "uncertain")
    {
        return Err(Error::conflict(
            "Check the provider and reconcile the previous create before retrying.",
        ));
    }
    let job = work::enqueue(
        app.db(),
        "tasks.sync",
        &format!("{}:{}:{}:{}", id, form.provider, container, t.version),
        json!({"task":t,"provider":form.provider,"container":container}),
    )
    .await?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}
#[derive(Deserialize)]
struct ReconcileForm {
    provider: String,
    remote_id: String,
}
async fn reconcile(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<ReconcileForm>,
) -> Result<Redirect> {
    let remote_id = required(&form.remote_id, "Remote task ID", 200)?;
    let current = task(&app, &id).await?;
    let pending = current
        .links
        .iter()
        .find(|l| l.provider == form.provider && l.state == "uncertain")
        .ok_or_else(|| Error::conflict("No uncertain create to reconcile."))?;
    let remote = if form.provider == "google" {
        let original = pending.google_binding.clone().ok_or_else(|| Error::conflict("This Google link has no recorded account; resolve its outcome in the original account before creating fresh delivery."))?;
        let binding = app.db().transaction(move |tx| {
            let current = crate::integrations::GoogleBinding::load(tx)?;
            anyhow::ensure!(current.subject.is_some() && current.subject == original.subject, "Reconnect the Google account that owns this uncertain task before reconciling it");
            Ok(current)
        }).await?;
        crate::integrations::GOOGLE_RUN_BINDING
            .scope(
                Some(binding),
                crate::integrations::google_get(
                    &app,
                    &format!(
                        "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks/{}",
                        segment(&pending.container),
                        segment(&remote_id)
                    ),
                    &[],
                ),
            )
            .await?
    } else {
        crate::integrations::asana_get(
            &app,
            &format!(
                "https://app.asana.com/api/1.0/tasks/{}",
                segment(&remote_id)
            ),
            &[],
        )
        .await?
    };
    if remote
        .get("id")
        .or_else(|| remote.pointer("/data/gid"))
        .and_then(Value::as_str)
        != Some(&remote_id)
    {
        return Err(Error::bad_request(
            "Remote task lookup did not return a record.",
        ));
    }
    let destination = id.clone();
    app.db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            let link = t
                .links
                .iter_mut()
                .find(|l| l.provider == form.provider && l.state == "uncertain")
                .ok_or_else(|| anyhow::anyhow!("Uncertain link changed"))?;
            link.remote_id = Some(remote_id);
            link.state = "linked".into();
            link.error = None;
            store::put(tx, "task", &id, &t)
        })
        .await?;
    Ok(Redirect::to(&format!("/tasks/{destination}")))
}
#[derive(Deserialize)]
struct AbsentForm {
    provider: String,
    note: String,
    #[serde(default)]
    confirmed: String,
}
async fn resolve_absent(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<AbsentForm>,
) -> Result<Redirect> {
    if form.confirmed != "true" {
        return Err(Error::bad_request(
            "Confirm the remote absence after checking the provider.",
        ));
    }
    let note = required(&form.note, "Resolution note", 1000)?;
    let destination = id.clone();
    let resolved = app
        .db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            let Some(link) = t
                .links
                .iter_mut()
                .find(|l| l.provider == form.provider && l.state == "uncertain")
            else {
                return Ok(false);
            };
            link.state = "resolved_absent".into();
            link.error = Some(format!("User verified no remote creation: {note}"));
            t.version += 1;
            t.updated_at = crate::now_ms();
            store::put(tx, "task", &id, &t)?;
            Ok(true)
        })
        .await?;
    if !resolved {
        return Err(Error::conflict("No uncertain create remains to resolve."));
    }
    Ok(Redirect::to(&format!("/tasks/{destination}")))
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
/// A durable uncertainty marker is written before remote create; crashes and
/// network timeouts cannot silently retry an ambiguous create.
pub async fn execute(app: &App, job: &work::Job) -> anyhow::Result<Value> {
    let snapshot: Task = serde_json::from_value(job.input["task"].clone())?;
    let provider = job.input["provider"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Provider missing"))?
        .to_owned();
    let container = job.input["container"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Container missing"))?
        .to_owned();
    if provider == "google" {
        anyhow::ensure!(
            snapshot.notes.chars().count() <= 8192,
            "Google Tasks notes support at most 8192 characters; shorten the local notes before delivery"
        );
    }
    let current = app
        .db()
        .get::<Task>("task", &snapshot.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Task missing"))?;
    anyhow::ensure!(
        !current.trashed && current.version == snapshot.version,
        "Task changed before remote delivery; enqueue again"
    );
    anyhow::ensure!(
        !current
            .links
            .iter()
            .any(|l| l.provider == provider && l.state == "uncertain"),
        "Previous remote create needs reconciliation"
    );
    let google_binding = if provider == "google" {
        Some(
            serde_json::from_value::<crate::integrations::GoogleBinding>(
                job.input["_google_binding"].clone(),
            )?,
        )
    } else {
        None
    };
    let delivery_binding = google_binding.clone();
    if let Some(binding) = &google_binding
        && let Some(link) = current.links.iter().find(|link| link.provider == "google")
    {
        anyhow::ensure!(
            binding.subject.is_some()
                && link
                    .google_binding
                    .as_ref()
                    .and_then(|b| b.subject.as_ref())
                    == binding.subject.as_ref(),
            "Task link belongs to another Google account; reconnect its owner before delivery"
        );
    }
    // Read-only preflight keeps missing credentials and container failures
    // retryable before any create can reach the provider.
    if provider == "google" {
        crate::integrations::google_get(
            app,
            &format!(
                "https://tasks.googleapis.com/tasks/v1/users/@me/lists/{}",
                segment(&container)
            ),
            &[],
        )
        .await?;
    } else if provider == "asana" {
        crate::integrations::asana_get(
            app,
            &format!(
                "https://app.asana.com/api/1.0/projects/{}",
                segment(&container)
            ),
            &[],
        )
        .await?;
    } else {
        anyhow::bail!("Unknown task provider");
    }
    let id = snapshot.id.clone();
    let p = provider.clone();
    let c = container.clone();
    let version = snapshot.version;
    let remote_id = app
        .db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            anyhow::ensure!(
                !t.trashed && t.version == version,
                "Task changed before remote delivery; enqueue again"
            );
            if let Some(l) = t.links.iter_mut().find(|l| l.provider == p) {
                anyhow::ensure!(l.container == c, "Task already links to another container");
                anyhow::ensure!(p != "google" || l.google_binding.as_ref().and_then(|b| b.subject.as_ref()) == google_binding.as_ref().and_then(|b| b.subject.as_ref()),
                    "Task link belongs to another Google connection; resolve work in the original account before delivering a new local task");
                anyhow::ensure!(
                    l.state != "uncertain",
                    "Previous remote create needs reconciliation"
                );
                if l.synced_version == Some(version) {
                    return Ok(Some((l.remote_id.clone(), true)));
                }
                if l.remote_id.is_some() {
                    return Ok(Some((l.remote_id.clone(), false)));
                }
                l.state = "uncertain".into();
                l.error = Some(
                    "Create started; confirm remote outcome before retrying if interrupted.".into(),
                );
                store::put(tx, "task", &id, &t)?;
                return Ok(None);
            }
            t.links.push(ExternalLink {
                provider: p,
                container: c,
                remote_id: None,
                state: "uncertain".into(),
                error: Some(
                    "Create started; confirm remote outcome before retrying if interrupted.".into(),
                ),
                synced_version: None,
                google_binding,
            });
            store::put(tx, "task", &id, &t)?;
            Ok(None)
        })
        .await?;
    if matches!(remote_id, Some((_, true))) {
        return Ok(json!({"task_id":snapshot.id,"already_synced":true}));
    }
    let existing = remote_id.and_then(|(id, _)| id);
    let body = if provider == "google" {
        let mut body = json!({"title":snapshot.title,"notes":snapshot.notes,"status":if snapshot.status=="done"{"completed"}else{"needsAction"}});
        if let Some(due) = &snapshot.due {
            body["due"] = json!(format!("{due}T00:00:00Z"));
        } else {
            body["due"] = Value::Null;
        }
        body
    } else {
        let mut body = json!({"data":{"name":snapshot.title,"notes":snapshot.notes,"completed":snapshot.status=="done","due_on":snapshot.due}});
        if existing.is_none() {
            body["data"]["projects"] = json!([container.clone()]);
        }
        body
    };
    let result = if provider == "google" {
        let base = format!(
            "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks",
            segment(&container)
        );
        if let Some(id) = &existing {
            crate::integrations::google_patch(app, &format!("{base}/{}", segment(id)), &body).await
        } else {
            crate::integrations::google_post(app, &base, &body).await
        }
    } else if provider == "asana" {
        if let Some(id) = &existing {
            crate::integrations::asana_put(
                app,
                &format!("https://app.asana.com/api/1.0/tasks/{}", segment(id)),
                &body,
            )
            .await
        } else {
            crate::integrations::asana_post(app, "https://app.asana.com/api/1.0/tasks", &body).await
        }
    } else {
        anyhow::bail!("Unknown task provider")
    };
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            record_link_error(app, &snapshot.id, &provider, &error.to_string()).await?;
            return Err(error);
        }
    };
    let remote = value
        .get("id")
        .or_else(|| value.pointer("/data/gid"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or(existing)
        .ok_or_else(|| {
            anyhow::anyhow!("Remote response has no task ID; reconcile before retrying")
        })?;
    let id = snapshot.id.clone();
    app.db()
        .transaction(move |tx| {
            let mut t: Task = store::get(tx, "task", &id)?
                .ok_or_else(|| anyhow::anyhow!("Local task missing"))?;
            let l = t
                .links
                .iter_mut()
                .find(|l| l.provider == provider)
                .ok_or_else(|| anyhow::anyhow!("Delivery marker missing"))?;
            l.remote_id = Some(remote);
            l.state = "linked".into();
            l.error = None;
            l.synced_version = Some(version);
            l.google_binding = delivery_binding;
            store::put(tx, "task", &id, &t)
        })
        .await?;
    Ok(
        json!({"task_id":snapshot.id,"synced_version":version,"url":format!("/tasks/{}",snapshot.id)}),
    )
}
async fn record_link_error(app: &App, id: &str, provider: &str, error: &str) -> anyhow::Result<()> {
    let (id, provider, error) = (id.to_owned(), provider.to_owned(), error.to_owned());
    app.db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            if let Some(l) = t.links.iter_mut().find(|l| l.provider == provider) {
                l.error = Some(error);
                if l.remote_id.is_some() {
                    l.state = "update_failed".into();
                }
            }
            store::put(tx, "task", &id, &t)
        })
        .await
}
