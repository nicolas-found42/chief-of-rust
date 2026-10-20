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
        .route("/design", get(design))
        .route("/healthz", get(healthz))
        .route("/llm", post(llm_post))
        .route("/static/carbon.css", get(carbon_styles))
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
        .layer(middleware::from_fn(request_id))
        .with_state(app)
}

/// Request correlation: echo an inbound `x-request-id` or mint one, so every
/// log line and every rejection for the request carries the same id. The
/// value is an opaque correlation token, never a secret.
async fn request_id(request: Request, next: Next) -> Response {
    let id = request
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let span = tracing::info_span!("request", %id, method = %request.method(), path = request.uri().path());
    let path = request.uri().path().to_owned();
    let started = std::time::Instant::now();
    // The span instruments the inner future rather than entering it: the
    // guard from `enter` cannot cross the await, but the instrumented
    // future carries the request id through every log line it emits.
    use tracing::Instrument;
    let mut response = next.run(request).instrument(span).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    // Static assets are noise in the request log; failures still carry the
    // echoed id on the response.
    if !path.starts_with("/static/") {
        tracing::info!(
            status = response.status().as_u16(),
            elapsed_ms,
            "request completed"
        );
    }
    if let Ok(value) = axum::http::HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}
async fn home(State(app): State<App>) -> web::Result<Response> {
    let app = crate::settings::providers::resolve(&app).await?;
    let settings = crate::settings::load(app.db()).await?;
    let mut body = format!(
        "<p class=\"cds-eyebrow\">Your workspace</p><p class=\"cds-lead\">{}Prepare for conversations, follow through on commitments, and turn evidence into content.</p>",
        if settings.owner_name.is_empty() {
            String::new()
        } else {
            format!("{}, ", escape(&settings.owner_name))
        }
    );
    body.push_str("<div class=\"cds-cards\">");
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
        let count = app.db().list::<serde_json::Value>(kind).await?.len();
        body.push_str(&format!(
            "<article class=\"cds-card\"><h2><a href=\"{url}\">{title}</a></h2><p>{detail}</p>{}</article>",
            web::carbon_tag(&web::pluralize(count, "record", "records"), web::CarbonTag::Gray)
        ));
    }
    body.push_str("</div><section class=\"cds-section\"><h2>Ready to continue</h2>");
    let runs = crate::work::list(app.db()).await?;
    let failures = runs.iter().filter(|j| j.status == "failed").count();
    body.push_str(&format!(
        "<p>{} available for review. <a href=\"/runs\">Open Runs</a></p>",
        web::pluralize(failures, "failed Run", "failed Runs")
    ));
    if app.llm().name() == "mock" {
        body.push_str(&web::carbon_notification(
            "Offline test mode is active",
            "<p>Model output is a fixture, not live research.</p>",
            web::CarbonNotification::Info,
        ));
    } else if app.cfg().llm_key().is_none() {
        body.push_str(&web::carbon_notification(
            "Model provider not configured",
            "<p>Set the selected model provider’s API key in your installation to enable generation. Local work is available now.</p>",
            web::CarbonNotification::Warning,
        ));
    }
    body.push_str(
        "<p><a href=\"/settings\">Manage preferences, connections and schedules</a></p></section>",
    );
    Ok(web::page("Chief of Staff", web::Body::new(body)))
}
async fn healthz(State(app): State<App>) -> impl IntoResponse {
    // The banner stays first: the boot check greps for it. Machine
    // diagnostics follow as plain lines, so a human `curl` still reads
    // while an agent parses the same body without a second endpoint.
    let mut body = crate::banner();
    let counts = app
        .db()
        .transaction(|tx| {
            let running: i64 =
                tx.query_row("SELECT count(*) FROM job WHERE status='running'", [], |r| {
                    r.get(0)
                })?;
            let queued: i64 =
                tx.query_row("SELECT count(*) FROM job WHERE status='queued'", [], |r| {
                    r.get(0)
                })?;
            let failed: i64 =
                tx.query_row("SELECT count(*) FROM job WHERE status='failed'", [], |r| {
                    r.get(0)
                })?;
            let oldest_queued: Option<i64> = tx
                .query_row(
                    "SELECT MIN(created_at) FROM job WHERE status='queued'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(None);
            Ok((running, queued, failed, oldest_queued))
        })
        .await
        .unwrap_or_default();
    let age_ms = counts
        .3
        .map(|at| crate::now_ms().saturating_sub(at))
        .unwrap_or(0);
    body.push_str(&format!(
        "\nrunning={} queued={} failed={} oldest_queued_age_ms={}",
        counts.0, counts.1, counts.2, age_ms
    ));
    body
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
    let reply = match app.llm().complete(&prompt).await {
        Ok(reply) => reply,
        Err(error) => return Ok(crate::settings::providers::failure(error, &app)),
    };
    app.db()
        .record_llm_call(crate::now_ms(), app.llm().name(), &prompt, &reply)
        .await?;
    Ok(web::page(
        "Model diagnostic",
        web::Body::new(format!(
            "<p><strong>{}</strong> · <code>{}</code> · reasoning {} replied</p><pre>{}</pre><p><a href=\"/settings\">Return to Settings</a></p>",
            escape(app.llm().name()),
            escape(app.cfg().llm_model()),
            escape(app.cfg().llm_effort()),
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
        Ok(value)=>{for calendar in value["items"].as_array().into_iter().flatten(){body.push_str(&format!("<article class=\"cds-card\"><h2>{}</h2><code>{}</code></article>",escape(calendar["summary"].as_str().unwrap_or("Calendar")),escape(calendar["id"].as_str().unwrap_or(""))));}},
        Err(_)=>body.push_str("<p>Not connected. Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_SECRET_PATH, then connect from Settings.</p>"),
    }
    Ok(web::page("Google calendars", web::Body::new(body)))
}
async fn carbon_styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../static/carbon.css"),
    )
}
async fn htmx_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        include_bytes!("../static/htmx.min.js").as_slice(),
    )
}
/// The Carbon proving page (#56): exercises every shared component partial
/// on one script-free page so the rollout ticket (#57) can trust them.
/// Not linked from product navigation; removed or kept as a gallery by #57.
async fn design() -> impl IntoResponse {
    let mut body = web::carbon_breadcrumb(&[("/", "Workspace")], "Design system");
    body.push_str(&web::carbon_section(
        "Sections",
        "<p>Sections group related work under one heading.</p>",
    ));
    body.push_str(&web::carbon_card(
        "Cards",
        "<p>Cards carry one unit of content.</p>",
    ));
    body.push_str(
        "<table class=\"cds-table\"><caption>Tabular data</caption><thead><tr><th scope=\"col\">Name</th><th scope=\"col\">State</th></tr></thead><tbody><tr><td>Example</td><td>Ready</td></tr></tbody></table>",
    );
    body.push_str(&format!(
        "<form class=\"cds-form\" method=\"get\" action=\"/design\"><label>Example input<input name=\"q\" value=\"\"></label><button class=\"{}\" type=\"submit\">Filter</button> <button class=\"{}\" type=\"submit\">Save</button> <button class=\"{}\" type=\"submit\">Delete</button></form>",
        web::carbon_button_class("Filter"),
        web::carbon_button_class("Save"),
        web::carbon_button_class("Delete"),
    ));
    body.push_str(&format!(
        "<p>{} {} {} {} {}</p>",
        web::carbon_tag("Done", web::CarbonTag::Green),
        web::carbon_tag("Blocked", web::CarbonTag::Red),
        web::carbon_tag("Running", web::CarbonTag::Yellow),
        web::carbon_tag("Info", web::CarbonTag::Blue),
        web::carbon_tag("Neutral", web::CarbonTag::Gray),
    ));
    body.push_str(&web::carbon_notification(
        "Heads up",
        "An informational note.",
        web::CarbonNotification::Info,
    ));
    body.push_str(&web::carbon_notification(
        "Check this",
        "A warning that needs review.",
        web::CarbonNotification::Warning,
    ));
    body.push_str(&web::carbon_notification(
        "Something failed",
        "An error with recovery steps.",
        web::CarbonNotification::Error,
    ));
    body.push_str(&web::carbon_notification(
        "All good",
        "A success confirmation.",
        web::CarbonNotification::Success,
    ));
    web::page("Design system", web::Body::with_heading(body))
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
            // Inside the request span: the rejection carries the request id.
            tracing::warn!("loopback boundary rejected non-local host");
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
                tracing::warn!("loopback boundary rejected cross-workspace origin");
                return (
                    StatusCode::FORBIDDEN,
                    "Browser requests must come from this workspace.",
                )
                    .into_response();
            }
        }
    } else if headers.contains_key(header::ORIGIN) {
        tracing::warn!("loopback boundary rejected hostless browser request");
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
        tracing::warn!("loopback boundary rejected cross-site navigation");
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
