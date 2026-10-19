//! The connections one Run uses, decorated in one place.
//!
//! A Run is the unit of connection behaviour. Its model session is pinned so
//! its parallel generation calls share one routing/cache session, the long
//! evidence-synthesis kinds get the extended request budget, and its judgments
//! are validated against their questions and computed once per distinct
//! state/question set for the Run's whole life — including the repairs inside
//! it. A workflow that generates or judges holds a [`RunScope`]: it cannot
//! reach an unwrapped connection and cannot forget either duty.
use crate::{App, work::Job};
use std::ops::Deref;

/// Connections scoped to one Run. Derefs to the [`App`] so a workflow body
/// keeps using `db`, `cfg` and the rest, while `llm` and `judge` are this Run's.
pub struct RunScope {
    app: App,
    run_id: String,
}

impl Deref for RunScope {
    type Target = App;

    fn deref(&self) -> &App {
        &self.app
    }
}

impl RunScope {
    /// The Run this scope was opened for.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

impl App {
    /// Opens the connections one Run uses. Called once, at admission; the
    /// scope is passed down instead of the App, so nothing downstream
    /// configures a model session, a request budget or a judgment cache for
    /// itself, and a selector of its own cannot diverge from the Run's.
    pub fn for_run(&self, run: &Job) -> RunScope {
        let mut app = self.clone();
        app.llm = crate::llm::for_run(&self.llm, &run.id, extended_request_budget(self, &run.kind));
        app.judge = crate::judgments::run_scoped(self.judge.clone());
        RunScope {
            app,
            run_id: run.id.clone(),
        }
    }
}

/// Long evidence synthesis needs a larger request budget than interactive
/// generation; every other kind keeps the provider's own timeout.
fn extended_request_budget(app: &App, kind: &str) -> Option<std::time::Duration> {
    matches!(kind, "terminal.profile" | "terminal.report")
        .then(|| std::time::Duration::from_secs(app.cfg.terminal_limits.request_seconds))
}
