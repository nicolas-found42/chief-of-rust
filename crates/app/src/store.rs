//! Versioned Workspace records shared by the five product areas.
use crate::db::Db;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS record (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS revision (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY(kind,id,revision));
";

pub fn get<T: DeserializeOwned>(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> anyhow::Result<Option<T>> {
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM record WHERE kind=?1 AND id=?2",
            params![kind, id],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|body| serde_json::from_str(&body).map_err(Into::into))
        .transpose()
}
pub fn list<T: DeserializeOwned>(conn: &Connection, kind: &str) -> anyhow::Result<Vec<T>> {
    let mut stmt =
        conn.prepare("SELECT body FROM record WHERE kind=?1 ORDER BY updated_at DESC,id")?;
    let rows = stmt.query_map([kind], |r| r.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
pub fn put<T: Serialize>(conn: &Connection, kind: &str, id: &str, value: &T) -> anyhow::Result<()> {
    let body = serde_json::to_string(value)?;
    let now = crate::now_ms();
    conn.execute("INSERT INTO record(kind,id,body,revision,updated_at) VALUES(?1,?2,?3,(SELECT COALESCE(MAX(revision),0)+1 FROM revision WHERE kind=?1 AND id=?2),?4) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, revision=record.revision+1,updated_at=excluded.updated_at", params![kind,id,body,now])?;
    conn.execute("INSERT INTO revision(kind,id,revision,body,at_ms) SELECT kind,id,revision,body,updated_at FROM record WHERE kind=?1 AND id=?2", params![kind,id])?;
    Ok(())
}
pub fn delete(conn: &Connection, kind: &str, id: &str) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM record WHERE kind=?1 AND id=?2",
        params![kind, id],
    )?;
    Ok(())
}
pub fn purge(conn: &Connection, kind: &str, id: &str) -> anyhow::Result<()> {
    delete(conn, kind, id)?;
    conn.execute(
        "DELETE FROM revision WHERE kind=?1 AND id=?2",
        params![kind, id],
    )?;
    Ok(())
}
impl Db {
    pub async fn get<T: DeserializeOwned + Send + 'static>(
        &self,
        kind: &str,
        id: &str,
    ) -> anyhow::Result<Option<T>> {
        let (kind, id) = (kind.to_owned(), id.to_owned());
        self.transaction(move |tx| get(tx, &kind, &id)).await
    }
    pub async fn list<T: DeserializeOwned + Send + 'static>(
        &self,
        kind: &str,
    ) -> anyhow::Result<Vec<T>> {
        let kind = kind.to_owned();
        self.transaction(move |tx| list(tx, &kind)).await
    }
    pub async fn put<T: Serialize + Send + 'static>(
        &self,
        kind: &str,
        id: &str,
        value: T,
    ) -> anyhow::Result<()> {
        let (kind, id) = (kind.to_owned(), id.to_owned());
        self.transaction(move |tx| put(tx, &kind, &id, &value))
            .await
    }
    pub async fn delete(&self, kind: &str, id: &str) -> anyhow::Result<()> {
        let (kind, id) = (kind.to_owned(), id.to_owned());
        self.transaction(move |tx| delete(tx, &kind, &id)).await
    }
}
