//! Server-side TypeSafe primitives; code validates contracts and owns policy.
use crate::Config;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evaluation {
    pub model: String,
    #[serde(default)]
    pub warnings: Vec<Value>,
    pub answers: BTreeMap<String, Value>,
    pub usage: Usage,
}

/// Keeps real HTTP judgments replaceable by explicit fixtures in offline tests.
#[async_trait]
pub trait Judge: Send + Sync {
    /// Why judgments cannot run, or `None` when they can. This is the one
    /// interface for availability: the message a user is shown comes from the
    /// installed configuration here, never from the call site.
    fn reason(&self) -> Option<&str> {
        None
    }
    /// Convenience for gates that only branch. Derived from `reason`, so the
    /// boolean and the message can never disagree.
    fn available(&self) -> bool {
        self.reason().is_none()
    }
    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation>;
}

pub struct TypeSafe {
    client: reqwest::Client,
    key: String,
    endpoint: String,
    model: String,
}
impl TypeSafe {
    pub fn new(key: &str, base_url: Option<&str>) -> anyhow::Result<Self> {
        Self::with_model(key, base_url, "typesafe/jev-1.14")
    }
    pub fn with_model(key: &str, base_url: Option<&str>, model: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(!model.trim().is_empty(), "JEV_MODEL is missing");
        anyhow::ensure!(
            !key.trim().is_empty(),
            "Set JEV_API_KEY or OPENROUTER_API_KEY to enable evidence judgments for meeting debriefs."
        );
        let base = base_url
            .unwrap_or("https://openrouter.ai/api")
            .trim_end_matches('/');
        let url = url::Url::parse(base)?;
        anyhow::ensure!(
            url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
            "TypeSafe endpoint must use HTTPS (loopback HTTP is allowed for tests)"
        );
        anyhow::ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "TypeSafe endpoint must not contain credentials, a query or fragment"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(90))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            key: key.into(),
            endpoint: format!("{base}/v1/systemone"),
            model: model.into(),
        })
    }
}

/// Reject a malformed question map before the request leaves the process.
///
/// The provider answers 400 for a question that lacks its required fields, and
/// its diagnostic cannot be echoed back without leaking the artifact and
/// source text it quotes. Checking the contract locally turns that opaque
/// failure into a deterministic error that names the offending question.
pub fn check_contract(questions: &Value) -> anyhow::Result<()> {
    let questions = questions
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Judgment questions must be a map"))?;
    for (id, question) in questions {
        anyhow::ensure!(
            question["instructions"]
                .as_str()
                .is_some_and(|instructions| !instructions.trim().is_empty()),
            "Judgment question {id} has no instructions"
        );
        match question["type"].as_str() {
            Some("noul") => {}
            Some("choice") => {
                let criteria = question["criteria"]
                    .as_object()
                    .ok_or_else(|| anyhow::anyhow!("Judgment question {id} has no criteria"))?;
                anyhow::ensure!(
                    criteria.len() >= 2 && criteria.values().all(|v| v.is_string()),
                    "Judgment question {id} needs at least two string criteria"
                );
            }
            Some("score") => {
                let criteria = question["criteria"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("Judgment question {id} has no criteria"))?;
                anyhow::ensure!(
                    criteria.len() >= 2 && criteria.iter().all(Value::is_string),
                    "Judgment question {id} needs at least two string criteria"
                );
            }
            _ => anyhow::bail!("Judgment question {id} has an unknown type"),
        }
    }
    Ok(())
}

/// Rejects missing, non-finite or incoherent answers rather than treating them as a pass.
pub fn validate(questions: &Value, evaluation: &Evaluation) -> anyhow::Result<()> {
    let questions = questions
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Judgment questions must be a map"))?;
    anyhow::ensure!(
        evaluation.warnings.is_empty(),
        "TypeSafe reported warnings; no unchecked debrief was substituted"
    );
    anyhow::ensure!(
        !questions.is_empty() && questions.len() <= 160,
        "Invalid judgment question count"
    );
    anyhow::ensure!(
        evaluation.answers.len() == questions.len(),
        "TypeSafe returned an incomplete answer set"
    );
    for (id, question) in questions {
        let answer = evaluation
            .answers
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("TypeSafe omitted a requested answer"))?;
        let kind = question["type"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Question type missing"))?;
        anyhow::ensure!(
            answer["type"].as_str() == Some(kind),
            "TypeSafe returned the wrong answer type"
        );
        if kind == "noul" {
            probability(&answer["noul"])?;
            continue;
        }
        let confidence = probability(&answer["confidence"])?;
        let probabilities = answer["probabilities"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("TypeSafe distribution missing"))?;
        let expected: Vec<String> = match kind {
            "choice" => question["criteria"]
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Choice criteria missing"))?
                .keys()
                .cloned()
                .collect(),
            "score" => (0..question["criteria"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Score criteria missing"))?
                .len())
                .map(|n| n.to_string())
                .collect(),
            _ => anyhow::bail!("Unknown judgment primitive"),
        };
        anyhow::ensure!(
            expected.len() >= 2
                && probabilities.len() == expected.len()
                && expected.iter().all(|k| probabilities.contains_key(k)),
            "TypeSafe distribution does not cover the criteria"
        );
        let sum: f64 = probabilities
            .values()
            .map(probability)
            .collect::<anyhow::Result<Vec<_>>>()?
            .iter()
            .sum();
        anyhow::ensure!(
            (sum - 1.0).abs() <= 0.03,
            "TypeSafe distribution is not normalized"
        );
        if kind == "choice" {
            let selected = answer["choice"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("TypeSafe choice missing"))?;
            let winner = probabilities
                .get(selected)
                .ok_or_else(|| anyhow::anyhow!("TypeSafe chose an unknown option"))?;
            let winner = probability(winner)?;
            let n = expected.len() as f64;
            let calculated = (winner - 1.0 / n) / (1.0 - 1.0 / n);
            anyhow::ensure!(
                (confidence - calculated).abs() <= 0.04,
                "TypeSafe confidence conflicts with its distribution for {id} ({kind}): reported {confidence:.3}, calculated {calculated:.3}, probabilities {probabilities:?}"
            );
            anyhow::ensure!(
                probabilities
                    .values()
                    .all(|v| probability(v).is_ok_and(|p| p <= winner + 0.001)),
                "TypeSafe choice conflicts with its distribution for {id}: selected {selected} has probability {winner:.3}; highest probability is {:.3}",
                probabilities
                    .values()
                    .filter_map(Value::as_f64)
                    .fold(0.0, f64::max)
            );
        } else {
            let score = answer["score"]
                .as_f64()
                .ok_or_else(|| anyhow::anyhow!("TypeSafe score missing"))?;
            let weighted: f64 = expected
                .iter()
                .enumerate()
                .map(|(i, k)| i as f64 * probabilities[k].as_f64().unwrap_or_default())
                .sum();
            let n = expected.len() as f64;
            let mode = expected
                .iter()
                .enumerate()
                .fold((0usize, -1.0f64), |(index, best), (i, k)| {
                    let p = probabilities[k].as_f64().unwrap_or_default();
                    if p > best { (i, p) } else { (index, best) }
                })
                .0;
            let spread: f64 = expected
                .iter()
                .enumerate()
                .map(|(i, k)| {
                    probabilities[k].as_f64().unwrap_or_default() * (i as f64 - mode as f64).abs()
                })
                .sum();
            let uniform: f64 = (0..expected.len())
                .map(|i| (i as f64 - (n - 1.0) / 2.0).abs())
                .sum::<f64>()
                / n;
            let calculated = (1.0 - spread / uniform).max(0.0);
            anyhow::ensure!(
                (confidence - calculated).abs() <= 0.04,
                "TypeSafe confidence conflicts with its distribution for {id} ({kind}): reported {confidence:.3}, calculated {calculated:.3}, probabilities {probabilities:?}"
            );
            anyhow::ensure!(
                score.is_finite()
                    && (0.0..=(expected.len() - 1) as f64).contains(&score)
                    && (score - weighted).abs() <= 0.06,
                "TypeSafe score conflicts with its distribution"
            );
        }
    }
    anyhow::ensure!(
        !evaluation.model.is_empty(),
        "TypeSafe model identity missing"
    );
    Ok(())
}
pub fn probability(value: &Value) -> anyhow::Result<f64> {
    let p = value
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("TypeSafe probability missing"))?;
    anyhow::ensure!(
        p.is_finite() && (0.0..=1.0).contains(&p),
        "TypeSafe probability out of range"
    );
    Ok(p)
}

#[async_trait]
impl Judge for TypeSafe {
    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        check_contract(&questions)?;
        let body = json!({"model":self.model,"state":state,"questions":questions});
        anyhow::ensure!(
            serde_json::to_vec(&body)?.len() <= 320_000,
            "Evidence judgment input is too large"
        );
        let start = std::time::Instant::now();
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "TypeSafe request failed or timed out; no unchecked debrief was substituted."
                )
            })?;
        anyhow::ensure!(
            response.status().is_success(),
            "TypeSafe returned HTTP {}. Check judgment provider access and quota, then retry the Run.",
            response.status().as_u16()
        );
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("TypeSafe response could not be read"))?
        {
            anyhow::ensure!(
                bytes.len() + chunk.len() <= 1_000_000,
                "TypeSafe response exceeded its limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("TypeSafe returned invalid JSON"))?;
        anyhow::ensure!(
            value.get("error").is_none()
                && value
                    .get("status")
                    .is_none_or(|s| matches!(s.as_str(), Some("ok" | "success"))),
            "TypeSafe returned a failure status"
        );
        let answers = serde_json::from_value(value["answers"].clone())
            .map_err(|_| anyhow::anyhow!("TypeSafe answer set missing"))?;
        let evaluation = Evaluation {
            model: value["model"].as_str().unwrap_or_default().into(),
            warnings: if value["warnings"].is_null() {
                Vec::new()
            } else {
                serde_json::from_value(value["warnings"].clone())
                    .map_err(|_| anyhow::anyhow!("TypeSafe returned malformed warnings"))?
            },
            answers,
            usage: Usage {
                input_tokens: value["usage"]["input_tokens"].as_u64().unwrap_or_default(),
                output_tokens: value["usage"]["output_tokens"].as_u64().unwrap_or_default(),
                cost_usd: value["usage"]["cost"]
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0),
                elapsed_ms: start.elapsed().as_millis() as u64,
            },
        };
        Ok(evaluation)
    }
}
struct Unavailable {
    reason: String,
}
#[async_trait]
impl Judge for Unavailable {
    fn reason(&self) -> Option<&str> {
        Some(&self.reason)
    }
    async fn evaluate(&self, _: Value, _: Value) -> anyhow::Result<Evaluation> {
        anyhow::bail!("{}", self.reason)
    }
}

/// Rejects an evaluation that does not satisfy the questions it answers. Every
/// judging caller used to repeat this check, and could forget it; `validated`
/// and `run_scoped` now compose it, so a reached `Judge` has already applied it.
struct Validated {
    inner: Arc<dyn Judge>,
}

#[async_trait]
impl Judge for Validated {
    fn reason(&self) -> Option<&str> {
        self.inner.reason()
    }

    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let evaluation = self.inner.evaluate(state, questions.clone()).await?;
        validate(&questions, &evaluation)?;
        Ok(evaluation)
    }
}

/// A repair changes only rejected content. Reuse a validated judgment only
/// when its entire evidence, candidate, context and question are identical.
/// Cache failures too: unchanged rejected content cannot earn a new roll.
/// The cache lives for one Run and never survives a fresh Run.
struct RunJudgments {
    inner: Arc<dyn Judge>,
    results: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<tokio::sync::OnceCell<Evaluation>>>,
    >,
}

#[async_trait]
impl Judge for RunJudgments {
    fn reason(&self) -> Option<&str> {
        self.inner.reason()
    }

    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let key = crate::research::content_hash(
            serde_json::to_string(&json!([state, questions]))?.as_bytes(),
        );
        let entry = self.results.lock().unwrap().entry(key).or_default().clone();
        let result = entry
            .get_or_try_init(|| async {
                let result = self.inner.evaluate(state, questions.clone()).await?;
                Ok::<_, anyhow::Error>(result)
            })
            .await?;
        Ok(result.clone())
    }
}

/// Validates each evaluation against its questions. Exposed so an explicit
/// fixture connection can be composed exactly as the installation's is.
pub fn validated(inner: Arc<dyn Judge>) -> Arc<dyn Judge> {
    Arc::new(Validated { inner })
}

/// The judging connection for one Run: every evaluation is validated against
/// its questions and computed once per distinct state and question set for the
/// whole Run, including the repairs inside it.
pub fn run_scoped(inner: Arc<dyn Judge>) -> Arc<dyn Judge> {
    Arc::new(RunJudgments {
        inner: validated(inner),
        results: Default::default(),
    })
}
/// The usage-recording decorator for one Run. Wraps the run-scoped
/// (validated + memoized) judge last, so the measurement covers the
/// evaluations the Run actually performs. Records totals only.
pub fn recorded(
    inner: Arc<dyn Judge>,
    recorder: Arc<crate::connection::EventRecorder>,
) -> Arc<dyn Judge> {
    Arc::new(Recorded { inner, recorder })
}

struct Recorded {
    inner: Arc<dyn Judge>,
    recorder: Arc<crate::connection::EventRecorder>,
}

#[async_trait]
impl Judge for Recorded {
    fn reason(&self) -> Option<&str> {
        self.inner.reason()
    }
    async fn evaluate(&self, state: Value, questions: Value) -> anyhow::Result<Evaluation> {
        let evaluation = self.inner.evaluate(state, questions).await?;
        self.recorder.record_jev(&evaluation.usage);
        Ok(evaluation)
    }
}

/// Uses the installation key only on the server; offline tests supply a Judge fixture.
pub fn from_config(cfg: &Config) -> Arc<dyn Judge> {
    match cfg.jev_api_key.as_deref().filter(|key| !key.trim().is_empty()).or(cfg.openrouter_api_key.as_deref().filter(|key| !key.trim().is_empty())) {
        None=>validated(Arc::new(Unavailable {reason:"Evidence judgments are not configured. Set JEV_API_KEY or OPENROUTER_API_KEY in the server installation environment, then restart.".into()})),
        Some(key)=>match TypeSafe::with_model(key,cfg.jev_base_url.as_deref().or(cfg.typesafe_base_url.as_deref()), &cfg.jev_model) {
            Ok(provider)=>validated(Arc::new(provider)),
            Err(_)=>validated(Arc::new(Unavailable {reason:"Evidence judgments are not configured. Check JEV_API_KEY (or OPENROUTER_API_KEY), JEV_MODEL and JEV_BASE_URL (or TYPESAFE_BASE_URL) in the server installation environment, then restart.".into()})),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_question_kind_carries_the_fields_the_provider_requires() {
        // The provider rejects a question without instructions; catching it
        // locally keeps the opaque HTTP 400 from surfacing as a Run failure.
        let missing = json!({"c1_citation":{"type":"choice","criteria":{
            "cited":"every clause is cited","uncited":"no clause is cited"}}});
        assert!(
            check_contract(&missing)
                .unwrap_err()
                .to_string()
                .contains("has no instructions")
        );
        let single = json!({"c1_citation":{"type":"choice","instructions":"Which applies?",
            "criteria":{"cited":"every clause is cited"}}});
        assert!(check_contract(&single).is_err());
        let unknown = json!({"c1":{"type":"rating","instructions":"Rate it."}});
        assert!(check_contract(&unknown).is_err());
        let well_formed = json!({
            "c1_probability":{"type":"noul","instructions":"How likely?"},
            "c1_citation":{"type":"choice","instructions":"Which applies?",
                "criteria":{"cited":"every clause is cited","uncited":"no clause is cited"}},
            "c1_score":{"type":"score","instructions":"Rate it.",
                "criteria":["poor","fair","good"]}
        });
        check_contract(&well_formed).unwrap();
    }
}
