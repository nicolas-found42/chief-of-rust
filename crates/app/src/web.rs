//! The forms-first shell and a common escaped error surface.
use askama::Template;
use axum::{
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};
#[derive(Template)]
#[template(path = "shell.html")]
struct Shell<'a> {
    title: &'a str,
    body: &'a str,
    show_title: bool,
    section: String,
    run_counts: String,
    refresh: bool,
}
pub fn page(title: &str, body: String) -> Response {
    page_refresh(title, body, false)
}
pub fn page_refresh(title: &str, body: String, refresh: bool) -> Response {
    let (section, run_counts) = PAGE_CONTEXT
        .try_with(|c| (c.0.clone(), c.1.clone()))
        .unwrap_or_default();
    match (Shell {
        title,
        body: &body,
        show_title: !body.contains("<h1"),
        section,
        run_counts,
        refresh,
    })
    .render()
    {
        Ok(html) => Html(html).into_response(),
        Err(error) => Error::from(anyhow::Error::new(error)).into_response(),
    }
}
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&#39;")
}

/// A readable Workspace time with a machine-readable instant for browsers.
pub fn saved_time(milliseconds: i64, timezone: &str) -> String {
    let Some(instant) = chrono::DateTime::from_timestamp_millis(milliseconds) else {
        return "Unknown time".to_owned();
    };
    let zone = timezone.parse::<chrono_tz::Tz>().unwrap_or(chrono_tz::UTC);
    format!(
        "<time datetime=\"{}\">{}</time>",
        instant.to_rfc3339(),
        instant.with_timezone(&zone).format("%b %-d, %Y · %H:%M %Z")
    )
}

/// Show deterministic collection limits beside generated work, so the
/// operator can judge missing evidence even when a model omits the caveat.
pub fn search_coverage(coverage: &crate::integrations::SearchCoverage) -> String {
    let mut html = format!(
        "<aside class=\"notice\" aria-label=\"Search coverage\"><p><strong>Search snippets</strong> · First result page only; original pages were not fetched.</p><p>{} snippets selected from {} returned results. {} duplicate URLs, {} invalid URLs, {} empty snippets excluded; {} unique results omitted by the eight-source limit. {} selected snippets truncated to 6000 characters.</p>",
        coverage.selected,
        coverage.received,
        coverage.duplicates,
        coverage.invalid,
        coverage.empty,
        coverage.omitted,
        coverage.truncated
    );
    if !coverage.providers.is_empty() {
        html.push_str(&format!(
            "<p>Search services: {}.</p>",
            escape(&coverage.providers.join(" + "))
        ));
    }
    if !coverage.unresponsive_engines.is_empty() {
        html.push_str(&format!(
            "<p>Search engines unavailable: {}. Coverage may be incomplete.</p>",
            escape(&coverage.unresponsive_engines.join(", "))
        ));
    }
    html.push_str("<p>Source publication dates and current accuracy were not verified. Open the original sources before relying on this research.</p></aside>");
    html
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error {
    pub status: StatusCode,
    pub message: String,
}
impl Error {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
}
impl From<anyhow::Error> for Error {
    fn from(error: anyhow::Error) -> Self {
        tracing::error!(%error,"request failed");
        Self { status:StatusCode::INTERNAL_SERVER_ERROR,message:"The operation failed. Your saved work is intact. Check Runs for details and retry after correcting the cause.".into() }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            self.status,
            page(
                "Unable to continue",
                format!(
                    "<p role=\"alert\">{}</p><a href=\"/\">Return home</a>",
                    escape(&self.message)
                ),
            ),
        )
            .into_response()
    }
}
pub fn required(value: &str, label: &str, limit: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > limit {
        return Err(Error::bad_request(format!(
            "{label} is required and must be at most {limit} bytes."
        )));
    }
    Ok(value.to_owned())
}

/// Keep secondary and destructive workflow actions visually distinct.
pub fn button_class(label: &str) -> &'static str {
    if ["Delete", "Move to trash", "Permanently delete"]
        .iter()
        .any(|prefix| label.starts_with(prefix))
    {
        "btn-danger"
    } else if [
        "Skip",
        "Dismiss",
        "Filter",
        "Pause",
        "Resume",
        "Archive",
        "Restore",
        "Set state",
        "Disconnect",
        "Exclude",
        "Allow this file",
    ]
    .iter()
    .any(|prefix| label.starts_with(prefix))
    {
        "btn-secondary"
    } else {
        "btn-primary"
    }
}

tokio::task_local! { static PAGE_CONTEXT: (String, String); }

/// Request-local shell context keeps concurrent navigation and Run badges isolated.
pub async fn context(
    axum::extract::State(app): axum::extract::State<crate::App>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = request.uri().path();
    if path.starts_with("/static/") || path == "/healthz" {
        return next.run(request).await;
    }
    let section = if path.starts_with("/meetings") || path.starts_with("/transcripts") {
        "meetings"
    } else if path.starts_with("/content-research")
        || path.starts_with("/research")
        || path.starts_with("/youtube")
    {
        "research"
    } else if path.starts_with("/content") {
        "content"
    } else if path.starts_with("/terminal") {
        "terminal"
    } else if path.starts_with("/tasks") || path.starts_with("/actions") {
        "tasks"
    } else if path.starts_with("/settings") || path == "/onboarding" || path.starts_with("/google")
    {
        "settings"
    } else if path.starts_with("/runs") {
        "runs"
    } else {
        ""
    };
    let counts = app
        .db
        .transaction(|tx| {
            let running: i64 =
                tx.query_row("SELECT count(*) FROM job WHERE status='running'", [], |r| {
                    r.get(0)
                })?;
            let failed: i64 =
                tx.query_row("SELECT count(*) FROM job WHERE status='failed'", [], |r| {
                    r.get(0)
                })?;
            Ok((running, failed))
        })
        .await
        .unwrap_or_default();
    let mut labels = Vec::new();
    if counts.0 > 0 {
        labels.push(format!("{} running", counts.0));
    }
    if counts.1 > 0 {
        labels.push(format!("{} failed", counts.1));
    }
    PAGE_CONTEXT
        .scope((section.into(), labels.join(" · ")), next.run(request))
        .await
}

/// A count and noun together prevent singular/plural drift across views.
pub fn pluralize(count: usize, singular: &str, plural: &str) -> String {
    format!("{count} {}", if count == 1 { singular } else { plural })
}

/// Retain the original instant for browsers while keeping prose readable.
pub fn timestamp(value: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(date) => format!(
            "<time datetime=\"{}\">{}</time>",
            escape(value),
            date.with_timezone(&chrono::Utc)
                .format("%b %-d, %Y · %H:%M UTC")
        ),
        Err(_) => escape(value),
    }
}

pub fn number(value: impl std::fmt::Display) -> String {
    let value = value.to_string();
    let (sign, digits) = value
        .strip_prefix('-')
        .map_or(("", value.as_str()), |v| ("-", v));
    let mut out = String::from(sign);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn display_label(value: &str) -> String {
    match value {
        "not_searched" => "Not searched".into(),
        "bounded_empty" => "No results".into(),
        "full_returned" => "Full content".into(),
        "selected_excerpts" => "Selected excerpts".into(),
        "linkedin-standard-post" => "LinkedIn Standard Post".into(),
        _ => {
            let words = value.replace(['_', '-', '.'], " ");
            let mut chars = words.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

pub fn badge(value: &str) -> String {
    let class = match value.to_lowercase().as_str() {
        "approved" | "reviewed" | "confirmed" | "confirmed by user" | "active" | "done"
        | "supported" | "covered" => "badge-success",
        "failed" | "blocked" | "error" | "uncertain" | "contradicted" | "invalid_citation" => {
            "badge-danger"
        }
        "awaiting review"
        | "needs_review"
        | "needs review"
        | "pending"
        | "partial"
        | "running"
        | "stale: meeting changed"
        | "ledger warnings"
        | "very short / <1 kb"
        | "in_progress" => "badge-warning",
        _ => "badge-neutral",
    };
    format!(
        "<span class=\"badge {class}\">{}</span>",
        escape(&display_label(value))
    )
}

fn safe_link(value: &str) -> bool {
    if value.contains('\\') || value.chars().any(char::is_control) {
        return false;
    }
    value.starts_with('#')
        || (value.starts_with('/') && !value.starts_with("//"))
        || url::Url::parse(value).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https" | "mailto")
                && u.username().is_empty()
                && u.password().is_none()
        })
}

/// Render generated prose as CommonMark, escaping HTML and rejecting active URLs.
pub fn markdown(value: &str) -> String {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};
    let events = Parser::new_ext(value, Options::ENABLE_TABLES).map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: if safe_link(&dest_url) {
                dest_url
            } else {
                "#".into()
            },
            title,
            id,
        }),
        Event::Start(Tag::Image { .. }) => Event::Start(Tag::Emphasis),
        Event::End(TagEnd::Image) => Event::End(TagEnd::Emphasis),
        other => other,
    });
    let mut output = String::new();
    html::push_html(&mut output, events);
    output
}

/// Earlier briefs flattened headings into prose; recover block boundaries for display only.
pub fn brief_markdown(value: &str) -> String {
    let mut text = value
        .replace(" ### ", "\n\n### ")
        .replace(" ## ", "\n\n## ");
    for heading in crate::research::LONG_BRIEF_HEADINGS
        .iter()
        .chain(crate::research::PERSON_SHORT_BRIEF_HEADINGS.iter())
    {
        text = text.replace(&format!("## {heading} "), &format!("## {heading}\n\n"));
    }
    markdown(&text)
}

/// Inspect evidence judgments without exposing serialized object syntax as prose.
pub fn facts(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Object(fields) => format!(
            "<dl>{}</dl>",
            fields
                .iter()
                .map(|(key, value)| format!(
                    "<dt>{}</dt><dd>{}</dd>",
                    escape(&display_label(key)),
                    facts(value)
                ))
                .collect::<String>()
        ),
        Value::Array(items) => format!(
            "<ul>{}</ul>",
            items
                .iter()
                .map(|v| format!("<li>{}</li>", facts(v)))
                .collect::<String>()
        ),
        Value::String(text) => {
            if text
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
            {
                escape(&display_label(text))
            } else {
                escape(text)
            }
        }
        Value::Bool(v) => if *v { "Yes" } else { "No" }.into(),
        Value::Null => "Not recorded".into(),
        other => escape(&other.to_string()),
    }
}

/// Stable source-order anchors replace opaque model citations without changing saved prose.
pub fn cited_markdown(value: &str, source_ids: &[&str]) -> String {
    let mut text = value.to_owned();
    for (index, id) in source_ids.iter().enumerate() {
        let n = index + 1;
        text = text.replace(&format!("[{id}]"), &format!("[[{n}]](#source-{n})"));
    }
    let mut rendered = markdown(&text);
    for n in 1..=source_ids.len() {
        rendered = rendered.replace(
            &format!("<a href=\"#source-{n}\">[{n}]</a>"),
            &format!("<sup><a href=\"#source-{n}\" aria-label=\"Source {n}\">[{n}]</a></sup>"),
        );
    }
    rendered
}

#[cfg(test)]
mod formatting_tests {
    use super::*;
    #[test]
    fn markdown_formats_prose_without_executing_html_or_links() {
        let html = markdown(
            "# Title\n\n**bold** *italic* `code`\n\n- item\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))",
        );
        for expected in [
            "<h1>Title</h1>",
            "<strong>bold</strong>",
            "<em>italic</em>",
            "<code>code</code>",
            "<li>item</li>",
            "&lt;script&gt;",
        ] {
            assert!(html.contains(expected), "{html}");
        }
        assert!(!html.contains("<script>"));
        assert!(!html.contains("href=\"javascript:"));
        assert!(markdown("![alt](https://example.com/tracker)").contains("<em>alt</em>"));
        assert!(!safe_link("/\\example.com"));
        assert!(
            brief_markdown(
                "## Research context This is the body. ## Professional profile A person."
            )
            .contains("<h2>Research context</h2>\n<p>This is the body.</p>")
        );
        assert!(brief_markdown("## First prose ## Second more").contains("<h2>Second more</h2>"));
    }
    #[test]
    fn labels_numbers_and_timestamps_are_readable() {
        assert_eq!(pluralize(1, "record", "records"), "1 record");
        assert_eq!(number(-14000), "-14,000");
        assert_eq!(display_label("in_progress"), "In progress");
        assert!(
            timestamp("2026-10-15T05:49:00.667833802+00:00").contains("Oct 15, 2026 · 05:49 UTC")
        );
    }
}
