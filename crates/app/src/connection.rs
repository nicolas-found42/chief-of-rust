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
    llm_calls: std::sync::atomic::AtomicU64,
    llm_input_tokens: std::sync::atomic::AtomicU64,
    llm_output_tokens: std::sync::atomic::AtomicU64,
    llm_elapsed_ms: std::sync::atomic::AtomicU64,
    jev_calls: std::sync::atomic::AtomicU64,
    jev_input_tokens: std::sync::atomic::AtomicU64,
    jev_output_tokens: std::sync::atomic::AtomicU64,
    jev_elapsed_ms: std::sync::atomic::AtomicU64,
    events: std::sync::Mutex<Vec<RecordedEvent>>,
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
    /// Record one LLM call's measured usage. Totals only: no prompt text.
    pub fn record_llm(&self, usage: &crate::judgments::Usage) {
        use std::sync::atomic::Ordering;
        self.llm_calls.fetch_add(1, Ordering::Relaxed);
        self.llm_input_tokens
            .fetch_add(usage.input_tokens, Ordering::Relaxed);
        self.llm_output_tokens
            .fetch_add(usage.output_tokens, Ordering::Relaxed);
        self.llm_elapsed_ms
            .fetch_add(usage.elapsed_ms, Ordering::Relaxed);
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
    /// Absent when the Run made no measured calls.
    pub fn usage_summary(&self) -> Option<serde_json::Value> {
        use std::sync::atomic::Ordering;
        let llm_calls = self.llm_calls.load(Ordering::Relaxed);
        let jev_calls = self.jev_calls.load(Ordering::Relaxed);
        if llm_calls == 0 && jev_calls == 0 {
            return None;
        }
        Some(serde_json::json!({
            "llm_calls": llm_calls,
            "llm_input_tokens": self.llm_input_tokens.load(Ordering::Relaxed),
            "llm_output_tokens": self.llm_output_tokens.load(Ordering::Relaxed),
            "llm_elapsed_ms": self.llm_elapsed_ms.load(Ordering::Relaxed),
            "jev_calls": jev_calls,
            "jev_input_tokens": self.jev_input_tokens.load(Ordering::Relaxed),
            "jev_output_tokens": self.jev_output_tokens.load(Ordering::Relaxed),
            "jev_elapsed_ms": self.jev_elapsed_ms.load(Ordering::Relaxed),
        }))
    }

    pub(crate) fn drained_events(&self) -> Vec<RecordedEvent> {
        self.events.lock().expect("recorder mutex poisoned").clone()
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
