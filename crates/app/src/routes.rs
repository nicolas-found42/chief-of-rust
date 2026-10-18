//! The Rust shell mounts five independent products behind a local boundary.
use crate::{
    App,
    web::{self, escape},
};
use axum::{
    Router,
    extract::{Form, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;

pub fn router(app: App) -> Router {
    Router::new()
        .route("/", get(home))
        .route("/healthz", get(healthz))
        .route("/llm", post(llm_post))
        .route("/static/app.css", get(styles))
        .route("/static/htmx.min.js", get(htmx_js))
        .route("/google/calendars", get(calendars))
        .merge(crate::settings::router())
        .merge(crate::integrations::router())
        .merge(crate::work::router())
        .merge(crate::meetings::router())
        .merge(crate::people::router())
        .merge(crate::terminal::router())
        .merge(crate::tasks::router())
        .merge(crate::content::router())
        .fallback(not_found)
        .layer(axum::extract::DefaultBodyLimit::max(1_000_000))
        .layer(middleware::from_fn(local_boundary))
        .layer(middleware::from_fn_with_state(app.clone(), web::context))
        .with_state(app)
}
async fn home(State(app): State<App>) -> web::Result<Response> {
    let app = crate::settings::providers::resolve(&app).await?;
    let settings = crate::settings::load(&app.db).await?;
    let mut body = format!(
        "<p class=\"eyebrow\">Your workspace</p><p class=\"lead\">{}Prepare for conversations, follow through on commitments, and turn evidence into content.</p>",
        if settings.owner_name.is_empty() {
            String::new()
        } else {
            format!("{}, ", escape(&settings.owner_name))
        }
    );
    body.push_str("<div class=\"grid cards\">");
    for (url, title, detail, kind) in [
        (
            "/meetings",
            "Meeting Wizard",
            "Prepare briefs, review transcripts and debriefs, and plan your week.",
            "meeting",
        ),
        (
            "/content-scout",
            "Content Engine",
            "Scout ideas and develop reviewed outlines and drafts.",
            "content.project",
        ),
        (
            "/content-research",
            "Content Research",
            "Watch people and measure public YouTube observations.",
            "content.watch",
        ),
        (
            "/terminal",
            "Bloomberg Terminal",
            "Research people and companies with inspectable source evidence.",
            "person",
        ),
        (
            "/tasks",
            "Tasks",
            "Capture, prioritize and complete local work. Review proposed meeting actions.",
            "task",
        ),
    ] {
        let count = app.db.list::<serde_json::Value>(kind).await?.len();
        body.push_str(&format!("<article><h2><a href=\"{url}\">{title}</a></h2><p>{detail}</p><span class=\"badge\">{}</span></article>",web::pluralize(count,"record","records")));
    }
    body.push_str("</div><section><h2>Ready to continue</h2>");
    let runs = crate::work::list(&app.db).await?;
    let failures = runs.iter().filter(|j| j.status == "failed").count();
    body.push_str(&format!(
        "<p>{} available for review. <a href=\"/runs\">Open Runs</a></p>",
        web::pluralize(failures, "failed Run", "failed Runs")
    ));
    if app.llm.name() == "mock" {
        body.push_str("<p class=\"notice\">Offline test mode is active. Model output is a fixture, not live research.</p>");
    } else if app.cfg.llm_key().is_none() {
        body.push_str("<p class=\"notice\">Set the selected model provider’s API key in your installation to enable generation. Local work is available now.</p>");
    }
    body.push_str(
        "<p><a href=\"/settings\">Manage preferences, connections and schedules</a></p></section>",
    );
    Ok(web::page("Chief of Staff", web::Body::new(body)))
}
async fn healthz() -> impl IntoResponse {
    crate::banner()
}
async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        web::page(
            "Page not found",
            web::Body::new(
                "<p>This page does not exist. <a href=\"/\">Return to your workspace</a>.</p>"
                    .into(),
            ),
        ),
    )
        .into_response()
}
#[derive(Deserialize)]
struct PromptForm {
    prompt: String,
}
async fn llm_post(State(app): State<App>, Form(form): Form<PromptForm>) -> web::Result<Response> {
    let app = crate::settings::providers::resolve(&app).await?;
    let prompt = web::required(&form.prompt, "Prompt", 2000)?;
    let reply = match app.llm.complete(&prompt).await {
        Ok(reply) => reply,
        Err(error) => return Ok(crate::settings::providers::failure(error, &app)),
    };
    app.db
        .record_llm_call(crate::now_ms(), app.llm.name(), &prompt, &reply)
        .await?;
    Ok(web::page(
        "Model diagnostic",
        web::Body::new(format!(
            "<p><strong>{}</strong> · <code>{}</code> · reasoning {} replied</p><pre>{}</pre><p><a href=\"/settings\">Return to Settings</a></p>",
            escape(app.llm.name()),
            escape(app.cfg.llm_model()),
            escape(app.cfg.llm_effort()),
            escape(&reply)
        )),
    ))
}
async fn calendars(State(app): State<App>) -> web::Result<Response> {
    let result = crate::integrations::google_get(
        &app,
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        &[],
    )
    .await;
    let mut body = "<p>Choose a Calendar ID in Settings.</p>".to_owned();
    match result {
        Ok(value)=>{for calendar in value["items"].as_array().into_iter().flatten(){body.push_str(&format!("<article><h2>{}</h2><code>{}</code></article>",escape(calendar["summary"].as_str().unwrap_or("Calendar")),escape(calendar["id"].as_str().unwrap_or(""))));}},
        Err(_)=>body.push_str("<p>Not connected. Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_SECRET_PATH, then connect from Settings.</p>"),
    }
    Ok(web::page("Google calendars", web::Body::new(body)))
}
async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/app.css"),
    )
}
async fn htmx_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        include_bytes!("../static/htmx.min.js").as_slice(),
    )
}
async fn local_boundary(request: Request, next: Next) -> Response {
    let headers = request.headers();
    if let Some(host) = headers.get(header::HOST) {
        let host = host.to_str().unwrap_or("");
        let parsed = url::Url::parse(&format!("http://{host}"));
        let local = parsed.as_ref().is_ok_and(|url| {
            matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                && url.username().is_empty()
                && url.password().is_none()
        });
        if !local {
            return (
                StatusCode::FORBIDDEN,
                "This workspace accepts loopback hosts only.",
            )
                .into_response();
        }
        if let Some(origin) = headers.get(header::ORIGIN) {
            let same = origin
                .to_str()
                .ok()
                .and_then(|s| url::Url::parse(s).ok())
                .is_some_and(|origin| {
                    origin.scheme() == "http"
                        && origin.host_str() == parsed.as_ref().ok().and_then(|u| u.host_str())
                        && origin.port_or_known_default()
                            == parsed.as_ref().ok().and_then(|u| u.port_or_known_default())
                });
            if !same {
                return (
                    StatusCode::FORBIDDEN,
                    "Browser requests must come from this workspace.",
                )
                    .into_response();
            }
        }
    } else if headers.contains_key(header::ORIGIN) {
        return (
            StatusCode::FORBIDDEN,
            "Browser request is missing its host.",
        )
            .into_response();
    }
    let callback =
        request.method() == axum::http::Method::GET && request.uri().path() == "/google/callback";
    if !callback
        && headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site" || v == "same-site")
    {
        return (
            StatusCode::FORBIDDEN,
            "Open the workspace directly before continuing.",
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,axum::http::HeaderValue::from_static("default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        // no-referrer makes navigation POSTs send Origin: null, which our
        // same-origin boundary correctly rejects. Keep the origin on local
        // forms without disclosing referrers to external destinations.
        axum::http::HeaderValue::from_static("same-origin"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
