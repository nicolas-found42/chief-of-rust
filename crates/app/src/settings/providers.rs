//! Saved provider choices are independent of account preferences and installation secrets.
use crate::{
    App,
    db::Db,
    llm, store,
    web::{self, escape},
};
use axum::{
    Router,
    extract::{Form, State},
    response::{Redirect, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

const GENERATION: [(&str, &str); 4] = [
    ("mistral", "Mistral"),
    ("opencode", "OpenCode"),
    ("zai", "Z.AI"),
    ("ollama-cloud", "Ollama Cloud"),
];

/// Non-secret generation overrides are remembered separately for each provider.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct ModelSettings {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// Credentials and endpoints stay server-side; choices persist in the Workspace.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ProviderSettings {
    pub revision: u64,
    pub generation: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub models: BTreeMap<String, ModelSettings>,
}

pub async fn load(db: &Db) -> anyhow::Result<ProviderSettings> {
    Ok(db.get("settings", "providers").await?.unwrap_or_default())
}

/// Snapshot a saved selection once per diagnostic or Run; in-flight calls keep their provider.
pub async fn resolve(app: &App) -> anyhow::Result<App> {
    Ok(apply(app.clone(), &load(app.db()).await?))
}

pub(super) fn apply(app: App, settings: &ProviderSettings) -> App {
    let before = (
        app.cfg().llm_provider.clone(),
        app.cfg().llm_model().to_owned(),
        app.cfg().llm_effort().to_owned(),
    );
    let mut cfg = app.cfg().clone();
    if let Some(provider) = &settings.generation {
        cfg.llm_provider = provider.clone();
    }
    let provider = cfg.llm_provider.clone();
    apply_model(&mut cfg, &provider, settings.models.get(&provider));
    let after = (
        cfg.llm_provider.clone(),
        cfg.llm_model().to_owned(),
        cfg.llm_effort().to_owned(),
    );
    let llm = if before == after {
        app.llm().clone()
    } else {
        llm::from_config(&cfg)
    };
    app.with_cfg(cfg).with_llm(llm)
}

fn apply_model(cfg: &mut crate::Config, provider: &str, profile: Option<&ModelSettings>) {
    let Some(profile) = profile else {
        return;
    };
    let Some((model, effort)) = crate::installation::provider_settings_mut(cfg, provider) else {
        return;
    };
    if let Some(value) = &profile.model {
        *model = value.clone();
    }
    if let Some(value) = &profile.reasoning_effort {
        *effort = value.clone();
    }
}

pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/settings/providers", post(save))
        .route("/settings/providers/models", post(save_model))
        .route("/settings/providers/search-test", post(test_search))
        .route("/settings/providers/judgment-test", post(test_judgment))
}

pub(super) fn panel(base: &App, settings: &ProviderSettings) -> String {
    let app = apply(base.clone(), settings);
    let model_controls = model_panel(base, &app, settings);
    let mut generation = format!(
        "<option value=\"\" {}>Installation default</option>",
        if settings.generation.is_none() {
            "selected"
        } else {
            ""
        }
    );
    for (provider, label) in GENERATION {
        let mut cfg = base.cfg().clone();
        cfg.llm_provider = provider.into();
        apply_model(&mut cfg, provider, settings.models.get(provider));
        generation.push_str(&format!(
            "<option value=\"{provider}\" {} {}>{label} · {}{}</option>",
            if settings.generation.as_deref() == Some(provider) {
                "selected"
            } else {
                ""
            },
            if cfg.llm_key().is_none() && settings.generation.as_deref() != Some(provider) {
                "disabled"
            } else {
                ""
            },
            escape(cfg.llm_model()),
            if cfg.llm_key().is_some() {
                ""
            } else {
                " · missing API key"
            }
        ));
    }
    let names = crate::integrations::search_providers(app.cfg());
    let search = if names.is_empty() {
        "Not configured".into()
    } else {
        names.join(" + ")
    };
    let effort = app.cfg().llm_effort();
    format!(
        "<h2>Providers</h2><p>Generation: <strong>{}</strong> · <code>{}</code> · reasoning {}</p><p>Search: <strong>{}</strong></p><p>Every search calls all configured search services and combines their results. Configure SearXNG with SEARXNG_BASE_URL and Firecrawl with FIRECRAWL_API_KEY.</p><form method=\"post\" action=\"/settings/providers\"><input type=\"hidden\" name=\"revision\" value=\"{}\"><label>Generation provider<select name=\"generation\">{generation}</select></label><button class=\"btn-primary\">Save providers</button></form><p>Save your choices before testing. Changes apply to new tests and Runs when they start. Running work keeps its provider. Choices survive restarts; API keys stay in the server environment.</p>{model_controls}<h3>Model diagnostic</h3><form method=\"post\" action=\"/llm\"><label>Prompt<input name=\"prompt\" required maxlength=\"2000\" value=\"Reply with exactly the word READY.\"></label><button class=\"btn-primary\">Test selected model</button></form><h3>Search diagnostic</h3><form method=\"post\" action=\"/settings/providers/search-test\"><label>Search query<input name=\"query\" required maxlength=\"500\" value=\"Rust programming language official documentation\"></label><button class=\"btn-primary\">Test search services</button></form><h3>Evidence judgments</h3><p>Jev · <code>{}</code> · {}</p><form method=\"post\" action=\"/settings/providers/judgment-test\"><button class=\"btn-primary\">Test Jev connection</button></form><p>Tests call your configured services and may use account credits.</p>",
        escape(&app.cfg().llm_provider),
        escape(app.cfg().llm_model()),
        escape(effort),
        escape(&search),
        settings.revision,
        escape(&app.cfg().jev_model),
        escape(app.judge().reason().unwrap_or("Configured"))
    )
}

#[derive(Deserialize)]
struct Selection {
    revision: u64,
    generation: String,
}
async fn save(State(app): State<App>, Form(form): Form<Selection>) -> web::Result<Redirect> {
    if !form.generation.is_empty() {
        if !GENERATION.iter().any(|(name, _)| *name == form.generation) {
            return Err(web::Error::bad_request(
                "Choose a supported generation provider.",
            ));
        }
        let mut cfg = app.cfg().clone();
        cfg.llm_provider = form.generation.clone();
        if cfg.llm_key().is_none() {
            return Err(web::Error::bad_request(
                "This generation provider is missing its API key. Configure it in the installation environment first.",
            ));
        }
    }
    let saved = app
        .db()
        .transaction(move |tx| {
            let old: ProviderSettings =
                store::get(tx, "settings", "providers")?.unwrap_or_default();
            if old.revision != form.revision {
                return Ok(false);
            }
            let settings = ProviderSettings {
                revision: old
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Provider revision overflow"))?,
                generation: (!form.generation.is_empty()).then_some(form.generation),
                models: old.models,
            };
            store::put(tx, "settings", "providers", &settings)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(web::Error::conflict(
            "Provider choices changed in another tab. Reload before saving.",
        ));
    }
    Ok(Redirect::to("/settings"))
}

fn model_panel(base: &App, app: &App, settings: &ProviderSettings) -> String {
    let provider = app.cfg().llm_provider.as_str();
    if llm::catalog::models(provider).is_empty() {
        return String::new();
    }
    let profile = settings.models.get(provider).cloned().unwrap_or_default();
    let mut defaults = base.cfg().clone();
    defaults.llm_provider = provider.into();
    let selected_model = profile
        .model
        .clone()
        .unwrap_or_else(|| defaults.llm_model().to_owned());
    let mut models = format!(
        "<option value=\"\" {}>Installation default · {}</option>",
        if profile.model.is_none() {
            "selected"
        } else {
            ""
        },
        escape(defaults.llm_model())
    );
    for model in llm::catalog::models(provider) {
        models.push_str(&format!(
            "<option value=\"{}\" {}>{}</option>",
            escape(model),
            if profile.model.as_deref() == Some(*model) {
                "selected"
            } else {
                ""
            },
            escape(model)
        ));
    }
    let mut efforts = format!(
        "<option value=\"\" {}>Installation default · {}</option>",
        if profile.reasoning_effort.is_none() {
            "selected"
        } else {
            ""
        },
        escape(defaults.llm_effort())
    );
    for effort in llm::catalog::efforts(provider, &selected_model) {
        efforts.push_str(&format!(
            "<option value=\"{effort}\" {}>{effort}</option>",
            if profile.reasoning_effort.as_deref() == Some(*effort) {
                "selected"
            } else {
                ""
            }
        ));
    }
    format!(
        "<h3>Model and reasoning</h3><form method=\"post\" action=\"/settings/providers/models\"><input type=\"hidden\" name=\"revision\" value=\"{}\"><input type=\"hidden\" name=\"provider\" value=\"{}\"><label>Model<select name=\"model\">{models}</select></label><label>Reasoning effort<select name=\"reasoning_effort\">{efforts}</select></label><button class=\"btn-primary\">Save model settings</button></form><p>Choices are remembered for each provider. Effort support varies by model; unsupported combinations leave your saved settings unchanged.</p>",
        settings.revision,
        escape(provider)
    )
}

#[derive(Deserialize)]
struct ModelSelection {
    revision: u64,
    provider: String,
    model: String,
    reasoning_effort: String,
}
async fn save_model(
    State(app): State<App>,
    Form(form): Form<ModelSelection>,
) -> web::Result<Redirect> {
    if !GENERATION
        .iter()
        .any(|(provider, _)| *provider == form.provider)
    {
        return Err(web::Error::bad_request(
            "Choose a supported generation provider.",
        ));
    }
    if !form.model.is_empty()
        && !llm::catalog::models(&form.provider).contains(&form.model.as_str())
    {
        return Err(web::Error::bad_request(
            "Choose a supported model for this provider.",
        ));
    }
    let profile = ModelSettings {
        model: (!form.model.is_empty()).then_some(form.model),
        reasoning_effort: (!form.reasoning_effort.is_empty()).then_some(form.reasoning_effort),
    };
    let mut cfg = app.cfg().clone();
    cfg.llm_provider = form.provider.clone();
    apply_model(&mut cfg, &form.provider, Some(&profile));
    if cfg.llm_key().is_none() {
        return Err(web::Error::bad_request(
            "Configure this provider's API key before changing its model.",
        ));
    }
    // Existing installation values remain usable when both overrides are reset.
    // Explicit choices must have the provider's documented semantics rather than upstream aliasing.
    if (profile.model.is_some() || profile.reasoning_effort.is_some())
        && !llm::catalog::efforts(&form.provider, cfg.llm_model()).contains(&cfg.llm_effort())
    {
        return Err(web::Error::bad_request(format!(
            "{} supports reasoning effort: {}. Choose one of these or reset to installation defaults.",
            cfg.llm_model(),
            llm::catalog::efforts(&form.provider, cfg.llm_model()).join(", ")
        )));
    }
    let saved = app
        .db()
        .transaction(move |tx| {
            let mut old: ProviderSettings =
                store::get(tx, "settings", "providers")?.unwrap_or_default();
            if old.revision != form.revision {
                return Ok(false);
            }
            old.revision = old
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Provider revision overflow"))?;
            if profile.model.is_none() && profile.reasoning_effort.is_none() {
                old.models.remove(&form.provider);
            } else {
                old.models.insert(form.provider, profile);
            }
            store::put(tx, "settings", "providers", &old)?;
            Ok(true)
        })
        .await?;
    if !saved {
        return Err(web::Error::conflict(
            "Provider choices changed in another tab. Reload before saving.",
        ));
    }
    Ok(Redirect::to("/settings"))
}

pub(crate) fn failure(error: anyhow::Error, app: &App) -> Response {
    let message = llm::redact_error(&error.to_string(), app.cfg());
    let mut response = web::page(
        "Provider test failed",
        web::Body::new(format!(
            "<p role=\"alert\">{}</p><p><a href=\"/settings\">Return to Settings</a></p>",
            escape(&message)
        )),
    );
    *response.status_mut() = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
    response
}

fn search_diagnostics(diagnostics: &[crate::integrations::SearchProviderDiagnostic]) -> String {
    let mut html = String::from(
        "<table><caption>Search provider diagnostics</caption><thead><tr><th scope=\"col\">Provider</th><th scope=\"col\">Status</th><th scope=\"col\">Results returned</th><th scope=\"col\">Elapsed</th></tr></thead><tbody>",
    );
    for diagnostic in diagnostics {
        let provider = match diagnostic.provider.as_str() {
            "searxng" => "SearXNG",
            "firecrawl" => "Firecrawl",
            name => name,
        };
        let count = diagnostic
            .result_count
            .map(|n| n.to_string())
            .unwrap_or_else(|| "—".into());
        let elapsed = diagnostic
            .elapsed_ms
            .map(|n| format!("{n} ms"))
            .unwrap_or_else(|| "—".into());
        html.push_str(&format!(
            "<tr><th scope=\"row\">{}</th><td>{}{}</td><td>{}</td><td>{}</td></tr>",
            escape(provider),
            diagnostic.status.label(),
            diagnostic
                .error
                .as_deref()
                .map(|error| format!("<br>{}", escape(error)))
                .unwrap_or_default(),
            count,
            elapsed
        ));
    }
    html.push_str("</tbody></table><p>Counts are returned rows before URL filtering, deduplication and the twelve-per-source Registry limit. Elapsed time includes the provider request and response parsing. A dash means no measurement is available.</p>");
    html
}

#[derive(Deserialize)]
struct SearchTest {
    query: String,
}
async fn test_search(
    State(app): State<App>,
    Form(form): Form<SearchTest>,
) -> web::Result<Response> {
    let app = resolve(&app).await?;
    let query = web::required(&form.query, "Search query", 2000)?;
    let results = match crate::integrations::search(&app, &query).await {
        Ok(results) => results,
        Err(error) => {
            if let Some(search) = error.downcast_ref::<crate::integrations::SearchFailure>() {
                let mut response = web::page(
                    "Search diagnostic",
                    web::Body::new(format!(
                        "<p role=\"alert\">{}</p>{}<p><a href=\"/settings\">Return to Settings</a></p>",
                        escape(&llm::redact_error(&error.to_string(), app.cfg())),
                        search_diagnostics(&search.diagnostics),
                    )),
                );
                *response.status_mut() = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
                return Ok(response);
            }
            return Ok(failure(error, &app));
        }
    };
    let mut body = format!(
        "<p><strong>{}</strong> returned {} usable results.</p>{}{}<ul>",
        escape(&crate::integrations::search_providers(app.cfg()).join(" + ")),
        results.hits.len(),
        search_diagnostics(&results.diagnostics),
        web::search_coverage(&results.coverage)
    );
    for hit in results.hits {
        body.push_str(&format!(
            "<li><a href=\"{}\" rel=\"noreferrer\">{}</a><p>{}</p></li>",
            escape(&hit.url),
            escape(&hit.title),
            escape(&hit.content)
        ));
    }
    body.push_str("</ul><a href=\"/settings\">Return to Settings</a>");
    Ok(web::page("Search diagnostic", web::Body::new(body)))
}
async fn test_judgment(State(app): State<App>) -> web::Result<Response> {
    let result = app.judge().evaluate(json!("Two plus two equals four."), json!({"correct":{"type":"noul","instructions":"Is the arithmetic statement correct?"}})).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => return Ok(failure(error, &app)),
    };
    let probability = crate::judgments::probability(&result.answers["correct"]["noul"])?;
    Ok(web::page(
        "Jev diagnostic",
        web::Body::new(format!(
            "<p>Jev returned a valid typed judgment.</p><p>Model: <code>{}</code></p><p>Probability that the test statement is correct: {:.3}</p><a href=\"/settings\">Return to Settings</a>",
            escape(&result.model),
            probability
        )),
    ))
}
