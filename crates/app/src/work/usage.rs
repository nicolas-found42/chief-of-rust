//! Run totals span recovered attempts; historical measurements stay immutable (#61).
use crate::{db::Db, store};
use serde_json::{Value, json};

pub(super) async fn for_run(db: &Db, job: &super::Job) -> anyhow::Result<Option<Value>> {
    let (id, attempts) = (job.id.clone(), job.attempt);
    db.transaction(move |tx| {
        let fields = [
            "llm_calls",
            "llm_unmeasured_calls",
            "llm_input_tokens",
            "llm_output_tokens",
            "llm_elapsed_ms",
            "jev_calls",
            "jev_input_tokens",
            "jev_output_tokens",
            "jev_elapsed_ms",
        ];
        let mut total = Value::Object(
            fields
                .iter()
                .map(|field| ((*field).into(), json!(0)))
                .collect(),
        );
        let mut calls = Vec::new();
        let mut unrecorded = Vec::new();
        let mut cost = Some(0.0);
        let mut recorded = false;
        for attempt in 1..=attempts {
            let Some(usage) = store::get::<Value>(tx, "run_usage", &format!("{id}:{attempt}"))?
            else {
                unrecorded.push(attempt);
                continue;
            };
            // An explicit null records an attempt that made no model calls.
            // An absent record cannot establish that, especially after recovery.
            if usage.is_null() {
                continue;
            }
            recorded = true;
            for field in fields {
                total[field] = json!(
                    total[field].as_u64().unwrap_or_default()
                        + usage[field].as_u64().unwrap_or_default()
                );
            }
            if usage["llm_calls"].as_u64().unwrap_or_default() > 0 {
                cost = cost.zip(usage["llm_cost_usd"].as_f64()).map(|(a, b)| a + b);
            }
            if let Some(attempt_calls) = usage["generation_calls"].as_array() {
                for call in attempt_calls {
                    let mut call = call.clone();
                    call["attempt"] = json!(attempt);
                    calls.push(call);
                }
            }
        }
        if !recorded && unrecorded.is_empty() {
            return Ok(None);
        }
        total["llm_cost_usd"] =
            if unrecorded.is_empty() && total["llm_calls"].as_u64().unwrap_or_default() > 0 {
                json!(cost)
            } else {
                Value::Null
            };
        total["generation_calls"] = json!(calls);
        total["unrecorded_attempts"] = json!(unrecorded);
        Ok(Some(total))
    })
    .await
}
