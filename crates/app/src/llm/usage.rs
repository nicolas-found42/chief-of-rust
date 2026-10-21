//! Numeric generation measurements survive validation errors and cancellation (#61).
use crate::connection::{EventRecorder, GenerationCall};
use serde_json::Value;
use std::{sync::Arc, time::Instant};

pub(super) struct Call {
    recorder: Option<Arc<EventRecorder>>,
    started: Instant,
    index: Option<usize>,
    measurement: GenerationCall,
}

impl Call {
    pub(super) fn new(recorder: Option<Arc<EventRecorder>>) -> Self {
        let started = Instant::now();
        let measurement = GenerationCall {
            started_at: Some(started),
            outcome: "unmeasured",
            ..Default::default()
        };
        // Register before awaiting the provider: JoinSet cancellation can finish
        // after the worker snapshots a failed Run's usage (#61).
        let index = recorder
            .as_ref()
            .map(|recorder| recorder.start_generation(measurement.clone()));
        Self {
            recorder,
            index,
            started,
            measurement,
        }
    }

    pub(super) fn response(&mut self, value: &Value, responses: bool) {
        let usage = &value["usage"];
        self.measurement.input_tokens = usage[if responses {
            "input_tokens"
        } else {
            "prompt_tokens"
        }]
        .as_u64();
        self.measurement.output_tokens = usage[if responses {
            "output_tokens"
        } else {
            "completion_tokens"
        }]
        .as_u64();
        self.measurement.cost_usd = reported_cost(value);
    }

    pub(super) fn measured(&mut self, usage: &crate::judgments::Usage) {
        // The compatibility port defaults to zero without provider usage.
        // Conservatively disclose that as unknown rather than a free call (#61).
        if usage.input_tokens != 0 || usage.output_tokens != 0 {
            self.measurement.input_tokens = Some(usage.input_tokens);
            self.measurement.output_tokens = Some(usage.output_tokens);
        }
        self.measurement.cost_usd = usage
            .cost_usd
            .filter(|cost| cost.is_finite() && *cost >= 0.0);
    }

    pub(super) fn succeeded(&mut self) {
        self.measurement.outcome = "succeeded";
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if let (Some(recorder), Some(index)) = (&self.recorder, self.index) {
            self.measurement.elapsed_ms = self.started.elapsed().as_millis() as u64;
            self.measurement.started_at = None;
            if self.measurement.outcome == "unmeasured" {
                self.measurement.outcome = "failed_or_cancelled";
            }
            recorder.update_generation(index, self.measurement.clone());
        }
    }
}

pub(super) fn reported_cost(value: &Value) -> Option<f64> {
    value["usage"]["cost"]
        .as_f64()
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}
