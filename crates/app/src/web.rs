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
}
pub fn page(title: &str, body: String) -> Response {
    match (Shell {
        title,
        body: &body,
        show_title: !body.contains("<h1"),
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
