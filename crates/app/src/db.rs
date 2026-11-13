//! SQLite store. One `rusqlite::Connection` behind a mutex; every access is
//! pushed onto the blocking pool because rusqlite is synchronous and a
//! `Connection` must never be held across an await point (survey #3:
//! bundled, WAL, spawn_blocking pattern, plenty for single-user).

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

/// Versioned by `CREATE TABLE IF NOT EXISTS` — the prototype has no history
/// to migrate, so there is no migration machinery yet either.
const MIGRATIONS: &str = "
CREATE TABLE IF NOT EXISTS tick (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_call (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms    INTEGER NOT NULL,
    provider TEXT    NOT NULL,
    prompt   TEXT    NOT NULL,
    reply    TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_event (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at_ms  INTEGER NOT NULL,
    source TEXT    NOT NULL,
    event  TEXT    NOT NULL,
    detail TEXT
);
";

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5_000)?;
        conn.execute_batch(MIGRATIONS)?;
        conn.execute_batch(crate::store::SCHEMA)?;
        conn.execute_batch(crate::work::SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run `f` against the connection on the blocking pool. Writers and
    /// readers serialize on the mutex; WAL + single-user makes that fine.
    pub(crate) async fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        let result = tokio::task::spawn_blocking(move || {
            let conn = conn.lock().expect("db mutex poisoned");
            f(&conn)
        })
        .await??;
        Ok(result)
    }

    /// Product mutations share a transaction so related records and their
    /// history commit together, including Action Item acceptance into Tasks.
    pub async fn transaction<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> anyhow::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let mut conn = conn
                .lock()
                .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let result = f(&tx)?;
            tx.commit()?;
            Ok(result)
        })
        .await?
    }

    /// One background-tick heartbeat. Rows persist across restarts: the
    /// durable clock starts here.
    pub async fn record_tick(&self, at_ms: i64) -> anyhow::Result<()> {
        self.with_conn(move |conn| conn.execute("INSERT INTO tick (at_ms) VALUES (?1)", [at_ms]))
            .await
            .map(|_| ())
    }

    /// How long ago the worker last heartbeat, in milliseconds. The heartbeat
    /// runs on its own task, so a long Run cannot make a live worker look
    /// dead. `None` while the table is empty: a fresh workspace
    /// before the worker's first tick.
    pub async fn worker_tick_age(&self) -> anyhow::Result<Option<i64>> {
        self.with_conn(worker_tick_age_sync).await
    }

    /// One durable worker-lifecycle observation: loop start, tick panics,
    /// admission and prune failures, shutdown. Worker-side anomalies were
    /// stdout-only before, so a recreated container lost them. `detail` is
    /// caller-redacted and bounded (`bound_detail`).
    pub async fn record_ops_event(
        &self,
        source: &str,
        event: &str,
        detail: Option<&str>,
    ) -> anyhow::Result<()> {
        let (source, event, detail) = (
            source.to_owned(),
            event.to_owned(),
            detail.map(bound_detail),
        );
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO ops_event (at_ms, source, event, detail) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![crate::now_ms(), source, event, detail],
            )
        })
        .await
        .map(|_| ())
    }

    /// Retained ops events, newest first. The ops inbox for restart-proof
    /// worker evidence; `since_ms` bounds the window explicitly.
    pub async fn ops_events(
        &self,
        since_ms: Option<i64>,
        limit: usize,
    ) -> anyhow::Result<Vec<OpsEvent>> {
        self.transaction(move |tx| ops_events_sync(tx, since_ms, limit))
            .await
    }

    pub async fn record_llm_call(
        &self,
        at_ms: i64,
        provider: &str,
        prompt: &str,
        reply: &str,
    ) -> anyhow::Result<()> {
        let provider = provider.to_string();
        let prompt = prompt.to_string();
        let reply = reply.to_string();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO llm_call (at_ms, provider, prompt, reply) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![at_ms, provider, prompt, reply],
            )
        })
        .await
        .map(|_| ())
    }
    /// Retention caps for diagnostics tables. The finished Run records,
    /// briefs and revision history are never pruned here — only the
    /// append-only heartbeat, the model-diagnostic log and orphaned timeline
    /// rows whose Run is gone. Privacy deletion removes a subject's own
    /// timeline rows outright (see the terminal purge paths).
    pub async fn prune_diagnostics(&self) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            // Heartbeat: keep the latest 500 ticks; the count is the clock.
            conn.execute(
                "DELETE FROM tick WHERE id NOT IN (SELECT id FROM tick ORDER BY id DESC LIMIT 500)",
                [],
            )?;
            // Model diagnostics: keep the latest 50 calls.
            conn.execute(
                "DELETE FROM llm_call WHERE id NOT IN (SELECT id FROM llm_call ORDER BY id DESC LIMIT 50)",
                [],
            )?;
            // Worker-lifecycle evidence: keep the latest 200 events, enough
            // boot and panic history to reconstruct a recent incident without
            // growing with the queue.
            conn.execute(
                "DELETE FROM ops_event WHERE id NOT IN (SELECT id FROM ops_event ORDER BY id DESC LIMIT 200)",
                [],
            )?;
            // Timeline rows whose Run row is gone (deleted outside the
            // purge paths) carry no subject and no audit value.
            conn.execute(
                "DELETE FROM run_event WHERE run_id NOT IN (SELECT id FROM job)",
                [],
            )?;
            Ok(())
        })
        .await
        .map(|_| ())
    }

    /// What the home page shows: tick count, last tick timestamp, and the
    /// last model call if any.
    pub async fn stats(&self) -> anyhow::Result<Stats> {
        self.with_conn(|conn| {
            let tick_count: i64 =
                conn.query_row("SELECT COUNT(*) FROM tick", [], |row| row.get(0))?;
            let last_tick_ms: Option<i64> =
                conn.query_row("SELECT MAX(at_ms) FROM tick", [], |row| row.get(0))?;
            let last_call = conn
                .query_row(
                    "SELECT provider, prompt, reply FROM llm_call ORDER BY id DESC LIMIT 1",
                    [],
                    |row| {
                        Ok(LlmCall {
                            provider: row.get(0)?,
                            prompt: row.get(1)?,
                            reply: row.get(2)?,
                        })
                    },
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })?;
            Ok(Stats {
                tick_count,
                last_tick_ms,
                last_call,
            })
        })
        .await
    }
}

/// Read the durable heartbeat from either the server connection or the
/// read-only inspect connection. An empty table is distinct from a read error.
pub(crate) fn worker_tick_age_sync(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT MAX(at_ms) FROM tick", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .map(|at| crate::now_ms().saturating_sub(at)))
}

#[derive(Debug, Clone)]
pub struct Stats {
    pub tick_count: i64,
    pub last_tick_ms: Option<i64>,
    pub last_call: Option<LlmCall>,
}

#[derive(Debug, Clone)]
pub struct LlmCall {
    pub provider: String,
    pub prompt: String,
    pub reply: String,
}

/// One retained worker-lifecycle observation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OpsEvent {
    pub id: i64,
    pub at_ms: i64,
    /// Wall-clock form of `at_ms` in UTC, so an investigator never has to
    /// convert epochs by hand or guess the timezone.
    pub at_utc: String,
    pub source: String,
    pub event: String,
    pub detail: Option<String>,
}

/// Reads ops events against a plain connection: the async wrapper runs it on
/// the blocking pool, and the `inspect` CLI calls it directly on its own
/// read-only store.
pub fn ops_events_sync(
    conn: &rusqlite::Connection,
    since_ms: Option<i64>,
    limit: usize,
) -> anyhow::Result<Vec<OpsEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, at_ms, source, event, detail FROM ops_event \
         WHERE (?1 IS NULL OR at_ms >= ?1) ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![since_ms, limit.clamp(1, 500) as i64],
        |row| {
            let at_ms: i64 = row.get(1)?;
            Ok(OpsEvent {
                at_utc: chrono::DateTime::from_timestamp_millis(at_ms)
                    .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                    .unwrap_or_else(|| format!("{at_ms} (outside the representable range)")),
                id: row.get(0)?,
                at_ms: row.get(1)?,
                source: row.get(2)?,
                event: row.get(3)?,
                detail: row.get(4)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Ops-event details are diagnostics, not payloads: the redacted cause fits
/// in a bounded tail so a pathological error cannot grow a row without bound.
pub(crate) fn bound_detail(detail: &str) -> String {
    let mut detail: String = detail.chars().take(300).collect();
    if detail.trim().is_empty() {
        detail = "(empty)".to_owned();
    }
    detail
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ticks_and_calls_persist_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");

        let db = Db::open(&path).unwrap();
        db.record_tick(1_000).await.unwrap();
        db.record_tick(2_000).await.unwrap();
        db.record_llm_call(3_000, "mock", "hello", "[mock] hi")
            .await
            .unwrap();
        drop(db);

        // A fresh open reads the same rows: the record outlives the process.
        let db = Db::open(&path).unwrap();
        let stats = db.stats().await.unwrap();
        assert_eq!(stats.tick_count, 2);
        assert_eq!(stats.last_tick_ms, Some(2_000));
        let call = stats.last_call.expect("llm call recorded");
        assert_eq!(call.provider, "mock");
        assert_eq!(call.reply, "[mock] hi");
    }
    #[tokio::test]
    async fn prune_keeps_latest_diagnostics_and_drops_orphan_timeline() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("test.db")).unwrap();
        for at in 0..600 {
            db.record_tick(at).await.unwrap();
        }
        for at in 0..60 {
            db.record_llm_call(at, "mock", "hello", "[mock] hi")
                .await
                .unwrap();
        }
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO run_event (run_id, at_ms, stage, status) VALUES ('gone-run', 1, 'collect', 'done')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        db.prune_diagnostics().await.unwrap();
        let stats = db.stats().await.unwrap();
        // Newest 500 ticks survive: the max timestamp proves the kept side.
        assert_eq!(stats.tick_count, 500);
        assert_eq!(stats.last_tick_ms, Some(599));
        let calls: i64 = db
            .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM llm_call", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(calls, 50);
        let orphans: i64 = db
            .with_conn(|conn| conn.query_row("SELECT COUNT(*) FROM run_event", [], |r| r.get(0)))
            .await
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[tokio::test]
    async fn ops_events_persist_across_reopen_and_prune_to_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");

        let db = Db::open(&path).unwrap();
        db.record_ops_event("worker", "started", None)
            .await
            .unwrap();
        db.record_ops_event("worker", "tick_panicked", Some("tick task panicked"))
            .await
            .unwrap();
        drop(db);

        // Evidence outlives the process that wrote it.
        let db = Db::open(&path).unwrap();
        let events = db.ops_events(None, 10).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "tick_panicked");
        assert_eq!(events[0].source, "worker");
        assert_eq!(events[0].detail.as_deref(), Some("tick task panicked"));

        for at in 0..250 {
            db.record_ops_event("worker", "started", Some(&at.to_string()))
                .await
                .unwrap();
        }
        db.prune_diagnostics().await.unwrap();
        let kept = db.ops_events(None, 500).await.unwrap().len();
        assert_eq!(kept, 200);
        let long = "x".repeat(1_000);
        db.record_ops_event("worker", "tick_panicked", Some(&long))
            .await
            .unwrap();
        let bounded = db.ops_events(None, 1).await.unwrap();
        assert_eq!(bounded[0].detail.as_deref().map(str::len), Some(300));
    }

    #[tokio::test]
    async fn ops_event_window_filters_by_since() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("test.db")).unwrap();
        db.transaction(|tx| {
            tx.execute(
                "INSERT INTO ops_event (at_ms, source, event) VALUES (1_000, 'worker', 'started')",
                [],
            )?;
            tx.execute(
                "INSERT INTO ops_event (at_ms, source, event) VALUES (2_000, 'worker', 'shutdown')",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let recent = db.ops_events(Some(1_500), 10).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].event, "shutdown");
    }
}
