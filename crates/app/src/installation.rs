//! The installation: the provider table, the connections, and the only place
//! an [`App`] is built.
//!
//! Routes and Runs receive an [`App`]; they cannot assemble one, and its fields
//! stay private so a hand-written literal no longer compiles. Construction is
//! the installation's job — which model and judgment connections exist, which
//! workspace they run over, and which pacing clock they use — so the answer to
//! "how is this running?" lives in one module instead of at every call site.
use crate::{
    Config,
    collect::Pacer,
    db::Db,
    judgments::{self, Judge},
    llm::{self, LlmProvider},
};
use std::{path::PathBuf, sync::Arc};

/// Shared handler state and the per-Run handle. `llm` is behind the app-local
/// trait so the mock and the selected live provider are interchangeable.
#[derive(Clone)]
pub struct App {
    cfg: Config,
    db: Db,
    llm: Arc<dyn LlmProvider>,
    judge: Arc<dyn Judge>,
    pacer: Arc<Pacer>,
}

impl App {
    pub fn cfg(&self) -> &Config {
        &self.cfg
    }
    pub fn db(&self) -> &Db {
        &self.db
    }
    pub fn llm(&self) -> &Arc<dyn LlmProvider> {
        &self.llm
    }
    pub fn judge(&self) -> &Arc<dyn Judge> {
        &self.judge
    }
    pub fn pacer(&self) -> &Arc<Pacer> {
        &self.pacer
    }

    /// The same handle with a different configuration. Provider settings, a
    /// test's changed endpoint and a Run's own selection all rebind rather than
    /// mutate, so a handle in flight never changes under its callers.
    pub fn with_cfg(&self, cfg: Config) -> Self {
        Self {
            cfg,
            db: self.db.clone(),
            llm: self.llm.clone(),
            judge: self.judge.clone(),
            pacer: self.pacer.clone(),
        }
    }

    /// The same handle with a different model connection.
    pub fn with_llm(&self, llm: Arc<dyn LlmProvider>) -> Self {
        Self {
            cfg: self.cfg.clone(),
            llm,
            judge: self.judge.clone(),
            db: self.db.clone(),
            pacer: self.pacer.clone(),
        }
    }

    /// The same handle with a different judgment connection.
    pub fn with_judge(&self, judge: Arc<dyn Judge>) -> Self {
        Self {
            cfg: self.cfg.clone(),
            llm: self.llm.clone(),
            judge,
            db: self.db.clone(),
            pacer: self.pacer.clone(),
        }
    }
}

/// One selectable model provider: the credential that pays for it, the endpoint
/// that serves it, and the model and effort an installation with no saved
/// selection runs. Provider names are the vocabulary `LLM_PROVIDER`, saved
/// selections and job payloads use, so a provider is added to the table once
/// and every reader follows.
pub struct Provider<'a> {
    pub name: &'static str,
    /// Installation credential; absent means the provider is not configured.
    pub api_key: Option<&'a str>,
    /// Installation endpoint override; `None` means the provider default.
    pub base_url: Option<&'a str>,
    pub model: &'a str,
    pub effort: &'a str,
}

impl Provider<'_> {
    /// The endpoint this provider is reached at: the installation's override or
    /// the provider's default, validated as a provider URL. Resolving it here
    /// keeps every connection on the same rule.
    pub fn endpoint(&self) -> anyhow::Result<String> {
        crate::llm::providers::endpoint(match self.base_url {
            Some(base) => base,
            None => default_base(self.name)?,
        })
    }
}

/// The provider table: every model provider the installation can select, in one
/// place. A name without a row is not a provider, which is how an unknown
/// `LLM_PROVIDER` is refused instead of silently falling back to a model.
pub fn providers(cfg: &Config) -> [Provider<'_>; 4] {
    [
        row("mistral", &cfg.mistral),
        row("opencode", &cfg.opencode),
        row("zai", &cfg.zai),
        row("ollama-cloud", &cfg.ollama_cloud),
    ]
}

fn row<'a>(name: &'static str, settings: &'a crate::ProviderConfig) -> Provider<'a> {
    Provider {
        name,
        api_key: settings.api_key.as_deref(),
        base_url: settings.base_url.as_deref(),
        model: &settings.model,
        effort: &settings.reasoning_effort,
    }
}

/// The table row for one provider name, or `None` when the name is not a provider.
pub fn provider<'a>(cfg: &'a Config, name: &str) -> Option<Provider<'a>> {
    providers(cfg).into_iter().find(|row| row.name == name)
}

/// The provider names a configuration can select, for diagnostics and refusals.
pub fn provider_names() -> impl Iterator<Item = &'static str> {
    ["mistral", "opencode", "zai", "ollama-cloud"].into_iter()
}

/// The documented default endpoint of one provider, used when the installation
/// supplies no override.
pub fn default_base(name: &str) -> anyhow::Result<&'static str> {
    Ok(match name {
        "mistral" => "https://api.mistral.ai/v1",
        "opencode" => "https://opencode.ai/inference/go/v1",
        "zai" => "https://api.z.ai/api/coding/paas/v4",
        "ollama-cloud" => "https://ollama.com/v1",
        _ => anyhow::bail!("Unknown model provider"),
    })
}

/// The stored model and effort of one provider, for the settings routes that
/// edit a saved selection. The table above reads the same fields back.
pub(crate) fn provider_settings_mut<'a>(
    cfg: &'a mut Config,
    name: &str,
) -> Option<(&'a mut String, &'a mut String)> {
    let settings = match name {
        "mistral" => &mut cfg.mistral,
        "opencode" => &mut cfg.opencode,
        "zai" => &mut cfg.zai,
        "ollama-cloud" => &mut cfg.ollama_cloud,
        _ => return None,
    };
    Some((&mut settings.model, &mut settings.reasoning_effort))
}

/// The installation behind one process: what it runs over, and the provider
/// table, model connection and judgment connection it was built from.
pub struct Installation {
    cfg: Config,
    db: Db,
    llm: Arc<dyn LlmProvider>,
    judge: Arc<dyn Judge>,
    pacer: Arc<Pacer>,
}

impl Installation {
    /// The installation the environment describes.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::for_config(Config::from_env())
    }

    /// An installation over the workspace this configuration names, with the
    /// model and judgment connections the configuration describes. This is the
    /// only place those connections are derived from configuration.
    pub fn for_config(cfg: Config) -> anyhow::Result<Self> {
        let db = Db::open(&cfg.db_path())?;
        Ok(Self {
            llm: llm::from_config(&cfg),
            judge: judgments::from_config(&cfg),
            pacer: Arc::new(Pacer::system()),
            cfg,
            db,
        })
    }

    /// An offline installation over one workspace directory: the mock posture,
    /// no credentials and no network. Tests use it, then inject the model and
    /// judgment connections they want to observe.
    pub fn for_workspace(dir: PathBuf) -> Self {
        // A workspace the caller just supplied is the caller's to make usable;
        // there is no recovery here that the caller could act on.
        Self::for_config(Config::for_workspace(dir)).expect("open the workspace database")
    }

    /// An installation whose connections are supplied explicitly. This is the
    /// seam a test uses to run the real routes and worker over a fixture model
    /// and judge instead of the installation's.
    pub fn with_connections(
        cfg: Config,
        db: Db,
        llm: Arc<dyn LlmProvider>,
        judge: Arc<dyn Judge>,
        pacer: Arc<Pacer>,
    ) -> Self {
        Self {
            cfg,
            db,
            llm,
            judge,
            pacer,
        }
    }

    /// The per-request handle: the installation's connections, shared by every
    /// handler and Run that gets it.
    pub fn app(&self) -> App {
        App {
            cfg: self.cfg.clone(),
            db: self.db.clone(),
            llm: self.llm.clone(),
            judge: self.judge.clone(),
            pacer: self.pacer.clone(),
        }
    }
}
