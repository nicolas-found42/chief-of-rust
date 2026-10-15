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

const GENERATION: [(&str, &str); 4] = [
    ("mistral", "Mistral"),
    ("opencode", "OpenCode"),
    ("zai", "Z.AI"),
    ("ollama-cloud", "Ollama Cloud"),
];
const SEARCH: [(&str, &str); 2] = [("searxng", "SearXNG"), ("firecrawl", "Firecrawl")];

/// Only routing choices are saved; credentials and model configuration remain server-side.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ProviderSettings {
    pub revision: u64,
    pub generation: Option<String>,
    pub search: Option<String>,
}

pub async fn load(db: &Db) -> anyhow::Result<ProviderSettings> {
    Ok(db.get("settings", "providers").await?.unwrap_or_default())
}

/// Snapshot a saved selection once per diagnostic or Run; in-flight calls keep their provider.
pub async fn resolve(app: &App) -> anyhow::Result<App> {
    Ok(apply(app.clone(), &load(&app.db).await?))
}

pub(super) fn apply(mut app: App, settings: &ProviderSettings) -> App {
    if let Some(provider) = &settings.generation
        && *provider != app.cfg.llm_provider
    {
        app.cfg.llm_provider = provider.clone();
        app.llm = llm::from_config(&app.cfg);
    }
    if let Some(provider) = &settings.search {
        app.cfg.search_provider = provider.clone();
    }
    app
}

pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/settings/providers", post(save))
        .route("/settings/providers/search-test", post(test_search))
        .route("/settings/providers/judgment-test", post(test_judgment))
}

pub(super) fn panel(app: &App, settings: &ProviderSettings) -> String {
    let mut generation = format!(
        "<option value=\"\" {}>Installation default</option>",
        if settings.generation.is_none() {
            "selected"
        } else {
            ""
        }
    );
    for (provider, label) in GENERATION {
        let mut cfg = app.cfg.clone();
        cfg.llm_provider = provider.into();
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
    let mut search = format!(
        "<option value=\"\" {}>Installation default</option>",
        if settings.search.is_none() {
            "selected"
        } else {
            ""
        }
    );
    for (provider, label) in SEARCH {
        let missing = provider == "firecrawl" && app.cfg.firecrawl_api_key.is_none();
        search.push_str(&format!(
            "<option value=\"{provider}\" {} {}>{label}{}</option>",
            if settings.search.as_deref() == Some(provider) {
                "selected"
            } else {
                ""
            },
            if missing && settings.search.as_deref() != Some(provider) {
                "disabled"
            } else {
                ""
            },
            if missing { " · missing API key" } else { "" }
        ));
    }
    let effort = match app.cfg.llm_provider.as_str() {
        "opencode" => &app.cfg.opencode.reasoning_effort,
        "zai" => &app.cfg.zai.reasoning_effort,
        "ollama-cloud" => &app.cfg.ollama_cloud.reasoning_effort,
        _ => "none",
    };
    format!(
        "<h2>Providers</h2><p>Generation: <strong>{}</strong> · <code>{}</code> · reasoning {}</p><p>Search: <strong>{}</strong></p><form method=\"post\" action=\"/settings/providers\"><input type=\"hidden\" name=\"revision\" value=\"{}\"><label>Generation provider<select name=\"generation\">{generation}</select></label><label>Search provider<select name=\"search\">{search}</select></label><button>Save providers</button></form><p>Save your choices before testing. Changes apply to new tests and Runs when they start. Running work keeps its provider. Choices survive restarts; API keys stay in the server environment.</p><h3>Model diagnostic</h3><form method=\"post\" action=\"/llm\"><label>Prompt<input name=\"prompt\" required maxlength=\"2000\" value=\"Reply with exactly the word READY.\"></label><button>Test selected model</button></form><h3>Search diagnostic</h3><form method=\"post\" action=\"/settings/providers/search-test\"><label>Search query<input name=\"query\" required maxlength=\"500\" value=\"Rust programming language official documentation\"></label><button>Test selected search provider</button></form><h3>Evidence judgments</h3><p>Jev · <code>{}</code> · {}</p><form method=\"post\" action=\"/settings/providers/judgment-test\"><button>Test Jev connection</button></form><p>Tests call your configured services and may use account credits.</p>",
        escape(&app.cfg.llm_provider),
        escape(app.cfg.llm_model()),
        escape(effort),
        escape(&app.cfg.search_provider),
        settings.revision,
        escape(&app.cfg.jev_model),
        if app.judge.available() {
            "Configured"
        } else {
            "Missing API key"
        }
    )
}

#[derive(Deserialize)]
struct Selection {
    revision: u64,
    generation: String,
    search: String,
}
async fn save(State(app): State<App>, Form(form): Form<Selection>) -> web::Result<Redirect> {
    if !form.generation.is_empty() {
        if !GENERATION.iter().any(|(name, _)| *name == form.generation) {
            return Err(web::Error::bad_request(
                "Choose a supported generation provider.",
            ));
        }
        let mut cfg = app.cfg.clone();
        cfg.llm_provider = form.generation.clone();
        if cfg.llm_key().is_none() {
            return Err(web::Error::bad_request(
                "This generation provider is missing its API key. Configure it in the installation environment first.",
            ));
        }
    }
    if !form.search.is_empty() && !SEARCH.iter().any(|(name, _)| *name == form.search) {
        return Err(web::Error::bad_request(
            "Choose a supported search provider.",
        ));
    }
    if form.search == "firecrawl" && app.cfg.firecrawl_api_key.is_none() {
        return Err(web::Error::bad_request(
            "Firecrawl is missing its API key. Configure it in the installation environment first.",
        ));
    }
    let saved = app
        .db
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
                search: (!form.search.is_empty()).then_some(form.search),
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

pub(crate) fn failure(error: anyhow::Error, app: &App) -> Response {
    let message = llm::redact_error(&error.to_string(), &app.cfg);
    let mut response = web::page(
        "Provider test failed",
        format!(
            "<p role=\"alert\">{}</p><p><a href=\"/settings\">Return to Settings</a></p>",
            escape(&message)
        ),
    );
    *response.status_mut() = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
    response
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
        Err(error) => return Ok(failure(error, &app)),
    };
    let mut body = format!(
        "<p><strong>{}</strong> returned {} usable results.</p>{}<ul>",
        escape(&app.cfg.search_provider),
        results.hits.len(),
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
    Ok(web::page("Search diagnostic", body))
}
async fn test_judgment(State(app): State<App>) -> web::Result<Response> {
    let result = app.judge.evaluate(json!("Two plus two equals four."), json!({"correct":{"type":"noul","instructions":"Is the arithmetic statement correct?"}})).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => return Ok(failure(error, &app)),
    };
    let probability = crate::judgments::probability(&result.answers["correct"]["noul"])?;
    Ok(web::page(
        "Jev diagnostic",
        format!(
            "<p>Jev returned a valid typed judgment.</p><p>Model: <code>{}</code></p><p>Probability that the test statement is correct: {:.3}</p><a href=\"/settings\">Return to Settings</a>",
            escape(&result.model),
            probability
        ),
    ))
}
