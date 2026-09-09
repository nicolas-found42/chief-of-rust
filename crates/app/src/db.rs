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
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run `f` against the connection on the blocking pool. Writers and
    /// readers serialize on the mutex; WAL + single-user makes that fine.
    async fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
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

    /// One background-tick heartbeat. Rows persist across restarts: the
    /// durable clock starts here.
    pub async fn record_tick(&self, at_ms: i64) -> anyhow::Result<()> {
        self.with_conn(move |conn| conn.execute("INSERT INTO tick (at_ms) VALUES (?1)", [at_ms]))
            .await
            .map(|_| ())
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
}
