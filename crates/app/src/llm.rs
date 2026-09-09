//! The app-local LLM seam (survey #3): every provider sits behind
//! [`LlmProvider`], so rig stays an implementation detail of this module and
//! the hand mock is just another implementor. The fallback if rig churns is
//! hand-rolled reqwest clients — nothing outside this module would change.

use async_trait::async_trait;

use std::sync::Arc;

use rig_core::client::CompletionClient;
use rig_core::completion::{AssistantContent, CompletionRequestBuilder, Message};
use rig_core::providers::openai::CompletionsClient;

use crate::Config;

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Short name shown on the page and recorded with each call.
    fn name(&self) -> &'static str;
    async fn complete(&self, prompt: &str) -> anyhow::Result<String>;
}

/// Offline default: no network, no key, deterministic reply. The app boots
/// and CI runs with this.
pub struct MockLlm;

#[async_trait]
impl LlmProvider for MockLlm {
    fn name(&self) -> &'static str {
        "mock"
    }

    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        Ok(format!("[mock] you said: {prompt}"))
    }
}

/// OpenAI-compatible chat completions through rig. `base_url` is
/// configurable so tests point it at wiremock; unset means api.openai.com.
pub struct RigLlm {
    client: CompletionsClient,
    model: String,
}

impl RigLlm {
    pub fn new(api_key: &str, base_url: Option<&str>, model: &str) -> anyhow::Result<Self> {
        let mut builder = CompletionsClient::builder().api_key(api_key.to_string());
        if let Some(base_url) = base_url {
            builder = builder.base_url(base_url);
        }
        Ok(Self {
            client: builder.build()?,
            model: model.to_string(),
        })
    }
}

#[async_trait]
impl LlmProvider for RigLlm {
    fn name(&self) -> &'static str {
        "openai"
    }

    async fn complete(&self, prompt: &str) -> anyhow::Result<String> {
        let response = CompletionRequestBuilder::new(
            self.client.completion_model(&self.model),
            Message::user(prompt),
        )
        .send()
        .await?;
        let text = response
            .choice
            .into_iter()
            .find_map(|content| match content {
                AssistantContent::Text(t) => Some(t.text),
                _ => None,
            })
            .unwrap_or_default();
        Ok(text)
    }
}

/// Build the provider the config asks for, falling back to the mock (with a
/// loud note) when the real one is misconfigured — the app must always boot.
pub fn from_config(cfg: &Config) -> Arc<dyn LlmProvider> {
    if cfg.llm_provider == "openai" {
        if let Some(key) = &cfg.openai_api_key {
            match RigLlm::new(key, cfg.openai_base_url.as_deref(), &cfg.openai_model) {
                Ok(provider) => return Arc::new(provider),
                Err(error) => {
                    tracing::error!(%error, "openai provider failed to build; using mock")
                }
            }
        } else {
            tracing::error!("LLM_PROVIDER=openai but OPENAI_API_KEY is unset; using mock");
        }
    }
    Arc::new(MockLlm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_answers_deterministically() {
        let reply = MockLlm.complete("hello").await.unwrap();
        assert_eq!(reply, "[mock] you said: hello");
    }
}
