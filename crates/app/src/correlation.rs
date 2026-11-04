//! Correlation across the web-to-worker boundary.
//!
//! The HTTP layer mints or echoes an `x-request-id` for every request. The
//! id lives in a task-local so any code inside the request can read it, and
//! `work::enqueue` stamps it onto the Run's durable admission row. Scheduled
//! and worker-side admissions have no request and store no correlation.
//!
//! A task-local is read before the queue transaction moves onto the blocking
//! pool: the value crosses the async boundary explicitly, never implicitly.

tokio::task_local! {
    static REQUEST_ID: String;
}

/// The request id of the current task, when one was set by the web layer.
pub fn current() -> Option<String> {
    REQUEST_ID.try_with(|id| id.clone()).ok()
}

/// Runs `future` with `id` installed as the current request correlation id.
/// The middleware wraps every request in this scope; tests use it directly
/// to prove the id reaches durable rows.
pub async fn scope<T>(id: String, future: impl Future<Output = T>) -> T {
    REQUEST_ID.scope(id, future).await
}

/// The durable action label for an admission event, `request:<id>` when a
/// correlation id is known. The prefix keeps the label distinguishable from
/// stage actions in the timeline.
pub fn admission_action(correlation: Option<&str>) -> Option<String> {
    correlation.map(|id| format!("request:{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn current_is_absent_outside_a_scope() {
        assert_eq!(current(), None);
    }

    #[tokio::test]
    async fn scope_installs_the_id_for_the_future() {
        let seen = scope("corr-1".to_owned(), async { current() }).await;
        assert_eq!(seen.as_deref(), Some("corr-1"));
    }

    #[test]
    fn admission_action_prefixes_the_id() {
        assert_eq!(
            admission_action(Some("abc")),
            Some("request:abc".to_owned())
        );
        assert_eq!(admission_action(None), None);
    }
}
