//! Supported text-generation choices, scoped to the protocols our adapters implement.
//! References: docs.mistral.ai/studio/conversations/reasoning,
//! opencode.ai/docs/go, docs.z.ai/api-reference/llm/chat-completion,
//! and Ollama /api/tags + /api/show model metadata (2026-10-15).

pub fn models(provider: &str) -> &'static [&'static str] {
    match provider {
        "mistral" => &["mistral-large-4", "mistral-large-4-0", "mistral-medium-3-5"],
        "opencode" => &["gpt-6-luna", "gpt-5.6-luna", "beam-free"],
        "zai" => &["glm-5.3-flash", "glm-5.3"],
        "ollama-cloud" => &[
            "deepseek-v4.1-flash",
            "deepseek-v4-pro:0813",
            "glm-5.3-flash",
            "glm-5.3",
        ],
        _ => &[],
    }
}

/// Reject unsupported effort values instead of letting an upstream alias silently change intent.
pub fn efforts(provider: &str, model: &str) -> &'static [&'static str] {
    match provider {
        "mistral" => &["none", "high"],
        "opencode" if model == "beam-free" => &["low", "medium", "high", "max"],
        "opencode" => &["low", "medium", "high"],
        "zai" => &["low", "high", "max"],
        "ollama-cloud" if model.starts_with("glm-5.3") => &["low", "high", "max"],
        "ollama-cloud" => &["none", "low", "high", "max"],
        _ => &[],
    }
}
