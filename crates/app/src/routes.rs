//! Axum routes: the SSR surfaces of the skeleton. Forms work with zero
//! JavaScript (`POST /llm` renders the full page again); htmx (vendored,
//! served from the binary) upgrades the same form to a fragment swap when
//! the client sends `HX-Request` (survey #3: forms first, htmx second).

use askama::Template;
use axum::Router;
use axum::extract::{Form, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};

use crate::db::{LlmCall, Stats};
use crate::{App, google};

/// Vendored htmx v4.0.0 (https://github.com/bigskysoftware/htmx, BSD-2),
/// compiled into the binary: no CDN, no npm, no build step (survey #3).
static HTMX_JS: &[u8] = include_bytes!("../static/htmx.min.js");

pub fn router(app: App) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/llm", post(llm_post))
        .route("/healthz", get(healthz))
        .route("/google/calendars", get(google_calendars))
        .route("/static/htmx.min.js", get(htmx_js))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app)
}

/// What reply.html needs; home.html includes it with the same field.
#[derive(Template)]
#[template(path = "reply.html")]
pub struct ReplyTemplate {
    pub last_reply: Option<LlmCall>,
}

#[derive(Template)]
#[template(path = "home.html")]
pub struct HomeTemplate {
    pub banner: String,
    pub llm_name: &'static str,
    pub google_state: String,
    pub tick_count: i64,
    pub last_tick_text: Option<String>,
    pub last_reply: Option<LlmCall>,
}

#[derive(Template)]
#[template(path = "calendars.html")]
pub struct CalendarsTemplate {
    pub calendars: Option<Vec<String>>,
    pub redirect_port: u16,
}

// --- handlers ---------------------------------------------------------------

/// Home page context, built once so index and the non-htmx form fallback
/// agree on it.
fn home_template(app: &App, stats: Stats) -> HomeTemplate {
    HomeTemplate {
        banner: crate::banner(),
        llm_name: app.llm.name(),
        google_state: google::connection_state(&google::GoogleCfg::from_config(&app.cfg)),
        tick_count: stats.tick_count,
        last_tick_text: stats.last_tick_ms.map(secs_ago),
        last_reply: stats.last_call,
    }
}

/// Render a unix-ms timestamp the way the page shows it.
fn secs_ago(at_ms: i64) -> String {
    let delta = (crate::now_ms() - at_ms).max(0) as f64 / 1000.0;
    format!("{delta:.1}s ago")
}

async fn index(State(app): State<App>) -> Response {
    let stats = match app.db.stats().await {
        Ok(stats) => stats,
        Err(error) => return error_page(error),
    };
    render(home_template(&app, stats))
}

#[derive(serde::Deserialize)]
pub struct LlmForm {
    pub prompt: String,
}

async fn llm_post(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<LlmForm>,
) -> Response {
    let reply = match app.llm.complete(&form.prompt).await {
        Ok(reply) => reply,
        Err(error) => return error_page(error),
    };
    if let Err(error) = app
        .db
        .record_llm_call(crate::now_ms(), app.llm.name(), &form.prompt, &reply)
        .await
    {
        return error_page(error);
    }
    let last_reply = Some(LlmCall {
        provider: app.llm.name().to_string(),
        prompt: form.prompt,
        reply,
    });
    // htmx swaps the fragment; a plain form gets the whole page back.
    if headers.contains_key("hx-request") {
        render(ReplyTemplate { last_reply })
    } else {
        let stats = match app.db.stats().await {
            Ok(stats) => stats,
            Err(error) => return error_page(error),
        };
        let mut home = home_template(&app, stats);
        home.last_reply = last_reply;
        render(home)
    }
}

async fn healthz() -> impl IntoResponse {
    crate::banner()
}

async fn google_calendars(State(app): State<App>) -> Response {
    let cfg = google::GoogleCfg::from_config(&app.cfg);
    let calendars = if cfg.connected() {
        match google::list_calendars(&cfg).await {
            Ok(names) => Some(names),
            Err(error) => {
                tracing::error!(%error, "google calendar list failed");
                return error_page(error);
            }
        }
    } else {
        None
    };
    render(CalendarsTemplate {
        calendars,
        redirect_port: cfg.redirect_port,
    })
}

async fn htmx_js() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript")], HTMX_JS)
}

// --- response helpers -------------------------------------------------------

fn render<T: Template>(template: T) -> Response {
    match template.render() {
        Ok(body) => Html(body).into_response(),
        Err(error) => error_page(anyhow::Error::new(error)),
    }
}

/// Errors are rendered pages, not status-code holes: single-user SSR means
/// the human is looking at the browser, so tell them there.
fn error_page(error: anyhow::Error) -> Response {
    tracing::error!(%error, "request failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Html(format!("<h1>something broke</h1><pre>{error}</pre>")),
    )
        .into_response()
}
