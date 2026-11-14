use crate::db::Db;
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

pub(super) fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
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
pub(super) const COLUMNS: &str =
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

/// Publication requires the same attempt that still owns the job lease.
pub(crate) fn owns_attempt(
    db: &rusqlite::Connection,
    id: &str,
    attempt: u32,
) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM job WHERE id=?1 AND status='running' AND attempt=?2)",
        params![id, attempt],
        |row| row.get(0),
    )
}

pub(crate) fn enqueue_tx(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    key: &str,
    mut input: Value,
    correlation: Option<&str>,
    origin: Option<&str>,
) -> anyhow::Result<Job> {
    let action = crate::correlation::admission_action(correlation, origin);
    if let Some(job)=tx.query_row(&format!("SELECT {COLUMNS} FROM job WHERE kind=?1 AND dedup_key=?2 AND status IN ('queued','running')"),params![kind,key],from_row).optional()? {
        // A suppressed admission is evidence, not silence: the existing Run
        // records that this trigger fired and deduplicated, so an investigator
        // can tell "the schedule never ran" from "it ran and joined live work".
        if let Some(action) = action {
            record_event_tx(
                tx,
                &job.id,
                job.attempt,
                &crate::connection::RecordedEvent::new(
                    "admitted",
                    Some(&action),
                    "deduplicated",
                    None,
                    Some(kind),
                ),
            )?;
        }
        return Ok(job);
    }
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
            action.as_deref(),
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
    let origin = crate::correlation::origin();
    let (kind, key) = (kind.to_owned(), key.to_owned());
    db.transaction(move |tx| {
        enqueue_tx(
            tx,
            &kind,
            &key,
            input,
            correlation.as_deref(),
            origin.as_deref(),
        )
    })
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
/// Workflow checkpoints written beside one Run: meeting-debrief stage traces
/// and terminal request/report phase records. They live in the `record`
/// table, not `run_event`, so a phase failure that never reaches the closing
/// row is invisible to a timeline-only reader. Bounded to the newest 100
/// rows; the boolean reports that the bound was hit rather than hiding it.
///
/// Only progress metadata is projected. The checkpoint bodies carry transcript
/// and report text; the diagnostics endpoint deliberately never exposes that
/// (the Run page does, for the owner). `details_keys` names which detail
/// facets were recorded without copying their values.
pub fn traces_sync(
    connection: &rusqlite::Connection,
    run_id: &str,
) -> anyhow::Result<(Vec<Value>, bool)> {
    let mut statement = connection.prepare(
        "SELECT kind, body FROM record \
         WHERE kind IN ('meeting_debrief_trace','terminal_request','terminal_report') \
           AND json_extract(body, '$.run_id') = ?1 \
         ORDER BY updated_at, rowid LIMIT 101",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut traces = Vec::new();
    for row in rows {
        let (kind, body) = row?;
        let body: Value = serde_json::from_str(&body)?;
        traces.push(trace_metadata(&kind, &body));
    }
    let truncated = traces.len() > 100;
    traces.truncate(100);
    Ok((traces, truncated))
}

/// The progress fields of one checkpoint, never its content.
fn trace_metadata(kind: &str, body: &Value) -> Value {
    let field = |name: &str| body.get(name).cloned().unwrap_or(Value::Null);
    match kind {
        "meeting_debrief_trace" => serde_json::json!({
            "kind": kind,
            "id": field("id"),
            "run_id": field("run_id"),
            "attempt": field("attempt"),
            "phase": field("phase"),
            "segment": field("segment"),
            "total_segments": field("total_segments"),
            "recorded_at": field("recorded_at"),
            "details_keys": body
                .get("details")
                .and_then(Value::as_object)
                .map(|details| details.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default(),
        }),
        "terminal_request" => serde_json::json!({
            "kind": kind,
            "id": field("id"),
            "run_id": field("run_id"),
            "status": field("status"),
            "phase": field("phase"),
            "created_at": field("created_at"),
        }),
        _ => serde_json::json!({
            "kind": kind,
            "id": field("id"),
            "run_id": field("run_id"),
            "published_run_id": field("published_run_id"),
            "created_at": field("created_at"),
        }),
    }
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
pub(super) fn record_event_tx(
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
pub(super) fn mark_truncated_tx(
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
pub(super) fn append_event_tx(
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
