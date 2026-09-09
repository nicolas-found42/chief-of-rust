//! Walking-skeleton prototype for the Rust rewrite (issue #2).
//!
//! PROTOTYPE, not production: this exists to make the stack survey (#3)
//! concrete and reactable — one SSR page, one background tick, one LLM call,
//! one Google API call, shipped the way the app will ship. What the reaction
//! validates gets folded into the real slice (#4); the rest is thrown away.
//!
//! Modules:
//! - [`db`]: SQLite via rusqlite behind the blocking pool (survey: bundled,
//!   WAL, synchronous calls off the async threads).
//! - [`llm`]: the app-local `LlmProvider` seam in front of rig (#3).
//! - [`google`]: yup-oauth2 installed flow + google-calendar3.
//! - [`routes`]: axum routes and Askama templates.

pub mod db;
pub mod google;
pub mod llm;
pub mod routes;

use std::path::PathBuf;

/// Runtime configuration, all from environment variables with defaults, so
/// the same binary runs locally, in Docker, and in CI with only env changes.
/// Hand-rolled on purpose: the prototype judges the shape before a config
/// crate earns its dependency weight.
#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP listen port; loopback-only (standing preference).
    pub port: u16,
    /// Directory for the SQLite file and Google token cache. Docker mounts
    /// the workspace volume here.
    pub workspace_dir: PathBuf,
    /// `mock` or `openai` (rig-backed, OpenAI-compatible chat completions).
    pub llm_provider: String,
    pub openai_api_key: Option<String>,
    /// Override for the OpenAI-compatible base URL; lets tests point the
    /// provider at wiremock.
    pub openai_base_url: Option<String>,
    pub openai_model: String,
    /// Path to a Google OAuth client secret JSON. Absent = Google features
    /// render as "not connected".
    pub google_secret_path: Option<PathBuf>,
    /// Where yup-oauth2 persists/refreshes tokens.
    pub google_token_path: PathBuf,
    /// Fixed port for the installed-flow redirect receiver. Google requires
    /// the exact localhost port to be pre-registered on the OAuth client.
    /// 4317 is the app itself, so the skeleton borrows 4319; who owns the
    /// callback sink for real is the connection-flow design (#1 fog).
    pub google_redirect_port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env_parse("PORT", 4317);
        let workspace_dir = PathBuf::from(env_or("WORKSPACE_DIR", "workspace"));
        Self {
            port,
            workspace_dir,
            llm_provider: env_or("LLM_PROVIDER", "mock"),
            openai_api_key: env_opt("OPENAI_API_KEY"),
            openai_base_url: env_opt("OPENAI_BASE_URL"),
            openai_model: env_or("OPENAI_MODEL", "gpt-4o-mini"),
            google_secret_path: env_opt("GOOGLE_CLIENT_SECRET_PATH").map(PathBuf::from),
            google_token_path: env_parse_path("GOOGLE_TOKEN_PATH")
                .unwrap_or_else(|| PathBuf::from("workspace/google-token.json")),
            google_redirect_port: env_parse("GOOGLE_REDIRECT_PORT", 4319),
        }
    }

    /// The single SQLite file under the mounted workspace dir (survey).
    pub fn db_path(&self) -> PathBuf {
        self.workspace_dir.join("chief.db")
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    env_opt(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_parse_path(key: &str) -> Option<PathBuf> {
    env_opt(key).map(PathBuf::from)
}

/// Shared handler state. `llm` is behind the app-local trait so the mock and
/// the rig-backed provider are interchangeable at construction time.
#[derive(Clone)]
pub struct App {
    pub cfg: Config,
    pub db: db::Db,
    pub llm: Arc<dyn llm::LlmProvider>,
}

use std::sync::Arc;

/// One-line app name + version; kept from the stub (issue #8) because the
/// health endpoint and CI boot check grep for it.
pub fn banner() -> String {
    format!("chief-of-rust {}", env!("CARGO_PKG_VERSION"))
}

/// Current wall clock as unix milliseconds — the heartbeat timestamp format.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after the epoch")
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner_names_the_app_and_version() {
        assert_eq!(banner(), "chief-of-rust 0.1.0");
    }
}
