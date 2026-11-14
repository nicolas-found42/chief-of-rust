//! Durable Runs: queue admission, leased execution and immutable attempts.
//! A retry is a new Run pointing to the failed one so the failure stays a fact.

mod queue;
mod routes;
mod usage;
mod worker;

#[cfg(test)]
mod tests;

pub use queue::{
    Job, RUN_EVENT_CAP, RunEvent, SCHEMA, enqueue, events, find, list, record_event, traces_sync,
};
pub(crate) use queue::{enqueue_tx, owns_attempt, queue_counts, queue_health};
pub use routes::router;
pub use worker::{LEASE_HEARTBEAT, WORKER_IDLE, run_once, run_once_heartbeat, spawn_supervised};
