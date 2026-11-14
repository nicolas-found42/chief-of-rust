//! Correlation across the web-to-worker boundary.
//!
//! The HTTP layer mints or echoes an `x-request-id` for every request. The
//! id lives in a task-local so any code inside the request can read it, and
//! `work::enqueue` stamps it onto the Run's durable admission row. A
//! scheduled admission has no request: the scheduler installs
//! `schedule:<kind>` as the admission origin instead, so the Run still names
//! its trigger and a deduplicated tick leaves a trace.
//!
//! A task-local is read before the queue transaction moves onto the blocking
//! pool: the value crosses the async boundary explicitly, never implicitly.

tokio::task_local! {
    static REQUEST_ID: String;
}

tokio::task_local! {
    static ADMISSION_ORIGIN: String;
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

/// Why the current task admitted work when no browser request did: the
/// scheduler stamps `schedule:<kind>`, so a scheduled Run names its trigger
/// in the durable admission row and a deduplicated admission still says who
/// tried. Absent for internal admissions, which have no external trigger.
pub fn origin() -> Option<String> {
    ADMISSION_ORIGIN.try_with(Clone::clone).ok()
}

/// Runs `future` with `origin` installed as the current admission origin.
pub async fn scope_origin<T>(origin: String, future: impl Future<Output = T>) -> T {
    ADMISSION_ORIGIN.scope(origin, future).await
}

/// The durable action label for an admission event: the caller's request id
/// when one exists, otherwise the scheduled origin. The prefix keeps the
/// label distinguishable from stage actions in the timeline.
pub fn admission_action(correlation: Option<&str>, origin: Option<&str>) -> Option<String> {
    correlation
        .map(|id| format!("request:{id}"))
        .or_else(|| origin.map(str::to_owned))
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
            admission_action(Some("abc"), None),
            Some("request:abc".to_owned())
        );
    }

    #[test]
    fn a_request_wins_over_a_scheduled_origin() {
        assert_eq!(
            admission_action(Some("abc"), Some("schedule:content.scout")),
            Some("request:abc".to_owned())
        );
    }

    #[test]
    fn a_scheduled_origin_is_the_fallback_and_internal_admissions_have_none() {
        assert_eq!(
            admission_action(None, Some("schedule:content.scout")),
            Some("schedule:content.scout".to_owned())
        );
        assert_eq!(admission_action(None, None), None);
    }

    #[tokio::test]
    async fn origin_is_absent_outside_a_scope_and_installed_inside_one() {
        assert_eq!(origin(), None);
        assert_eq!(
            scope_origin("schedule:meetings.calendar".to_owned(), async { origin() }).await,
            Some("schedule:meetings.calendar".to_owned())
        );
    }
}
