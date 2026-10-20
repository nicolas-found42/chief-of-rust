//! Found42's local Chief of Staff: five Rust product areas on one durable
//! SQLite Workspace, rendered as HTML forms and served by axum.

pub mod collect;
pub mod connection;
pub mod content;
pub mod db;
pub mod installation;
pub mod integrations;
pub mod judgments;
pub mod llm;
pub mod meetings;
pub mod pdf;
pub mod people;
pub mod research;
pub mod routes;
pub mod settings;
pub mod sources;
pub mod store;
pub mod tasks;
pub mod terminal;
pub mod web;
pub mod work;

use std::path::PathBuf;

/// Installation defaults and the effective configuration of one request or Run.
/// Defaults come from environment variables, so
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
    /// Repository archive for superseded Terminal dossiers.
    pub terminal_archive_dir: PathBuf,
    pub terminal_limits: TerminalLimits,
    /// Query-Source selection bounds for the Source Registry; installation
    /// overrides clamp to safe bounds and deviations land in
    /// `source_limit_notes` so Run diagnostics can show them.
    pub source_limits: sources::SourceLimits,
    /// One note per clamped or unparseable `CHIEF_SOURCE_*` override; empty
    /// when the installation leaves every limit at its default.
    pub source_limit_notes: Vec<String>,
    /// Explicit generation provider; `mock` is reserved for offline tests.
    pub llm_provider: String,
    pub openrouter_api_key: Option<String>,
    pub typesafe_base_url: Option<String>,
    /// One entry per provider in the installation's provider table
    /// (`installation::providers`); a provider without an entry is not selectable.
    pub mistral: ProviderConfig,
    pub opencode: ProviderConfig,
    pub zai: ProviderConfig,
    pub ollama_cloud: ProviderConfig,
    pub jev_api_key: Option<String>,
    pub jev_model: String,
    pub jev_base_url: Option<String>,
    pub searxng_base_url: Option<String>,
    pub firecrawl_api_key: Option<String>,
    pub firecrawl_base_url: Option<String>,
    /// Independent debrief segment chains; clamped to 1..=4 at execution.
    pub meeting_segment_concurrency: usize,
    /// Path to a Google OAuth client secret JSON. Absent = Google features
    /// render as "not connected".
    pub google_secret_path: Option<PathBuf>,
    /// Private Google access and refresh-token cache.
    pub google_token_path: PathBuf,
}

/// Server-side model connection; credentials are never serialized into Workspace preferences.
#[derive(Clone)]
pub struct ProviderConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: String,
    pub reasoning_effort: String,
}

/// Installation budgets for automatic research; the product requires no
/// per-profile depth or continuation inputs.
#[derive(Clone)]
pub struct TerminalLimits {
    pub collection_seconds: u64,
    pub request_seconds: u64,
    pub rounds: usize,
    pub sources: usize,
}
impl Default for TerminalLimits {
    fn default() -> Self {
        Self {
            collection_seconds: 600,
            request_seconds: 600,
            rounds: 3,
            sources: 80,
        }
    }
}
impl TerminalLimits {
    fn from_env() -> Self {
        Self {
            collection_seconds: env_parse("TERMINAL_COLLECTION_SECONDS", 600u64).clamp(30, 1800),
            request_seconds: env_parse("TERMINAL_REQUEST_SECONDS", 600u64).clamp(30, 1800),
            rounds: env_parse("TERMINAL_MAX_ROUNDS", 3usize).clamp(1, 10),
            sources: env_parse("TERMINAL_MAX_SOURCES", 80usize).clamp(10, 120),
        }
    }
}
impl ProviderConfig {
    fn from_env(prefix: &str, model: &str, effort: &str) -> Self {
        Self {
            api_key: env_opt(&format!("{prefix}_API_KEY")),
            base_url: env_opt(&format!("{prefix}_BASE_URL")),
            model: env_or(&format!("{prefix}_MODEL"), model),
            reasoning_effort: env_or(&format!("{prefix}_REASONING_EFFORT"), effort),
        }
    }
    fn offline(model: &str, effort: &str) -> Self {
        Self {
            api_key: None,
            base_url: None,
            model: model.into(),
            reasoning_effort: effort.into(),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let port = env_parse("PORT", 5317);
        let workspace_dir = PathBuf::from(env_or("WORKSPACE_DIR", "workspace"));
        let (source_limits, source_limit_notes) = sources::SourceLimits::from_env();
        Self {
            port,
            workspace_dir: workspace_dir.clone(),
            terminal_archive_dir: PathBuf::from(env_or("TERMINAL_ARCHIVE_DIR", "archive/terminal")),
            terminal_limits: TerminalLimits::from_env(),
            source_limits,
            source_limit_notes,
            // OpenCode's beam-free is the product default; it is served over Chat
            // Completions and requires the session header the adapter sends.
            llm_provider: env_or("LLM_PROVIDER", "opencode"),
            openrouter_api_key: env_opt("OPENROUTER_API_KEY"),
            typesafe_base_url: env_opt("TYPESAFE_BASE_URL"),
            mistral: ProviderConfig::from_env("MISTRAL", "mistral-large-4", "none"),
            opencode: ProviderConfig::from_env("OPENCODE", "beam-free", "medium"),
            zai: ProviderConfig::from_env("ZAI", "glm-5.3-flash", "low"),
            ollama_cloud: ProviderConfig::from_env(
                "OLLAMA_CLOUD",
                "deepseek-v4.1-flash:1017",
                "high",
            ),
            jev_api_key: env_opt("JEV_API_KEY"),
            jev_model: env_or("JEV_MODEL", "typesafe/jev-1.14"),
            jev_base_url: env_opt("JEV_BASE_URL"),
            searxng_base_url: env_opt("SEARXNG_BASE_URL"),
            firecrawl_api_key: env_opt("FIRECRAWL_API_KEY"),
            firecrawl_base_url: env_opt("FIRECRAWL_BASE_URL"),
            meeting_segment_concurrency: env_parse("MEETING_SEGMENT_CONCURRENCY", 4).clamp(1, 4),
            google_secret_path: env_opt("GOOGLE_CLIENT_SECRET_PATH").map(PathBuf::from),
            google_token_path: env_parse_path("GOOGLE_TOKEN_PATH")
                .unwrap_or_else(|| workspace_dir.join(".credentials/google-token.json")),
        }
    }

    /// An isolated offline configuration that never inherits installation credentials.
    pub fn for_workspace(workspace_dir: PathBuf) -> Self {
        Self {
            port: 5317,
            google_token_path: workspace_dir.join(".credentials/google-token.json"),
            terminal_archive_dir: workspace_dir.join("terminal-archive"),
            terminal_limits: TerminalLimits::default(),
            source_limits: sources::SourceLimits::default(),
            source_limit_notes: Vec::new(),
            workspace_dir,
            llm_provider: "mock".into(),
            openrouter_api_key: None,
            typesafe_base_url: None,
            mistral: ProviderConfig::offline("mistral-large-4", "none"),
            opencode: ProviderConfig::offline("beam-free", "medium"),
            zai: ProviderConfig::offline("glm-5.3-flash", "low"),
            ollama_cloud: ProviderConfig::offline("deepseek-v4.1-flash:1017", "high"),
            jev_api_key: None,
            jev_model: "typesafe/jev-1.14".into(),
            jev_base_url: None,
            searxng_base_url: None,
            firecrawl_api_key: None,
            firecrawl_base_url: None,
            meeting_segment_concurrency: 4,
            google_secret_path: None,
        }
    }

    /// The selected model is recorded with each attempt to preserve provider provenance.
    /// The provider table owns the selection; an unknown name reads as unavailable.
    pub fn llm_model(&self) -> &str {
        match self.llm_provider.as_str() {
            "mock" => "demo fixture",
            name => {
                crate::installation::provider(self, name).map_or("unavailable", |row| row.model)
            }
        }
    }

    /// Keep the displayed effort and the actual request configuration in agreement.
    pub fn llm_effort(&self) -> &str {
        crate::installation::provider(self, &self.llm_provider).map_or("none", |row| row.effort)
    }

    pub fn llm_key(&self) -> Option<&str> {
        crate::installation::provider(self, &self.llm_provider).and_then(|row| row.api_key)
    }

    /// All installation keys must be removed before diagnostics or evidence leave the server.
    pub fn provider_keys(&self) -> impl Iterator<Item = &str> {
        crate::installation::providers(self)
            .into_iter()
            .map(|row| row.api_key)
            .chain([
                self.openrouter_api_key.as_deref(),
                self.jev_api_key.as_deref(),
                self.firecrawl_api_key.as_deref(),
            ])
            .flatten()
            .filter(|key| !key.is_empty())
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

pub use installation::{App, Installation};

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

    /// The 8/12/50 Source limits stay the defaults when the installation
    /// sets nothing, and environment overrides clamp into safe bounds with
    /// every deviation recorded for Run diagnostics (issue #53). No other
    /// lib test reads CHIEF_SOURCE_*, so this test owns them here.
    #[test]
    fn config_source_limits_default_clamp_and_record_deviations() {
        for key in [
            "CHIEF_SOURCE_MIN_PER_SOURCE",
            "CHIEF_SOURCE_MAX_PER_SOURCE",
            "CHIEF_SOURCE_MAX_TOTAL",
        ] {
            unsafe { std::env::remove_var(key) };
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.source_limits, sources::SourceLimits::default());
        assert!(cfg.source_limit_notes.is_empty());

        unsafe {
            std::env::set_var("CHIEF_SOURCE_MIN_PER_SOURCE", "10");
            std::env::set_var("CHIEF_SOURCE_MAX_PER_SOURCE", "500");
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.source_limits.per_source_min, 10);
        assert_eq!(cfg.source_limits.per_source_max, 50);
        assert_eq!(cfg.source_limits.total_max, 50);
        assert_eq!(
            cfg.source_limit_notes,
            vec!["CHIEF_SOURCE_MAX_PER_SOURCE (per-source maximum) 500 clamped to 50".to_string()]
        );

        // An isolated offline workspace never inherits installation overrides.
        let workspace = Config::for_workspace(PathBuf::from("workspace"));
        assert_eq!(workspace.source_limits, sources::SourceLimits::default());
        assert!(workspace.source_limit_notes.is_empty());

        unsafe {
            std::env::remove_var("CHIEF_SOURCE_MIN_PER_SOURCE");
            std::env::remove_var("CHIEF_SOURCE_MAX_PER_SOURCE");
        }
    }
}
