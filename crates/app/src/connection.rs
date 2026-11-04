//! The connections one Run uses, decorated in one place.
//!
//! A Run is the unit of connection behaviour. Its model session is pinned so
//! its parallel generation calls share one routing/cache session, the long
//! evidence-synthesis kinds get the extended request budget, and its judgments
//! are validated against their questions and computed once per distinct
//! state/question set for the Run's whole life — including the repairs inside
//! it. A workflow that generates or judges holds a [`RunScope`]: it cannot
//! reach an unwrapped connection and cannot forget either duty.
//!
//! Usage recording rides the same decoration: an [`EventRecorder`] behind
//! `Arc` collects per-call LLM/Jev usage and timeline rows while the Run
//! executes, and the workflow persists the totals beside the finished
//! record. The recorder holds only measurements, never prompts or keys.
use crate::{App, work::Job};
use std::sync::Arc;

/// Connections scoped to one Run. Derefs to the [`App`] so a workflow body
/// keeps using `db`, `cfg` and the rest, while `llm` and `judge` are this Run's.
pub struct RunScope {
    app: App,
    run_id: String,
    pub(crate) recorder: Arc<EventRecorder>,
}

/// Per-Run usage and timeline collector. Workflows record through the
/// `RunScope`; the measurements persist with the Run's finished record.
/// Prompts, keys and contact values never enter the recorder.
#[derive(Debug, Default)]
pub struct EventRecorder {
    generation_calls: std::sync::Mutex<Vec<GenerationCall>>,
    jev_calls: std::sync::atomic::AtomicU64,
    jev_input_tokens: std::sync::atomic::AtomicU64,
    jev_output_tokens: std::sync::atomic::AtomicU64,
    jev_elapsed_ms: std::sync::atomic::AtomicU64,
    events: std::sync::Mutex<Vec<RecordedEvent>>,
    /// Timeline rows the recorder refused at the diagnostic cap. Surfaced in
    /// the usage summary so a capped timeline never masquerades as a quiet Run.
    events_dropped: std::sync::atomic::AtomicUsize,
}

/// One generation request's measurements, without any input or output text.
/// Missing provider fields stay absent so a failed call cannot appear free (#61).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub(crate) struct GenerationCall {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub elapsed_ms: u64,
    pub outcome: &'static str,
    /// The provider that served this call, so a mixed-provider Run's usage is
    /// attributable per call.
    pub provider: Option<&'static str>,
    /// Caller-supplied failure cause, redacted and bounded by the caller.
    /// `failed_or_cancelled` without a cause stays explicit about being mute.
    pub cause: Option<String>,
    // Pending siblings may outlive a failed Run's snapshot (#61).
    #[serde(skip)]
    pub started_at: Option<std::time::Instant>,
}

/// One timeline row captured during the Run, persisted at the end beside
/// the finished record.
#[derive(Debug, Clone)]
pub struct RecordedEvent {
    pub stage: String,
    pub action: Option<String>,
    pub status: String,
    pub elapsed_ms: Option<u64>,
    pub detail: Option<String>,
}

impl RecordedEvent {
    /// One timeline row: the stage reached, what it did, the outcome, the
    /// measured wall time where the stage reports it, and a detail such as
    /// the provider/model pair or the failure text.
    pub fn new(
        stage: &str,
        action: Option<&str>,
        status: &str,
        elapsed_ms: Option<u64>,
        detail: Option<&str>,
    ) -> Self {
        Self {
            stage: stage.into(),
            action: action.map(str::to_owned),
            status: status.into(),
            elapsed_ms,
            detail: detail.map(str::to_owned),
        }
    }
}
impl EventRecorder {
    pub(crate) fn start_generation(&self, call: GenerationCall) -> usize {
        // Keep even an interrupted measurement: the poison payload still owns
        // the numeric records, and no user code runs under this lock (#61).
        let mut calls = self
            .generation_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let index = calls.len();
        calls.push(call);
        index
    }

    pub(crate) fn update_generation(&self, index: usize, call: GenerationCall) {
        // Entries are append-only, so a guard's start index remains valid (#61).
        self.generation_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())[index] = call;
    }

    /// Record one judgment call's measured usage. Totals only.
    pub fn record_jev(&self, usage: &crate::judgments::Usage) {
        use std::sync::atomic::Ordering;
        self.jev_calls.fetch_add(1, Ordering::Relaxed);
        self.jev_input_tokens
            .fetch_add(usage.input_tokens, Ordering::Relaxed);
        self.jev_output_tokens
            .fetch_add(usage.output_tokens, Ordering::Relaxed);
        self.jev_elapsed_ms
            .fetch_add(usage.elapsed_ms, Ordering::Relaxed);
    }

    /// Record one timeline row for the Run. Cap matches the `run_event`
    /// table cap so memory and storage agree.
    pub fn record_event(
        &self,
        stage: &str,
        action: Option<&str>,
        status: &str,
        elapsed_ms: Option<u64>,
        detail: Option<&str>,
    ) {
        let mut events = self.events.lock().expect("recorder mutex poisoned");
        if events.len() as i64 >= crate::work::RUN_EVENT_CAP {
            self.events_dropped
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return;
        }
        events.push(RecordedEvent {
            stage: stage.into(),
            action: action.map(str::to_owned),
            status: status.into(),
            elapsed_ms,
            detail: detail.map(str::to_owned),
        });
    }

    /// The Run's measured totals as a JSON object for the finished record.
    /// Absent when the Run made no calls. Missing measurements stay explicit.
    pub fn usage_summary(&self) -> Option<serde_json::Value> {
        use std::sync::atomic::Ordering;
        let dropped = self.events_dropped.load(Ordering::Relaxed);
        let mut calls = self
            .generation_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        for call in &mut calls {
            if let Some(started) = call.started_at {
                call.elapsed_ms = started.elapsed().as_millis() as u64;
            }
        }
        let llm_calls = calls.len();
        let unmeasured = calls
            .iter()
            .filter(|c| c.input_tokens.is_none() || c.output_tokens.is_none())
            .count();
        let cost = if calls.is_empty() {
            None
        } else {
            calls.iter().map(|c| c.cost_usd).sum::<Option<f64>>()
        };
        let jev_calls = self.jev_calls.load(Ordering::Relaxed);
        if llm_calls == 0 && jev_calls == 0 && dropped == 0 {
            return None;
        }
        Some(serde_json::json!({
            "llm_calls": llm_calls,
            "llm_unmeasured_calls": unmeasured,
            "llm_cost_usd": cost,
            "generation_calls": calls,
            "llm_input_tokens": calls.iter().filter_map(|c| c.input_tokens).sum::<u64>(),
            "llm_output_tokens": calls.iter().filter_map(|c| c.output_tokens).sum::<u64>(),
            "llm_elapsed_ms": calls.iter().map(|c| c.elapsed_ms).sum::<u64>(),
            "jev_calls": jev_calls,
            "jev_input_tokens": self.jev_input_tokens.load(Ordering::Relaxed),
            "jev_output_tokens": self.jev_output_tokens.load(Ordering::Relaxed),
            "jev_elapsed_ms": self.jev_elapsed_ms.load(Ordering::Relaxed),
            "timeline_dropped_events": dropped,
        }))
    }

    /// The retained timeline rows for this Run attempt. Tests assert on them;
    /// production drains them through `work::flush_events`.
    pub fn drained_events(&self) -> Vec<RecordedEvent> {
        self.events.lock().expect("recorder mutex poisoned").clone()
    }

    /// Rows persisted and not yet seen by the store writer. `from` is the
    /// count of rows already written; the returned slice starts there, so
    /// the periodic drainer and the final flush can share one cursor.
    pub fn drained_from(&self, from: usize) -> Vec<RecordedEvent> {
        self.events
            .lock()
            .expect("recorder mutex poisoned")
            .iter()
            .skip(from)
            .cloned()
            .collect()
    }

    /// Events the recorder dropped once its in-memory buffer hit the cap.
    /// They never reach the store; the usage snapshot and the truncation
    /// marker carry the count instead.
    pub fn events_dropped(&self) -> u64 {
        self.events_dropped
            .load(std::sync::atomic::Ordering::Relaxed) as u64
    }
}
impl std::ops::Deref for RunScope {
    type Target = App;

    fn deref(&self) -> &App {
        &self.app
    }
}

impl RunScope {
    /// Wraps the run-scoped handle the installation built.
    pub(crate) fn new(app: App, run_id: String, recorder: Arc<EventRecorder>) -> Self {
        Self {
            app,
            run_id,
            recorder,
        }
    }

    /// The Run this scope was opened for.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The Run's usage/timeline recorder. Decorators behind the `llm` and
    /// `judge` connections record through it; workflows read the totals.
    pub fn recorder(&self) -> &Arc<EventRecorder> {
        &self.recorder
    }
}

impl App {
    /// Opens the connections one Run uses. Called once, at admission; the
    /// scope is passed down instead of the App, so nothing downstream
    /// configures a model session, a request budget or a judgment cache for
    /// itself, and a selector of its own cannot diverge from the Run's.
    pub fn for_run(&self, run: &Job) -> RunScope {
        let recorder = Arc::new(EventRecorder::default());
        let scope = self
            .with_llm(crate::llm::for_run(
                self.llm(),
                &run.id,
                extended_request_budget(self, &run.kind),
            ))
            .with_judge(crate::judgments::run_scoped(self.judge().clone()));
        // Usage decorators wrap last so every generation and judgment the
        // Run performs records through the same recorder.
        let scope = scope
            .with_llm(crate::llm::recorded(scope.llm().clone(), recorder.clone()))
            .with_judge(crate::judgments::recorded(
                scope.judge().clone(),
                recorder.clone(),
                self.cfg().clone(),
            ));
        RunScope::new(scope, run.id.clone(), recorder)
    }
}

/// Long evidence synthesis needs a larger request budget than interactive
/// generation; every other kind keeps the provider's own timeout.
fn extended_request_budget(app: &App, kind: &str) -> Option<std::time::Duration> {
    matches!(kind, "terminal.profile" | "terminal.report")
        .then(|| std::time::Duration::from_secs(app.cfg().terminal_limits.request_seconds))
}

#[cfg(test)]
mod tests {
    /// Events beyond the shared cap are counted, not silently discarded, so
    /// a truncated timeline is distinguishable from a short one.
    #[test]
    fn overflow_is_counted_and_reported_in_the_usage_summary() {
        let recorder = super::EventRecorder::default();
        for i in 0..(crate::work::RUN_EVENT_CAP + 3) {
            recorder.record_event("note", None, "ok", None, Some(&i.to_string()));
        }
        let summary = recorder.usage_summary().unwrap();
        assert_eq!(summary["timeline_dropped_events"], serde_json::json!(3));
        let drained = recorder.drained_events();
        assert_eq!(drained.len(), crate::work::RUN_EVENT_CAP as usize);
        assert_eq!(drained[0].detail.as_deref(), Some("0"));
    }

    /// The store writer drains by cursor; already-written rows must not be
    /// written twice, and drops must be countable separately from the rows.
    #[test]
    fn cursor_drain_returns_only_unpersisted_rows_and_counts_drops() {
        let recorder = super::EventRecorder::default();
        for i in 0..4 {
            recorder.record_event("note", None, "ok", None, Some(&i.to_string()));
        }
        assert_eq!(recorder.drained_from(0).len(), 4);
        assert_eq!(recorder.drained_from(2).len(), 2);
        assert_eq!(recorder.drained_from(2)[0].detail.as_deref(), Some("2"));
        assert_eq!(recorder.drained_from(9).len(), 0);
        assert_eq!(recorder.events_dropped(), 0);
        recorder.record_event("note", None, "ok", None, None);
        assert_eq!(recorder.drained_from(4).len(), 1);
    }
}
