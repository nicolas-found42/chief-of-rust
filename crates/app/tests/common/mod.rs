//! Shared test fixtures. Each integration test binary compiles this module
//! whole and uses a subset, so unused items are expected here.
#![allow(dead_code)]

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

/// Virtual time for Collector pacing. Every requested wait is recorded and
/// advances the clock instead of sleeping, so a test asserts the exact pacing
/// decision at no wall-time cost.
pub struct RecordingClock {
    base: std::time::Instant,
    waits: std::sync::Mutex<Vec<std::time::Duration>>,
    elapsed: std::sync::Mutex<std::time::Duration>,
}

#[async_trait::async_trait]
impl chief_of_rust::collect::Clock for RecordingClock {
    fn now(&self) -> std::time::Instant {
        self.base + *self.elapsed.lock().unwrap()
    }
    async fn sleep(&self, wait: std::time::Duration) {
        self.waits.lock().unwrap().push(wait);
        *self.elapsed.lock().unwrap() += wait;
    }
}

impl RecordingClock {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            base: std::time::Instant::now(),
            waits: std::sync::Mutex::new(Vec::new()),
            elapsed: std::sync::Mutex::new(std::time::Duration::ZERO),
        })
    }
    pub fn waits(&self) -> Vec<std::time::Duration> {
        self.waits.lock().unwrap().clone()
    }
    pub fn pacer(self: &std::sync::Arc<Self>) -> std::sync::Arc<chief_of_rust::collect::Pacer> {
        std::sync::Arc::new(chief_of_rust::collect::Pacer::with_clock(self.clone()))
    }
}
