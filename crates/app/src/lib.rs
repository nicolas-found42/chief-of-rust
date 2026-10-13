//! Found42's local Chief of Staff: five Rust product areas on one durable
//! SQLite Workspace, rendered as HTML forms and served by axum.

pub mod content;
pub mod db;
pub mod integrations;
pub mod judgments;
pub mod llm;
pub mod meetings;
pub mod people;
pub mod routes;
pub mod settings;
pub mod store;
pub mod tasks;
pub mod web;
pub mod work;

use std::path::PathBuf;

/// Runtime configuration, all from environment variables with defaults, so
/// the same binary runs locally, in Docker, and in CI with only env changes.
/// Hand-rolled on purpose: the prototype judges the shape before a config
/// crate earns its dependency weight.
#[derive(Clone)]
pub struct Config {
    /// HTTP listen port; loopback-only (standing preference).
    pub port: u16,
    /// Directory for the SQLite file and Google token cache. Docker mounts
    /// the workspace volume here.
    pub workspace_dir: PathBuf,
    /// `mistral` for production, `mock` for explicit offline tests.
    pub llm_provider: String,
    pub mistral_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub typesafe_base_url: Option<String>,
    /// Override for the Mistral API base URL; lets tests point the
    /// provider at wiremock.
    pub mistral_base_url: Option<String>,
    pub mistral_model: String,
    /// Path to a Google OAuth client secret JSON. Absent = Google features
    /// render as "not connected".
    pub google_secret_path: Option<PathBuf>,
    /// Private Google access and refresh-token cache.
    pub google_token_path: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let port = env_parse("PORT", 5317);
        let workspace_dir = PathBuf::from(env_or("WORKSPACE_DIR", "workspace"));
        Self {
            port,
            workspace_dir: workspace_dir.clone(),
            llm_provider: env_or("LLM_PROVIDER", "mistral"),
            mistral_api_key: env_opt("MISTRAL_API_KEY"),
            openrouter_api_key: env_opt("OPENROUTER_API_KEY"),
            typesafe_base_url: env_opt("TYPESAFE_BASE_URL"),
            mistral_base_url: env_opt("MISTRAL_BASE_URL"),
            mistral_model: "mistral-large-4".into(),
            google_secret_path: env_opt("GOOGLE_CLIENT_SECRET_PATH").map(PathBuf::from),
            google_token_path: env_parse_path("GOOGLE_TOKEN_PATH")
                .unwrap_or_else(|| workspace_dir.join(".credentials/google-token.json")),
        }
    }

    /// An explicit offline test configuration; production always uses Mistral.
    pub fn for_workspace(workspace_dir: PathBuf) -> Self {
        Self {
            port: 5317,
            google_token_path: workspace_dir.join(".credentials/google-token.json"),
            workspace_dir,
            llm_provider: "mock".into(),
            mistral_api_key: None,
            openrouter_api_key: None,
            typesafe_base_url: None,
            mistral_base_url: None,
            mistral_model: "mistral-large-4".into(),
            google_secret_path: None,
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
/// the production Mistral provider are interchangeable in explicit tests.
#[derive(Clone)]
pub struct App {
    pub cfg: Config,
    pub db: db::Db,
    pub llm: Arc<dyn llm::LlmProvider>,
    pub judge: Arc<dyn judgments::Judge>,
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
