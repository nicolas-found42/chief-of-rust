//! Durable Runs: queue admission, leased execution and immutable attempts.
//! A retry is a new Run pointing to the failed one so the failure stays a fact.
mod usage;
use crate::{
    App,
    db::Db,
    web::{self, escape},
};
use axum::{
    Router,
    extract::{Path, State},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS job(id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedup_key TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT, error TEXT, retry_of TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS active_job ON job(kind,dedup_key) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS job_attempt(job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(job_id,attempt));
CREATE TABLE IF NOT EXISTS run_event(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL, stage TEXT NOT NULL, action TEXT, status TEXT NOT NULL, elapsed_ms INTEGER, detail TEXT);
CREATE INDEX IF NOT EXISTS run_event_run ON run_event(run_id, id);
";
/// One append-only timeline row for a Run. The row is added beside the
/// finished record, never over it: a later stage never rewrites an earlier
/// one, so the timeline stays the audit trail of what actually happened.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunEvent {
    pub id: i64,
    pub run_id: String,
    pub attempt: u32,
    pub at_ms: i64,
    pub stage: String,
    pub action: Option<String>,
    pub status: String,
    pub elapsed_ms: Option<u64>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub input: Value,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub attempt: u32,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub retry_of: Option<String>,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    fn json(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Value> {
        let text: String = row.get(idx)?;
        serde_json::from_str(&text).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(idx, rusqlite::types::Type::Text, Box::new(e))
        })
    }
    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        key: row.get(2)?,
        input: json(row, 3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        attempt: row.get(7)?,
        result: if row.get::<_, Option<String>>(8)?.is_some() {
            Some(json(row, 8)?)
        } else {
            None
        },
        error: row.get(9)?,
        retry_of: row.get(10)?,
    })
}
const COLUMNS: &str =
    "id,kind,dedup_key,input,status,created_at,updated_at,attempt,result,error,retry_of";

pub(crate) struct QueueCounts {
    pub(crate) running: i64,
    pub(crate) queued: i64,
    pub(crate) failed: i64,
}

/// Count the live queue and failures without loading Run inputs or results.
/// Both health surfaces use this definition; completed Runs are not backlog.
pub(crate) fn queue_counts(conn: &rusqlite::Connection) -> rusqlite::Result<QueueCounts> {
    let count = |status: &str| {
        conn.query_row(
            "SELECT count(*) FROM job WHERE status = ?1",
            [status],
            |row| row.get(0),
        )
    };
    Ok(QueueCounts {
        running: count("running")?,
        queued: count("queued")?,
        failed: count("failed")?,
    })
}

/// The HTTP probe reads the counts and oldest queued timestamp in one
/// transaction. The timestamp is advisory; count errors fail the probe.
pub(crate) async fn queue_health(db: &Db) -> anyhow::Result<(QueueCounts, Option<i64>)> {
    db.transaction(|tx| {
        let counts = queue_counts(tx)?;
        let oldest_queued = tx
            .query_row(
                "SELECT MIN(created_at) FROM job WHERE status='queued'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(None);
        Ok((counts, oldest_queued))
    })
    .await
}

pub(crate) fn enqueue_tx(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    key: &str,
    mut input: Value,
    correlation: Option<&str>,
) -> anyhow::Result<Job> {
    if let Some(job)=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE kind=?1 AND dedup_key=?2 AND status IN ('queued','running')"),params![kind,key],from_row).optional()? { return Ok(job); }
    if crate::integrations::uses_google(kind, &input) && input.get("_google_binding").is_none() {
        input["_google_binding"] =
            serde_json::to_value(crate::integrations::GoogleBinding::load(tx)?)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::now_ms();
    tx.execute("INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'queued',?5,?5)",params![id,kind,key,serde_json::to_string(&input)?,now])?;
    // The admission row carries the web request's correlation id when one
    // exists, so an investigation can travel request → Run and back.
    record_event_tx(
        tx,
        &id,
        0,
        &crate::connection::RecordedEvent::new(
            "admitted",
            crate::correlation::admission_action(correlation).as_deref(),
            "queued",
            None,
            Some(kind),
        ),
    )?;
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS} FROM job WHERE id=?1"),
        [id],
        from_row,
    )?)
}

pub async fn enqueue(db: &Db, kind: &str, key: &str, input: Value) -> anyhow::Result<Job> {
    // Read the correlation id in async context: task-locals do not cross the
    // blocking pool, and the id must move into the transaction explicitly.
    let correlation = crate::correlation::current();
    let (kind, key) = (kind.to_owned(), key.to_owned());
    db.transaction(move |tx| enqueue_tx(tx, &kind, &key, input, correlation.as_deref()))
        .await
}

pub async fn find(db: &Db, id: &str) -> anyhow::Result<Option<Job>> {
    let id = id.to_owned();
    db.transaction(move |tx| {
        Ok(tx
            .query_row(
                &format!("SELECT {COLUMNS} FROM job WHERE id=?1"),
                [id],
                from_row,
            )
            .optional()?)
    })
    .await
}

pub async fn list(db: &Db) -> anyhow::Result<Vec<Job>> {
    db.transaction(|tx| {
        let mut stmt = tx.prepare(&format!(
            "SELECT {COLUMNS} FROM job ORDER BY created_at DESC,id LIMIT 200"
        ))?;
        Ok(stmt
            .query_map([], from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
}
/// Cap ordinary diagnostics per Run so a pathological loop cannot grow
/// without bound. Each attempt additionally retains its terminal row.
pub const RUN_EVENT_CAP: i64 = 500;

fn run_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunEvent> {
    Ok(RunEvent {
        id: row.get(0)?,
        run_id: row.get(1)?,
        attempt: row.get::<_, i64>(2)? as u32,
        at_ms: row.get(3)?,
        stage: row.get(4)?,
        action: row.get(5)?,
        status: row.get(6)?,
        elapsed_ms: row.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
        detail: row.get(8)?,
    })
}
const EVENT_COLUMNS: &str = "id,run_id,attempt,at_ms,stage,action,status,elapsed_ms,detail";

/// Returns whether the event was stored; `false` means the cap refused it
/// and the truncation marker accounted for it.
fn record_event_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    attempt: u32,
    event: &crate::connection::RecordedEvent,
) -> anyhow::Result<bool> {
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM run_event WHERE run_id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    if count >= RUN_EVENT_CAP {
        mark_truncated_tx(tx, run_id, attempt)?;
        // Durably accounted as dropped by the marker; the caller still
        // advances its cursor, and the final flush reports the total.
        return Ok(false);
    }
    append_event_tx(tx, run_id, attempt, event)?;
    Ok(true)
}

/// Leave one truncation marker the first time a Run touches the cap, so a
/// capped timeline is never indistinguishable from a quiet one — even when
/// the dropped rows were streamed rather than flushed.
fn mark_truncated_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    attempt: u32,
) -> anyhow::Result<()> {
    let marked: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM run_event WHERE run_id=?1 AND stage='diagnostics_truncated')",
        [run_id],
        |r| r.get(0),
    )?;
    if marked {
        return Ok(());
    }
    // Bypasses the cap: the marker is the one row that must survive it.
    append_event_tx(
        tx,
        run_id,
        attempt,
        &crate::connection::RecordedEvent::new(
            "diagnostics_truncated",
            None,
            "truncated",
            None,
            Some(
                "the diagnostics cap was reached before the Run finished; streamed rows after this point were dropped",
            ),
        ),
    )
}

// Terminal rows bypass the diagnostic cap: every claimed attempt must leave
// a final record even when a workflow filled the timeline (#60).
fn append_event_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    attempt: u32,
    event: &crate::connection::RecordedEvent,
) -> anyhow::Result<()> {
    tx.execute(
        "INSERT INTO run_event(run_id,attempt,at_ms,stage,action,status,elapsed_ms,detail) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            run_id,
            attempt as i64,
            crate::now_ms(),
            event.stage,
            event.action,
            event.status,
            event.elapsed_ms.map(|n| n as i64),
            event.detail,
        ],
    )?;
    Ok(())
}

/// Flush the recorder's timeline rows within the diagnostic cap, then leave
/// an explicit marker when rows were dropped. Without the marker a capped
/// timeline and a quiet Run are indistinguishable after the fact.
pub(crate) fn flush_events_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    attempt: u32,
    events: &[crate::connection::RecordedEvent],
    storage_dropped: u64,
    memory_dropped: u64,
) -> anyhow::Result<()> {
    let existing: i64 = tx.query_row(
        "SELECT COUNT(*) FROM run_event WHERE run_id=?1",
        [run_id],
        |r| r.get(0),
    )?;
    let capacity = (RUN_EVENT_CAP - existing).max(0) as usize;
    for event in events.iter().take(capacity) {
        append_event_tx(tx, run_id, attempt, event)?;
    }
    let flush_dropped = events.len().saturating_sub(capacity) as u64;
    let cap_dropped = storage_dropped + flush_dropped;
    if cap_dropped == 0 && memory_dropped == 0 {
        return Ok(());
    }
    let detail = if cap_dropped > 0 {
        format!(
            "{cap_dropped} timeline events were dropped at the {RUN_EVENT_CAP}-event diagnostic cap when the attempt finished{}; the retained events cover only the earliest prefix of the attempt",
            if memory_dropped > 0 {
                format!(
                    ", after the in-memory recorder had already dropped {memory_dropped} newer events"
                )
            } else {
                String::new()
            }
        )
    } else {
        format!(
            "{memory_dropped} newer timeline events were dropped by the in-memory recorder's cap; the retained events cover only the earliest prefix of the attempt"
        )
    };
    // Upsert: a streamed first-time notice is upgraded to the full counts.
    let marked: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM run_event WHERE run_id=?1 AND stage='diagnostics_truncated')",
        [run_id],
        |r| r.get(0),
    )?;
    if marked {
        tx.execute(
            "UPDATE run_event SET detail=?2 WHERE run_id=?1 AND stage='diagnostics_truncated'",
            rusqlite::params![run_id, detail],
        )?;
    } else {
        append_event_tx(
            tx,
            run_id,
            attempt,
            &crate::connection::RecordedEvent::new(
                "diagnostics_truncated",
                None,
                "truncated",
                None,
                Some(&detail),
            ),
        )?;
    }
    Ok(())
}

/// Append one timeline row for a Run. Best-effort by design: a diagnostics
/// write must never fail the Run it observes, so callers log and swallow
/// the error.
pub async fn record_event(
    db: &Db,
    run_id: &str,
    attempt: u32,
    event: crate::connection::RecordedEvent,
) -> anyhow::Result<bool> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| record_event_tx(tx, &run_id, attempt, &event))
        .await
}

/// The full timeline of one Run, oldest first. Empty for Runs admitted
/// before this table existed.
pub async fn events(db: &Db, run_id: &str) -> anyhow::Result<Vec<RunEvent>> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| {
        let mut stmt = tx.prepare(&format!(
            "SELECT {EVENT_COLUMNS} FROM run_event WHERE run_id=?1 ORDER BY id"
        ))?;
        Ok(stmt
            .query_map([run_id], run_event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
}

async fn claim(app: &App) -> anyhow::Result<Option<Job>> {
    let (provider, model) = (
        app.llm().name().to_owned(),
        app.cfg().llm_model().to_owned(),
    );
    app.db().transaction(move |tx| {
        let now=crate::now_ms();
        // The expired attempt is closed before the same Run is recovered.
        // Live leases are never stolen by a second process sharing the volume.
        tx.execute("UPDATE job_attempt SET finished_at=?1,outcome='interrupted: lease expired' WHERE finished_at IS NULL AND job_id IN (SELECT id FROM job WHERE status='running' AND lease_until<=?1)",[now])?;
        tx.execute("UPDATE job SET status='queued',lease_until=NULL WHERE status='running' AND lease_until<=?1",[now])?;
        let job=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE status='queued' ORDER BY created_at,id LIMIT 1"),[],from_row).optional()?;
        let Some(job)=job else {return Ok(None)};
        tx.execute("UPDATE job SET status='running',attempt=attempt+1,lease_until=?2,updated_at=?3 WHERE id=?1",params![job.id,now+600_000,now])?;
        tx.execute("INSERT INTO job_attempt(job_id,attempt,started_at,provider,model) VALUES(?1,?2,?3,?4,?5)",params![job.id,job.attempt+1,now,provider,model])?;
        // The claim is the recovery beside the interruption: lease expiry
        // already closed the old attempt above before this claim ran.
        record_event_tx(
            tx,
            &job.id,
            job.attempt + 1,
            &crate::connection::RecordedEvent::new("claimed", None, "running", None, Some(&format!("{} {}", provider, model))),
        )?;
        Ok(Some(tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE id=?1"),[job.id],from_row)?))
    }).await
}
/// How long the supervised worker idles between ticks.
pub const WORKER_IDLE: std::time::Duration = std::time::Duration::from_secs(2);

/// The durable worker loop: admit schedules, drain at most one Run per tick
/// and prune diagnostics on the idle cadence. Each tick runs in its own
/// task, so a panicking tick kills the tick, not the queue: a Run caught
/// mid-flight recovers through lease expiry while the loop keeps draining.
pub fn spawn_supervised(app: App) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Boot evidence: a restarted worker leaves a durable start row, so a
        // crash-then-restart is visible in the store, not only in stdout.
        let _ = app.db().record_ops_event("worker", "started", None).await;
        // Liveness is the process, not the loop: a Run can hold the loop for
        // its whole lease window, and a heartbeat that stops then would read
        // as a dead worker exactly when load is highest. This task is the
        // only heartbeat writer and it never blocks on product work. It stops
        // when the supervised loop ends, including on abort.
        let active = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let _guard = HeartbeatGuard(active.clone());
        tokio::spawn({
            let app = app.clone();
            let active = active.clone();
            async move {
                let mut beat = tokio::time::interval(WORKER_IDLE);
                while active.load(std::sync::atomic::Ordering::Relaxed) {
                    beat.tick().await;
                    if !active.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    if let Err(error) = app.db().record_tick(crate::now_ms()).await {
                        // One warning per failure; no retry loop, no growth.
                        tracing::warn!(%error, "worker heartbeat write failed");
                    }
                }
            }
        });
        loop {
            let tick = tokio::spawn({
                let app = app.clone();
                async move {
                    if let Err(error) = crate::settings::tick(&app).await {
                        // Admission failures also land on the schedule's
                        // last_error; the ops row makes them retrievable
                        // without knowing which schedule to inspect.
                        let _ = app
                            .db()
                            .record_ops_event(
                                "schedule",
                                "admission_failed",
                                Some(&crate::llm::redact_error(&error.to_string(), app.cfg())),
                            )
                            .await;
                        tracing::error!(%error,"schedule admission failed");
                    }
                    match run_once(&app).await {
                        Ok(true) => return true,
                        Err(error) => {
                            let _ = app
                                .db()
                                .record_ops_event(
                                    "worker",
                                    "run_once_failed",
                                    Some(&crate::llm::redact_error(&error.to_string(), app.cfg())),
                                )
                                .await;
                            tracing::error!(%error,"worker failed");
                        }
                        Ok(false) => {}
                    }
                    // Retention runs on the idle cadence, not per Run: the caps
                    // are cheap deletes and the worker is already awake every
                    // WORKER_IDLE seconds.
                    if let Err(error) = app.db().prune_diagnostics().await {
                        let _ = app
                            .db()
                            .record_ops_event(
                                "prune",
                                "prune_failed",
                                Some(&crate::llm::redact_error(&error.to_string(), app.cfg())),
                            )
                            .await;
                        tracing::error!(%error,"diagnostics prune failed");
                    }
                    false
                }
            });
            let busy = match tick.await {
                Ok(busy) => busy,
                Err(join_error) => {
                    // A panicking tick kills the tick, not the queue (#92);
                    // the panic is also durable so the incident is
                    // reconstructable after the container is recreated.
                    let _ = app
                        .db()
                        .record_ops_event(
                            "worker",
                            "tick_panicked",
                            Some(&crate::llm::redact_error(
                                &join_error.to_string(),
                                app.cfg(),
                            )),
                        )
                        .await;
                    tracing::error!(%join_error,"worker tick panicked");
                    false
                }
            };
            if busy {
                continue;
            }
            tokio::time::sleep(WORKER_IDLE).await;
        }
    })
}

/// Clears the heartbeat's liveness flag when the supervised loop ends, so an
/// aborted or finished worker stops writing heartbeats.
struct HeartbeatGuard(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}
/// The worker renews its lease on this cadence while a Run executes.
pub const LEASE_HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(30);

/// Runs one admitted job; used by the worker and integration tests through
/// the identical product dispatch. No fixture writes bypass the workflows.
pub async fn run_once(app: &App) -> anyhow::Result<bool> {
    run_once_heartbeat(app, LEASE_HEARTBEAT).await
}

/// `run_once` with the lease-renewal cadence explicit. The cadence is timing,
/// not behavior: the lease-loss tests shrink it so waiting out one tick costs
/// milliseconds instead of 30 s of wall clock (#60). Everything else — claim,
/// dispatch, finalization — is the identical product path.
pub async fn run_once_heartbeat(app: &App, heartbeat: std::time::Duration) -> anyhow::Result<bool> {
    let selected_app = crate::settings::providers::resolve(app).await?;
    let app = &selected_app;
    let started = std::time::Instant::now();
    if app.cfg().people_terminal {
        crate::people_terminal::schedule(app).await?;
    }
    let Some(job) = claim(app).await? else {
        return Ok(false);
    };
    let run = app.for_run(&job);
    // Lease checks and workflow errors share the same finalization path (#60).
    // Dropping the dispatch future before flushing freezes its measurements.
    // Rows the write-through loop already persisted; the final flush takes
    // only the tail after this cursor.
    let mut persisted = 0usize;
    // Storage-side drops the write-through already accounted at the cap; the
    // final marker reports them beside the flush-side count.
    let mut storage_dropped = 0u64;
    let outcome = async {
        let execution = dispatch(&run, &job);
        tokio::pin!(execution);
        let mut heartbeat = tokio::time::interval(heartbeat);
        // Crash-before-finalize is the one loss the final flush cannot cover:
        // every two seconds, rows and the usage snapshot recorded so far are
        // written through, so a panicking or killed attempt keeps the evidence
        // it had produced up to the last tick.
        let mut write_through = tokio::time::interval(WORKER_IDLE);
        enum Signal {
            Done(anyhow::Result<serde_json::Value>),
            WriteThrough,
            Heartbeat,
        }
        // Only the cancellable primitives live inside `select!`; the database
        // work each signal triggers runs below it, so a completing dispatch
        // can never drop a transaction mid-await and have it commit
        // unaccounted (which would duplicate timeline rows or let an older
        // usage snapshot overwrite the final one).
        loop {
            let signal = tokio::select! {
                result = &mut execution => Signal::Done(result),
                _ = write_through.tick() => Signal::WriteThrough,
                _ = heartbeat.tick() => Signal::Heartbeat,
            };
            match signal {
                Signal::Done(result) => break result,
                Signal::WriteThrough => {
                    for event in run.recorder().drained_from(persisted) {
                        match record_event(app.db(), &job.id, job.attempt, event).await {
                            Ok(stored) => {
                                persisted += 1;
                                if !stored {
                                    storage_dropped += 1;
                                }
                            }
                            // Bounded retry: one attempt per tick, the warn is
                            // the only signal; the store error never fails the Run.
                            Err(error) => {
                                tracing::warn!(%error, "run timeline write-through failed");
                                break;
                            }
                        }
                    }
                    if let Some(usage) = run.recorder().usage_summary() {
                        let (id, attempt) = (job.id.clone(), job.attempt);
                        // Snapshot, not a revision: a value replaced every
                        // two seconds must not append full-body history.
                        let put = app.db().transaction(move |tx| {
                            crate::store::put_snapshot(
                                tx,
                                "run_usage",
                                &format!("{id}:{attempt}"),
                                &usage,
                            )
                        })
                        .await;
                        if let Err(error) = put {
                            tracing::warn!(%error, "run usage write-through failed");
                        }
                    }
                }
                Signal::Heartbeat => {
                    let (id, attempt) = (job.id.clone(), job.attempt);
                    let renewed = app.db().transaction(move |tx| {
                        Ok(tx.execute(
                            "UPDATE job SET lease_until=?3 WHERE id=?1 AND attempt=?2 AND status='running'",
                            params![id, attempt, crate::now_ms() + 600_000],
                        )? == 1)
                    }).await?;
                    // Bailing stops this worker's evidence appends at its
                    // next renewal — at most one heartbeat period late.
                    anyhow::ensure!(renewed, "Run lease no longer belongs to this worker");
                    // Best-effort: a diagnostics write never fails the Run it observes.
                    let _ = record_event(
                        app.db(),
                        &job.id,
                        job.attempt,
                        crate::connection::RecordedEvent::new("lease_renewed", None, "running", None, None),
                    ).await;
                }
            }
        }
    }.await;
    let total_ms = started.elapsed().as_millis() as u64;
    // Totals the RunScope decorators measured. The merge happens here, at
    // the one place every Run finishes, so no workflow can forget it and
    // no finished `result` is rewritten afterwards.
    let usage = run.recorder().usage_summary();
    let memory_dropped = run.recorder().events_dropped();
    let recorded = run.recorder().drained_from(persisted);
    let (status, result, error) = match outcome {
        Ok(mut result) => {
            if let (Some(usage), Some(map)) = (&usage, result.as_object_mut()) {
                map.insert("usage".to_owned(), usage.clone());
            }
            ("done", Some(serde_json::to_string(&result)?), None)
        }
        Err(error) => {
            let error = crate::llm::redact_error(&error.to_string(), app.cfg());
            tracing::warn!(kind=%job.kind,run=%job.id,"Run failed");
            (
                "failed",
                usage
                    .as_ref()
                    .map(|usage| serde_json::to_string(&serde_json::json!({"usage":usage})))
                    .transpose()?,
                Some(error),
            )
        }
    };
    let job = job.clone();
    app.db().transaction(move |tx| {
        let now=crate::now_ms();
        // Usage belongs to the attempt, including failures without a result (#61).
        // A recovered lease writes a new record beside the original attempt.
        crate::store::put(tx, "run_usage", &format!("{}:{}", job.id, job.attempt), &usage)?;
        let finalized = tx.execute("UPDATE job SET status=?2,result=?3,error=?4,lease_until=NULL,updated_at=?5 WHERE id=?1 AND status='running' AND attempt=?6",params![job.id,status,result,error,now,job.attempt])? == 1;
        let closed = tx.execute("UPDATE job_attempt SET finished_at=?3,outcome=?4 WHERE job_id=?1 AND attempt=?2 AND finished_at IS NULL",params![job.id,job.attempt,now,error.as_deref().unwrap_or("done")])?;
        // Recovery may already have closed this attempt (#60). Its recorded
        // interruption is final; a stale worker must not append a second outcome.
        if closed == 0 { return Ok(()); }
        // Recorder rows flush beside the finished record, oldest first, so
        // the timeline survives the process that produced it. A timeline that
        // overflowed the diagnostic cap says so: silence must never be
        // mistakable for a quiet Run.
        flush_events_tx(tx, &job.id, job.attempt, &recorded, storage_dropped, memory_dropped)?;
        let request = crate::terminal::automatic::Request::unfinished_for_run(tx, &job)?;
        // The closing row names the terminal outcome, not the stage that
        // happened to fail last: a failure must not masquerade as a second
        // `generation` or `collector` row with a different status.
        let stage = if status == "done" {
            "done"
        } else if let Some(request) = request.as_ref() {
            request.phase.as_str()
        } else {
            "failed"
        };
        append_event_tx(
            tx,
            &job.id,
            job.attempt,
            &crate::connection::RecordedEvent::new(stage, None, status, Some(total_ms), error.as_deref()),
        )?;
        if finalized && status == "failed" && let Some(request) = request {
            request.mark_failed(tx)?;
        }

        Ok(())
    }).await?;
    Ok(true)
}

async fn dispatch(run: &crate::connection::RunScope, job: &Job) -> anyhow::Result<Value> {
    let binding = job
        .input
        .get("_google_binding")
        .map(|value| serde_json::from_value::<crate::integrations::GoogleBinding>(value.clone()))
        .transpose()?;
    anyhow::ensure!(
        !crate::integrations::uses_google(&job.kind, &job.input) || binding.is_some(),
        "Google Run has no account binding; request fresh work"
    );
    crate::integrations::GOOGLE_RUN_BINDING
        .scope(binding, dispatch_product(run, job))
        .await
}
async fn dispatch_product(run: &crate::connection::RunScope, job: &Job) -> anyhow::Result<Value> {
    if job.kind.starts_with("meetings.") {
        crate::meetings::execute(run, job).await
    } else if job.kind.starts_with("people.") {
        if job.kind.starts_with("people.terminal_") {
            crate::people_terminal::execute(run, job).await
        } else {
            crate::people::execute(run, job).await
        }
    } else if job.kind.starts_with("tasks.") {
        crate::tasks::execute(run, job).await
    } else if matches!(job.kind.as_str(), "terminal.profile" | "terminal.report") {
        crate::terminal::automatic::execute(run, job).await
    } else if job.kind == "terminal.comparison" {
        crate::terminal::comparison::execute(run, job).await
    } else if job.kind.starts_with("terminal.") {
        // The subject module owns the four explicit research Run kinds and
        // refuses anything else under this prefix.
        crate::terminal::subject::execute(run, job).await
    } else if job.kind.starts_with("content.") {
        crate::content::execute(run, job).await
    } else {
        Err(anyhow::anyhow!("Unsupported Run kind: {}", job.kind))
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/runs", get(index))
        .route("/runs/{id}", get(detail))
        .route("/runs/{id}/diagnostics", get(diagnostics))
        .route("/runs/{id}/retry", post(retry))
}

#[derive(Serialize)]
struct Attempt {
    attempt: u32,
    started_at: i64,
    finished_at: Option<i64>,
    outcome: Option<String>,
    provider: String,
    model: String,
}

async fn attempts(db: &Db, run_id: &str) -> anyhow::Result<Vec<Attempt>> {
    let run_id = run_id.to_owned();
    db.transaction(move |tx| {
        let mut stmt = tx.prepare("SELECT attempt,started_at,finished_at,outcome,provider,model FROM job_attempt WHERE job_id=?1 ORDER BY attempt")?;
        Ok(stmt.query_map([run_id], |row| Ok(Attempt {
            attempt: row.get(0)?, started_at: row.get(1)?, finished_at: row.get(2)?,
            outcome: row.get(3)?, provider: row.get(4)?, model: row.get(5)?,
        }))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await
}

/// Machine-readable Run diagnostics for agents: the finished record, its
/// timeline and its measured totals in one JSON body. HTML stays the human
/// surface; this is the polling endpoint that does not scrape it.
async fn diagnostics(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let job = find(app.db(), &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    let timeline = events(app.db(), &id).await?;
    // The Council review this Run saved, as totals only: provider, model,
    // usage, hashes and the cost boundary. Advisory output never leaks here.
    let council: Vec<Value> = crate::council::revisions_for_run(&app, &id)
        .await?
        .iter()
        .map(crate::council::diagnostic)
        .collect();
    let usage = usage::for_run(app.db(), &job).await?;
    // Truncation has two independent evidence paths: the stored marker, and
    // the recorder's dropped-event counter inside the saved usage. A timeline
    // that lost rows before it could reach the store must not look complete.
    let timeline_truncated = timeline
        .iter()
        .any(|event| event.stage == "diagnostics_truncated")
        || usage::dropped_events(&usage) > 0;
    let body = serde_json::json!({
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "attempt": job.attempt,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "retry_of": job.retry_of,
        "error": job.error,
        "result": job.result,
        "timeline": timeline,
        "timeline_truncated": timeline_truncated,
        "attempts": attempts(app.db(), &id).await?,
        "council": council,
        "usage": usage,
    });
    Ok(axum::Json(body).into_response())
}
async fn index(State(app): State<App>) -> web::Result<Response> {
    let jobs = list(app.db()).await?;
    let mut body = String::from(
        "<p>Every generation and synchronization has a durable Run. Failed attempts stay recorded when retried.</p><div class=\"cds-stack\">",
    );
    for job in jobs {
        body += &format!(
            "<article class=\"cds-card\"><a href=\"/runs/{}\">{}</a>{}<p>{}</p></article>",
            escape(&job.id),
            escape(&run_title(&app, &job).await?),
            web::badge(&job.status),
            web::saved_time(job.created_at, "UTC")
        );
    }
    body += "</div>";
    Ok(web::page("Runs", web::Body::new(body)))
}
async fn detail(State(app): State<App>, Path(id): Path<String>) -> web::Result<Response> {
    let job = find(app.db(), &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    let mut body = format!(
        "<p><strong>{}</strong> · {} · attempt {}</p>",
        escape(&run_title(&app, &job).await?),
        web::badge(&job.status),
        job.attempt
    );
    if let Some(prior) = &job.retry_of {
        body += &format!(
            "<p>Retry of <a href=\"/runs/{}\">the original failed Run</a></p>",
            escape(prior)
        );
    }
    if let Some(error) = &job.error {
        body += &format!(
            "<p role=\"alert\">{}</p><form class=\"cds-inline-form\" method=\"post\" action=\"/runs/{}/retry\"><button class=\"cds-btn cds-btn--primary\">Retry with the original input</button></form>",
            escape(error),
            escape(&id)
        );
    }
    body += &format!(
        "<p>Created {} · Updated {}</p>",
        web::saved_time(job.created_at, "UTC"),
        web::saved_time(job.updated_at, "UTC")
    );
    if let Some(result) = &job.result {
        if let Some(valid) = result.get("ledger_valid").and_then(Value::as_bool) {
            body += &format!(
                "<p>Evidence ledger: {}</p>",
                web::badge(if valid { "reviewed" } else { "Ledger warnings" })
            );
        }
        if let Some(path) = result
            .get("url")
            .and_then(Value::as_str)
            .filter(|p| p.starts_with('/') && !p.starts_with("//"))
        {
            body += &format!(
                "<p><a class=\"cds-btn cds-btn--primary\" href=\"{}\">Open the result</a></p>",
                escape(path)
            );
        }
        body += &format!(
            "<details><summary>Result JSON</summary><pre>{}</pre></details>",
            escape(&serde_json::to_string_pretty(&result).unwrap_or_default())
        );
    }
    if job.status == "queued" || job.status == "running" {
        body += "<p role=\"status\"><span class=\"cds-progress\" aria-hidden=\"true\"></span>Work continues in the background. This page updates every 3 seconds. <a href=\"\">Refresh this Run</a> to see the result.</p>";
    }
    if job.kind == "meetings.debrief" {
        let mut traces = app
            .db()
            .list::<Value>("meeting_debrief_trace")
            .await?
            .into_iter()
            .filter(|t| t["run_id"].as_str() == Some(&id))
            .collect::<Vec<_>>();
        traces.sort_by_key(|t| t["recorded_at"].as_i64().unwrap_or_default());
        body += "<h2>Debrief progress and evidence checks</h2><p>Completed stages remain recorded if a later stage fails. A Run result is saved only after all required checks finish.</p><ul>";
        for t in traces {
            body += &format!(
                "<li>Attempt {}: {} · segment {} of {}<details><summary>Stage evidence and usage</summary><pre>{}</pre></details></li>",
                t["attempt"],
                escape(t["phase"].as_str().unwrap_or("Unknown stage")),
                t["segment"],
                t["total_segments"],
                escape(&serde_json::to_string_pretty(&t["details"]).unwrap_or_default())
            );
        }
        body += "</ul>";
    }
    // The timeline is the audit trail of what actually happened: every
    // stage the Run passed through, oldest first, with measured wall time
    // where the stage reports it. Empty for Runs admitted before the
    // timeline existed.
    let timeline = events(app.db(), &id).await?;
    if !timeline.is_empty() {
        body += "<h2>Run timeline</h2><ul>";
        for event in &timeline {
            let when = web::saved_time(event.at_ms, "UTC");
            let elapsed = event
                .elapsed_ms
                .map(|ms| format!(" · {ms} ms"))
                .unwrap_or_default();
            let action = event
                .action
                .as_deref()
                .map(|a| format!(" · {}", escape(a)))
                .unwrap_or_default();
            let detail = event
                .detail
                .as_deref()
                .map(|d| format!(" — {}", escape(d)))
                .unwrap_or_default();
            body += &format!(
                "<li>{} · {} · {}{}{}{}</li>",
                when,
                escape(&event.stage),
                escape(&event.status),
                elapsed,
                action,
                detail
            );
        }
        body += "</ul>";
    }
    let history = attempts(app.db(), &id).await?;
    if !history.is_empty() {
        body += &format!(
            "<details><summary>Attempt history</summary><pre>{}</pre></details>",
            escape(&serde_json::to_string_pretty(&history).map_err(anyhow::Error::from)?)
        );
    }
    if let Some(usage) = usage::for_run(app.db(), &job).await? {
        body += "<h2>Generation usage</h2>";
        let unmeasured = usage["llm_unmeasured_calls"].as_u64().unwrap_or_default();
        let cost = usage["llm_cost_usd"]
            .as_f64()
            .map(|cost| format!("Provider-reported cost: ${cost:.6}"))
            .unwrap_or_else(|| "Cost unavailable: not reported for every call".into());
        body += &format!(
            "<p>{} generation requests · {} measured input and {} measured output tokens · {}.</p>",
            usage["llm_calls"], usage["llm_input_tokens"], usage["llm_output_tokens"], cost
        );
        if unmeasured > 0 {
            body += &format!(
                "<p>{unmeasured} requests have unmeasured tokens. Unmeasured token counts are excluded; actual usage may be higher.</p>"
            );
        }
        if let Some(attempts) = usage["unrecorded_attempts"]
            .as_array()
            .filter(|attempts| !attempts.is_empty())
        {
            body += &format!(
                "<p>Usage unavailable for {} attempts. Measured totals exclude those attempts and may understate actual usage.</p>",
                attempts.len()
            );
        }
        body += &format!(
            "<details><summary>Per-call generation measurements</summary><pre>{}</pre></details>",
            escape(
                &serde_json::to_string_pretty(&usage["generation_calls"])
                    .map_err(anyhow::Error::from)?
            )
        );
    }
    // Critical Council: the review this Run saved, with its provider, model,
    // usage and cost boundary. The Council is mandatory for Terminal output,
    // so its charge is disclosed here on the Run diagnostics page.
    let council = crate::council::revisions_for_run(&app, &id).await?;
    if !council.is_empty() {
        body += "<h2>Critical Council review</h2>";
        for revision in &council {
            body += &crate::council::summary(revision);
        }
    }
    body += &format!(
        "<details><summary>Input snapshot</summary><pre>{}</pre></details>",
        escape(&serde_json::to_string_pretty(&job.input).unwrap_or_default())
    );
    Ok(web::page_refresh(
        "Run details",
        web::Body::new(body),
        matches!(job.status.as_str(), "queued" | "running"),
    ))
}
async fn retry(State(app): State<App>, Path(id): Path<String>) -> web::Result<Redirect> {
    let old = find(app.db(), &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Run not found"))?;
    if old.status != "failed" {
        return Err(web::Error::conflict("Only a failed Run can be retried."));
    }
    // A manual retry is also a web request: its correlation id lands on the
    // new Run's admission row.
    let correlation = crate::correlation::current();
    let new = app
        .db()
        .transaction(move |tx| {
            let new = enqueue_tx(
                tx,
                &old.kind,
                &old.key,
                old.input.clone(),
                correlation.as_deref(),
            )?;
            tx.execute(
                "UPDATE job SET retry_of=?2 WHERE id=?1 AND retry_of IS NULL",
                params![new.id, old.id],
            )?;
            crate::terminal::automatic::rebind_retry(tx, &old, &new.id)?;
            Ok(new)
        })
        .await?;
    Ok(Redirect::to(&format!("/runs/{}", new.id)))
}

async fn run_title(app: &App, job: &Job) -> anyhow::Result<String> {
    let kind = match job.kind.as_str() {
        "terminal.profile" => "Automatic Profile Research",
        "terminal.report" => "Terminal Research Report",
        "terminal.company_research" => "Company Research",
        "terminal.person_research" => "Person Research",
        "terminal.company_continue" => "Continue Company Research",
        "terminal.person_continue" => "Continue Person Research",
        "meetings.debrief" => "Meeting Debrief",
        "meetings.brief" => "Meeting Brief",
        "content.watch" => "Content Research",
        _ => return run_title_with_label(app, job, &web::display_label(&job.kind)).await,
    };
    run_title_with_label(app, job, kind).await
}
async fn run_title_with_label(app: &App, job: &Job, label: &str) -> anyhow::Result<String> {
    for path in [
        "/company/name",
        "/person/name",
        "/meeting/title",
        "/watch/name",
        "/task/title",
        "/revision/subject",
    ] {
        if let Some(target) = job
            .input
            .pointer(path)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Ok(format!("{label} — {target}"));
        }
    }
    for (field, name) in [("watches", "name"), ("channels", "title")] {
        if let Some(items) = job.input[field].as_array() {
            let names = items
                .iter()
                .filter_map(|v| v[name].as_str())
                .take(3)
                .collect::<Vec<_>>();
            if !names.is_empty() {
                return Ok(format!(
                    "{label} — {}{}",
                    names.join(", "),
                    if items.len() > 3 { "…" } else { "" }
                ));
            }
        }
    }
    for (field, kind, name) in [
        ("person_id", "person", "name"),
        ("company_id", "company", "name"),
        ("meeting_id", "meeting", "title"),
        ("project_id", "content.project", "subject"),
        ("task_id", "task", "title"),
    ] {
        if let Some(id) = job.input[field].as_str()
            && let Some(record) = app.db().get::<Value>(kind, id).await?
        {
            let target = record[name]
                .as_str()
                .or_else(|| record["revisions"].as_array()?.last()?[name].as_str());
            if let Some(target) = target {
                return Ok(format!("{label} — {target}"));
            }
        }
    }
    if let Some(name) = job
        .result
        .as_ref()
        .and_then(|r| r.get("target_label"))
        .and_then(Value::as_str)
    {
        return Ok(format!("{label} — {name}"));
    }
    Ok(label.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_flush_marks_truncation_instead_of_dropping_silently() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES('r','k','k','{}','done',1,1)",
            [],
        )
        .unwrap();
        let events: Vec<crate::connection::RecordedEvent> = (0..RUN_EVENT_CAP + 5)
            .map(|i| {
                crate::connection::RecordedEvent::new(
                    "note",
                    None,
                    "ok",
                    None,
                    Some(&i.to_string()),
                )
            })
            .collect();
        let tx = conn.transaction().unwrap();
        flush_events_tx(&tx, "r", 1, &events, 0, 0).unwrap();
        tx.commit().unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_event WHERE run_id='r'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(total, RUN_EVENT_CAP + 1, "cap plus one truncation marker");
        let detail: String = conn
            .query_row(
                "SELECT detail FROM run_event WHERE run_id='r' AND stage='diagnostics_truncated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            detail.contains("5 timeline events were dropped"),
            "{detail}"
        );
    }
}

#[cfg(test)]
mod truncation_stream_tests {
    use super::*;

    /// Rows streamed after the cap must not vanish without a trace: one
    /// marker, however often the cap is hit.
    #[test]
    fn streamed_events_at_the_cap_leave_one_marker_not_a_silent_drop() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES('r','k','k','{}','done',1,1)",
            [],
        )
        .unwrap();
        let events: Vec<crate::connection::RecordedEvent> = (0..RUN_EVENT_CAP)
            .map(|_| {
                crate::connection::RecordedEvent::new("lease_renewed", None, "running", None, None)
            })
            .collect();
        let tx = conn.transaction().unwrap();
        flush_events_tx(&tx, "r", 1, &events, 0, 0).unwrap();
        for _ in 0..5 {
            assert!(
                !record_event_tx(
                    &tx,
                    "r",
                    1,
                    &crate::connection::RecordedEvent::new("note", None, "ok", None, None),
                )
                .unwrap(),
                "events at the cap are dropped, not stored"
            );
        }
        tx.commit().unwrap();
        let markers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM run_event WHERE run_id='r' AND stage='diagnostics_truncated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(markers, 1, "one marker however often the cap is hit");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_event WHERE run_id='r'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(total, RUN_EVENT_CAP + 1, "cap plus the marker");
    }

    /// The final flush upgrades a streamed first-time notice to the full
    /// drop counts, including the events the write-through already skipped,
    /// so the marker never undercounts.
    #[test]
    fn flush_upgrades_a_streamed_marker_with_the_full_drop_counts() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES('r','k','k','{}','done',1,1)",
            [],
        )
        .unwrap();
        let full: Vec<crate::connection::RecordedEvent> = (0..RUN_EVENT_CAP)
            .map(|_| {
                crate::connection::RecordedEvent::new("lease_renewed", None, "running", None, None)
            })
            .collect();
        let tx = conn.transaction().unwrap();
        flush_events_tx(&tx, "r", 1, &full, 0, 0).unwrap();
        // Write-through: three events refused at the cap, each accounted.
        for _ in 0..3 {
            assert!(
                !record_event_tx(
                    &tx,
                    "r",
                    1,
                    &crate::connection::RecordedEvent::new("note", None, "ok", None, None)
                )
                .unwrap()
            );
        }
        // Finalization: two retained events fit nowhere; cursor advanced past
        // the three dropped ones, so they arrive as `storage_dropped`.
        let tail: Vec<crate::connection::RecordedEvent> = (0..2)
            .map(|i| {
                crate::connection::RecordedEvent::new(
                    "note",
                    None,
                    "ok",
                    None,
                    Some(&i.to_string()),
                )
            })
            .collect();
        flush_events_tx(&tx, "r", 1, &tail, 3, 7).unwrap();
        tx.commit().unwrap();
        let markers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM run_event WHERE run_id='r' AND stage='diagnostics_truncated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            markers, 1,
            "the streamed marker is upgraded, not duplicated"
        );
        let detail: String = conn
            .query_row(
                "SELECT detail FROM run_event WHERE run_id='r' AND stage='diagnostics_truncated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            detail.contains("5 timeline events were dropped"),
            "three write-through skips plus two flush drops: {detail}"
        );
        assert!(
            detail.contains("in-memory recorder had already dropped 7"),
            "memory drops ride the same marker: {detail}"
        );
        assert!(
            !detail.contains("streamed rows after this point were dropped"),
            "the provisional notice is replaced: {detail}"
        );
    }

    /// Recorder-side drops leave a marker even when the store never hit the
    /// cap: a quiet-looking timeline must not hide them.
    #[test]
    fn memory_only_drops_leave_a_marker() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO job(id,kind,dedup_key,input,status,created_at,updated_at) VALUES('r','k','k','{}','done',1,1)",
            [],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        flush_events_tx(&tx, "r", 1, &[], 0, 4).unwrap();
        tx.commit().unwrap();
        let detail: String = conn
            .query_row(
                "SELECT detail FROM run_event WHERE run_id='r' AND stage='diagnostics_truncated'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            detail.contains("4 newer timeline events were dropped by the in-memory recorder's cap"),
            "{detail}"
        );
    }
}
