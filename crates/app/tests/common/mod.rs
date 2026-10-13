use chief_of_rust::judgments::{Evaluation, Usage};
use serde_json::{Value, json};

// Explicit policy fixture, never evidence of the live model's accuracy.
pub fn fixture_evaluation(state: &Value, questions: &Value) -> Evaluation {
    let mut answers = std::collections::BTreeMap::new();
    for (id, q) in questions.as_object().unwrap() {
        let answer = match q["type"].as_str().unwrap() {
            "noul" => {
                json!({"type":"noul","noul":if id=="injection" || id.starts_with("counter_") || id.starts_with("answered_") || id.starts_with("fulfilled_") {0.0} else {1.0}})
            }
            "choice" => {
                let selected = if id.starts_with("kind_") {
                    let n = id.trim_start_matches("kind_").parse::<usize>().unwrap();
                    state["items"][n]["kind"].as_str().unwrap_or("unclear")
                } else if id.starts_with("support_") {
                    "supports"
                } else {
                    "neutral"
                };
                let p: serde_json::Map<String, Value> = q["criteria"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(|k| (k.clone(), json!(if k == selected { 1.0 } else { 0.0 })))
                    .collect();
                json!({"type":"choice","choice":selected,"probabilities":p,"confidence":1.0})
            }
            "score" => {
                let level = if id == "quality" {
                    2
                } else if id == "tension" {
                    0
                } else {
                    1
                };
                let p: serde_json::Map<String, Value> = q["criteria"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(i, _)| (i.to_string(), json!(if i == level { 1.0 } else { 0.0 })))
                    .collect();
                json!({"type":"score","score":level,"probabilities":p,"confidence":1.0})
            }
            _ => panic!("unknown fixture question"),
        };
        answers.insert(id.clone(), answer);
    }
    Evaluation {
        model: "explicit-test-fixture".into(),
        warnings: Vec::new(),
        answers,
        usage: Usage::default(),
    }
}
