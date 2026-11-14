use crate::research::*;
use crate::store;
use crate::terminal::automatic::*;
use serde_json::json;

/// A repair changes only rejected content. Reuse a validated judgment only
/// when its entire evidence, candidate, context and question are identical.
/// Cache failures too: unchanged rejected content cannot earn a new roll.
/// The cache lives for one execution and never survives a fresh research run.
#[derive(Default, Serialize, Deserialize)]
pub(super) struct Synthesis {
    pub(super) body: String,
    pub(super) claims: Vec<ClaimRecord>,
    pub(super) identity: Resolution,
    #[serde(default)]
    pub(super) candidates: Vec<Discovery>,
    #[serde(default)]
    pub(super) employment: Option<Employment>,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Resolution {
    pub(super) outcome: String,
    pub(super) existing_id: Option<String>,
    pub(super) explanation: String,
    #[serde(default)]
    pub(super) references: Vec<Reference>,
    #[serde(default)]
    pub(super) alternatives: Vec<IdentityChoice>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Discovery {
    pub(super) identity: Identity,
    pub(super) reason: String,
    pub(super) references: Vec<Reference>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Employment {
    pub(super) company: String,
    pub(super) role: String,
    pub(super) effective_date: Option<String>,
    pub(super) references: Vec<Reference>,
}

// Use the provider's existing constrained-JSON path for extraction. Prompted
// JSON alone allowed malformed reference strings in real acceptance runs.
pub(super) fn synthesis_schema() -> Value {
    fn object(properties: Value) -> Value {
        let required = properties
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
    }
    let text = json!({"type":"string"});
    let nullable_text = json!({"type":["string","null"]});
    let identity = object(json!({
        "kind":{"type":"string","enum":["person","company"]},"name":text,
        "email":text,"role":text,"company":text,"linkedin":text,"website":text,"phone":text,"jurisdiction":text
    }));
    let references = json!({"type":"array","maxItems":6,"items":object(json!({
        "source_id":text,"quote":{"type":"string"}
    }))});
    let scope = object(
        json!({"period":nullable_text,"currency":nullable_text,"unit":nullable_text,
        "entity_scope":nullable_text,"basis":nullable_text,"formula":nullable_text}),
    );
    let claim = object(json!({
        "id":text,"text":{"type":"string"},"entity_id":nullable_text,"topic":text,
        "status":{"type":"string","enum":["supported","self_reported","inference","user_context","unsupported","contradicted","unresolved"]},
        "source_ids":{"type":"array","items":text},"contrary_source_ids":{"type":"array","items":text},
        "metric_scope":{"anyOf":[scope,{"type":"null"}]},"explanation":{"type":"string","const":""}
    }));
    let alternative = object(json!({"identity":identity,"existing_id":nullable_text,
        "explanation":{"type":"string"},"references":references}));
    let resolution = object(
        json!({"outcome":{"type":"string","enum":["resolved","ambiguous"]},
        "existing_id":nullable_text,"explanation":{"type":"string"},"references":references,
        "alternatives":{"type":"array","maxItems":6,"items":alternative}}),
    );
    let employment = object(
        json!({"company":text,"role":text,"effective_date":nullable_text,"references":references}),
    );
    let candidate =
        object(json!({"identity":identity,"reason":{"type":"string"},"references":references}));
    object(json!({"body":{"type":"string","const":""},
        "claims":{"type":"array","maxItems":24,"items":claim},"identity":resolution,
        "employment":{"anyOf":[employment,{"type":"null"}]},"candidates":{"type":"array","maxItems":15,"items":candidate}}))
}

pub(super) async fn phase(app: &App, request: &mut Request, text: &str) -> anyhow::Result<()> {
    request.phase = text.to_owned();
    checkpoint(
        app,
        "terminal_request",
        &request.id,
        &request.id,
        &request.run_id,
        request.clone(),
    )
    .await
}

pub(super) async fn checkpoint<T: Serialize + Send + 'static>(
    app: &App,
    kind: &str,
    id: &str,
    request_id: &str,
    run_id: &str,
    value: T,
) -> anyhow::Result<()> {
    let (kind, id, request_id, run_id) = (
        kind.to_owned(),
        id.to_owned(),
        request_id.to_owned(),
        run_id.to_owned(),
    );
    app.db()
        .transaction(move |tx| {
            let current: Request = store::get(tx, "terminal_request", &request_id)?
                .ok_or_else(|| anyhow::anyhow!("Research request was removed"))?;
            anyhow::ensure!(
                current.status == "researching" && current.run_id == run_id,
                "Research request was replaced or cancelled"
            );
            store::put(tx, &kind, &id, &value)
        })
        .await
}

pub(super) fn context(identity: &Identity, question: &str) -> ResearchContext {
    ResearchContext {
        subject: identity.name.clone(),
        subject_kind: identity.kind.clone(),
        research_date: chrono::Utc::now().to_rfc3339(),
        as_of_date: None,
        depth: "exhaustive".into(),
        presentation: "long".into(),
        geography: identity.jurisdiction.clone(),
        questions: vec![question.into()],
        history: String::new(),
        offering: None,
        internal_sources: vec![],
    }
}

pub(super) fn person(identity: &Identity, id: &str) -> Person {
    Person {
        id: id.into(),
        name: identity.name.clone(),
        email: identity.email.clone(),
        role: identity.role.clone(),
        company: identity.company.clone(),
        profile_url: if identity.website.is_empty() {
            identity.linkedin.clone()
        } else {
            identity.website.clone()
        },
        notes: String::new(),
        archived: false,
        merged_into: None,
        version: 1,
        created_at: crate::now_ms(),
        updated_at: crate::now_ms(),
    }
}

pub(super) fn company(identity: &Identity, id: &str) -> Company {
    Company {
        id: id.into(),
        name: identity.name.clone(),
        website: identity.website.clone(),
        domain: url::Url::parse(&identity.website)
            .ok()
            .and_then(|u| {
                u.host_str()
                    .map(|host| host.trim_start_matches("www.").to_owned())
            })
            .unwrap_or_default(),
        jurisdiction: identity.jurisdiction.clone(),
        identifiers: String::new(),
        aliases: String::new(),
        relationships: String::new(),
        notes: String::new(),
        version: 1,
        created_at: crate::now_ms(),
        updated_at: crate::now_ms(),
    }
}
