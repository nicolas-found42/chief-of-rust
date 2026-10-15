//! Workspace preferences and opt-in schedules. Installation secrets stay in env.
pub mod providers;
use crate::{
    App,
    db::Db,
    store,
    web::{self, escape},
};
use axum::{
    Router,
    extract::{Form, State},
    response::{Redirect, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    pub revision: u64,
    pub owner_name: String,
    pub timezone: String,
    pub calendar_id: String,
    pub drive_folder_id: String,
    pub drive_consent: bool,
    pub research_contact: Option<String>,
}
impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            owner_name: String::new(),
            timezone: "America/New_York".into(),
            calendar_id: "primary".into(),
            drive_folder_id: String::new(),
            drive_consent: false,
            research_contact: None,
        }
    }
}
pub async fn load(db: &Db) -> anyhow::Result<WorkspaceSettings> {
    Ok(db.get("settings", "workspace").await?.unwrap_or_default())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Schedule {
    pub kind: String,
    pub interval_minutes: u32,
    pub enabled: bool,
    pub last_enqueued_at: Option<i64>,
    pub last_error: Option<String>,
}
const KINDS: [(&str, &str); 5] = [
    ("meetings.calendar", "Calendar intake"),
    ("meetings.drive", "Drive transcript intake"),
    ("content.scout", "Content Scout"),
    ("content.watch", "Content Research"),
    ("content.trends", "YouTube observations"),
];
pub fn router() -> Router<App> {
    Router::new()
        .route("/settings", get(index).post(save))
        .route("/settings/contact", axum::routing::post(save_contact))
        .route("/settings/schedules", axum::routing::post(save_schedule))
        .route("/onboarding", get(index))
        .merge(providers::router())
}
async fn index(State(app): State<App>) -> web::Result<Response> {
    let settings = load(&app.db).await?;
    let google = crate::integrations::google_status(&app).await;
    let provider_settings = providers::load(&app.db).await?;
    let mut body = format!(
        "<p>Preferences live in your Workspace. API keys are read from the installation environment.</p><div class=\"grid\"><section><h2>Workspace</h2><form method=\"post\"><input type=\"hidden\" name=\"revision\" value=\"{}\"><label>Your name<input name=\"owner_name\" value=\"{}\" maxlength=\"200\"></label><label>Time zone<input name=\"timezone\" value=\"{}\" required></label><label>Calendar ID<input name=\"calendar_id\" value=\"{}\" required></label><label>Drive transcript folder ID<input name=\"drive_folder_id\" value=\"{}\"></label><label class=\"check\"><input type=\"checkbox\" name=\"drive_consent\" value=\"true\" {}>Allow scheduled import of text transcripts from this folder. Generation still requires a separate request.</label><button>Save preferences</button></form></section><section>{}<h2>Google account</h2><p>{}</p><p>Register <code>http://localhost:{}/google/callback</code> for your Google web OAuth client.</p><p><a class=\"button\" href=\"/google/connect\">Connect or reconnect Google</a></p><form method=\"post\" action=\"/google/disconnect\"><button class=\"secondary\">Disconnect this workspace</button></form><p>Calendar and Drive access are read-only. Gmail writes create reviewed drafts. Tasks delivery is requested on each Task.</p></section></div>",
        settings.revision,
        escape(&settings.owner_name),
        escape(&settings.timezone),
        escape(&settings.calendar_id),
        escape(&settings.drive_folder_id),
        if settings.drive_consent {
            "checked"
        } else {
            ""
        },
        providers::panel(&app, &provider_settings),
        escape(&google),
        app.cfg.port
    );
    body.push_str(&format!(
        "<section><h2>Research operator contact</h2><p>Contact-bearing providers (SEC, Wikidata, Crossref) require this. Missing contact blocks only those collectors; other research proceeds with explicit coverage gaps. The contact is never written into research evidence or judgment inputs.</p><form method=\"post\" action=\"/settings/contact\"><input type=\"hidden\" name=\"revision\" value=\"{}\"><label>Operator contact email<input name=\"research_contact\" type=\"email\" value=\"{}\" maxlength=\"254\"></label><button>Save contact</button></form></section>",
        settings.revision,
        escape(settings.research_contact.as_deref().unwrap_or_default()),
    ));
    body.push_str("<section><h2>Other connections</h2><dl>");
    for (key, label) in [
        ("JEV_API_KEY", "Jev (OPENROUTER_API_KEY is the fallback)"),
        ("OPENROUTER_API_KEY", "OpenRouter"),
        ("OPENCODE_API_KEY", "OpenCode"),
        ("ZAI_API_KEY", "Z.AI"),
        ("OLLAMA_CLOUD_API_KEY", "Ollama Cloud"),
        ("FIRECRAWL_API_KEY", "Firecrawl"),
        ("ASANA_ACCESS_TOKEN", "Asana"),
        ("YOUTUBE_API_KEY", "YouTube API key"),
        ("HUBSPOT_ACCESS_TOKEN", "HubSpot"),
    ] {
        body.push_str(&format!(
            "<dt>{label}</dt><dd>{} · <code>{key}</code></dd>",
            if std::env::var(key).is_ok_and(|s| !s.is_empty()) {
                "Configured"
            } else {
                "Not configured"
            }
        ));
    }
    body.push_str("</dl><p>YouTube can also use your connected Google account. Search follows the provider selected above.</p></section><section><h2>Schedules</h2><p>All schedules start disabled. Enabling one admits a bounded snapshot on each interval. Runs and timing survive restarts.</p>");
    let schedules = app.db.list::<Schedule>("schedule").await?;
    for (kind, label) in KINDS {
        let current = schedules.iter().find(|s| s.kind == kind);
        body.push_str(&format!("<article><h3>{label}</h3><form method=\"post\" action=\"/settings/schedules\"><input type=\"hidden\" name=\"kind\" value=\"{kind}\"><label>Interval in minutes<input name=\"interval_minutes\" type=\"number\" min=\"5\" max=\"10080\" value=\"{}\" required></label><label class=\"check\"><input type=\"checkbox\" name=\"enabled\" value=\"true\" {}>Enable this schedule</label><button>Save schedule</button></form>",current.map_or(360,|s|s.interval_minutes),if current.is_some_and(|s|s.enabled){"checked"}else{""}));
        if let Some(error) = current.and_then(|s| s.last_error.as_ref()) {
            body.push_str(&format!("<p role=\"alert\">{}</p>", escape(error)));
        }
        body.push_str("</article>");
    }
    body.push_str("</section>");
    Ok(web::page("Settings", body))
}
#[derive(Deserialize)]
struct SettingsForm {
    revision: u64,
    #[serde(default)]
    owner_name: String,
    timezone: String,
    calendar_id: String,
    #[serde(default)]
    drive_folder_id: String,
    #[serde(default)]
    drive_consent: bool,
}
async fn save(State(app): State<App>, Form(form): Form<SettingsForm>) -> web::Result<Redirect> {
    if form.owner_name.len() > 200
        || form.calendar_id.len() > 500
        || form.drive_folder_id.len() > 200
    {
        return Err(web::Error::bad_request(
            "A preference exceeds its size limit.",
        ));
    }
    let zone = form.timezone.trim().parse::<chrono_tz::Tz>().map_err(|_| {
        web::Error::bad_request("Enter an IANA time zone, such as America/New_York.")
    })?;
    if form.drive_consent && form.drive_folder_id.trim().is_empty() {
        return Err(web::Error::bad_request(
            "Choose a transcript folder before enabling intake consent.",
        ));
    }
    let mut settings = WorkspaceSettings {
        revision: form
            .revision
            .checked_add(1)
            .ok_or_else(|| web::Error::bad_request("Invalid preferences revision."))?,
        owner_name: form.owner_name.trim().into(),
        timezone: zone.name().into(),
        calendar_id: web::required(&form.calendar_id, "Calendar ID", 500)?,
        drive_folder_id: form.drive_folder_id.trim().into(),
        drive_consent: form.drive_consent,
        research_contact: None,
    };
    let saved = app
        .db
        .transaction(move |tx| {
            let old: WorkspaceSettings =
                store::get(tx, "settings", "workspace")?.unwrap_or_default();
            if old.revision != form.revision {
                return Ok(false);
            }
            settings.research_contact = old.research_contact;
            store::put(tx, "settings", "workspace", &settings)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(web::Error::conflict(
            "Preferences changed in another tab. Reload before saving.",
        ));
    }
    Ok(Redirect::to("/settings"))
}
#[derive(Deserialize)]
struct ContactForm {
    revision: u64,
    #[serde(default)]
    research_contact: String,
}
async fn save_contact(
    State(app): State<App>,
    Form(form): Form<ContactForm>,
) -> web::Result<Redirect> {
    let contact = form.research_contact.trim();
    let contact = if contact.is_empty() {
        None
    } else {
        crate::research::validate_operator_contact(contact)
            .map_err(|e| web::Error::bad_request(e.to_string()))?;
        Some(contact.to_owned())
    };
    let revision = form
        .revision
        .checked_add(1)
        .ok_or_else(|| web::Error::bad_request("Invalid preferences revision."))?;
    let saved = app
        .db
        .transaction(move |tx| {
            let mut settings: WorkspaceSettings =
                store::get(tx, "settings", "workspace")?.unwrap_or_default();
            if settings.revision != form.revision {
                return Ok(false);
            }
            settings.research_contact = contact;
            settings.revision = revision;
            store::put(tx, "settings", "workspace", &settings)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(web::Error::conflict(
            "Preferences changed in another tab. Reload before saving.",
        ));
    }
    Ok(Redirect::to("/settings"))
}

#[derive(Deserialize)]
struct ScheduleForm {
    kind: String,
    interval_minutes: u32,
    #[serde(default)]
    enabled: bool,
}
async fn save_schedule(
    State(app): State<App>,
    Form(form): Form<ScheduleForm>,
) -> web::Result<Redirect> {
    if !KINDS.iter().any(|(k, _)| *k == form.kind) || !(5..=10080).contains(&form.interval_minutes)
    {
        return Err(web::Error::bad_request(
            "Choose a supported schedule and an interval between 5 and 10080 minutes.",
        ));
    }
    if form.enabled && form.kind == "meetings.drive" {
        let settings = load(&app.db).await?;
        if !settings.drive_consent || settings.drive_folder_id.is_empty() {
            return Err(web::Error::bad_request(
                "Choose and consent to a Drive transcript folder first.",
            ));
        }
    }
    app.db
        .transaction(move |tx| {
            let old = store::get::<Schedule>(tx, "schedule", &form.kind)?;
            let schedule = Schedule {
                kind: form.kind.clone(),
                interval_minutes: form.interval_minutes,
                enabled: form.enabled,
                last_enqueued_at: old.and_then(|s| s.last_enqueued_at),
                last_error: None,
            };
            store::put(tx, "schedule", &form.kind, &schedule)
        })
        .await?;
    Ok(Redirect::to("/settings"))
}
/// Admission timing is saved before enqueue so restarting during a slow
/// provider call does not launch the same interval a second time.
pub async fn tick(app: &App) -> anyhow::Result<()> {
    let now = crate::now_ms();
    let due = app
        .db
        .transaction(move |tx| {
            let mut due = Vec::new();
            for mut schedule in store::list::<Schedule>(tx, "schedule")? {
                if schedule.enabled
                    && schedule
                        .last_enqueued_at
                        .is_none_or(|at| now - at >= i64::from(schedule.interval_minutes) * 60_000)
                {
                    schedule.last_enqueued_at = Some(now);
                    store::put(tx, "schedule", &schedule.kind, &schedule)?;
                    due.push(schedule);
                }
            }
            Ok(due)
        })
        .await?;
    for mut schedule in due {
        let result = if schedule.kind.starts_with("meetings.") {
            crate::meetings::enqueue_scheduled(app, &schedule.kind).await
        } else {
            crate::content::enqueue_scheduled(app, &schedule.kind).await
        };
        schedule.last_error = result
            .err()
            .map(|e| crate::llm::redact_error(&e.to_string(), &app.cfg));
        let kind = schedule.kind.clone();
        app.db
            .transaction(move |tx| {
                if let Some(mut current) = store::get::<Schedule>(tx, "schedule", &kind)?
                    && current.last_enqueued_at == schedule.last_enqueued_at
                {
                    current.last_error = schedule.last_error;
                    store::put(tx, "schedule", &kind, &current)?;
                }
                Ok(())
            })
            .await?;
    }
    Ok(())
}
