use super::*;
use crate::store;

/// Privacy deletion also covers the automatic workflow's snapshots and
/// repository archives. Otherwise the old privacy endpoint would retain a
/// second copy of everything the user explicitly asked to remove.
pub(crate) fn purge(
    tx: &rusqlite::Transaction<'_>,
    archive: &std::path::Path,
    kind: &str,
    id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        ["person", "company"].contains(&kind)
            && !id.is_empty()
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Invalid profile archive path"
    );
    let key = subject_key(kind, id);
    store::purge(tx, "terminal_identity", &key)?;
    store::purge(tx, "terminal_dossier", &key)?;
    let mut request_ids = Vec::new();
    for request in store::list::<Request>(tx, "terminal_request")? {
        if request.identity.kind == kind
            && (request.target_id.as_deref() == Some(id)
                || request
                    .choices
                    .iter()
                    .any(|c| c.existing_id.as_deref() == Some(id)))
        {
            request_ids.push(request.id.clone());
            store::purge(tx, "terminal_request", &request.id)?;
            store::purge(tx, "terminal_collection", &request.id)?;
        }
    }
    for kind in ["terminal_synthesis", "terminal_sections"] {
        for cached in store::list::<Value>(tx, kind)? {
            if cached["request_id"]
                .as_str()
                .is_some_and(|r| request_ids.iter().any(|id| id == r))
            {
                // Cache IDs are content hashes; read their durable row IDs
                // rather than trying to reconstruct a generation fingerprint.
                let mut statement = tx.prepare(
                    "SELECT id FROM record WHERE kind=?1 AND json_extract(body,'$.request_id')=?2",
                )?;
                let ids = statement
                    .query_map(
                        rusqlite::params![kind, cached["request_id"].as_str()],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for cache_id in ids {
                    store::purge(tx, kind, &cache_id)?;
                }
            }
        }
    }
    let mut report_ids = Vec::new();
    for report in store::list::<super::reports::Report>(tx, "terminal_report")? {
        if report.subjects.iter().any(|s| s.kind == kind && s.id == id) {
            report_ids.push(report.id.clone());
            store::purge(tx, "terminal_report", &report.id)?;
        }
    }
    for candidate in store::list::<Candidate>(tx, "terminal_candidate")? {
        if candidate.discovered_from.iter().any(|s| s == id)
            || candidate
                .request_id
                .as_ref()
                .is_some_and(|r| request_ids.contains(r))
        {
            store::purge(tx, "terminal_candidate", &candidate.id)?;
        }
    }
    let mut statement = tx
        .prepare("SELECT id,input FROM job WHERE kind IN ('terminal.profile','terminal.report')")?;
    let jobs = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (job_id, input) in jobs {
        let input: Value = serde_json::from_str(&input)?;
        if input["request_id"]
            .as_str()
            .is_some_and(|r| request_ids.iter().any(|id| id == r))
            || input["report_id"]
                .as_str()
                .is_some_and(|r| report_ids.iter().any(|id| id == r))
        {
            tx.execute("DELETE FROM job_attempt WHERE job_id=?1", [&job_id])?;
            tx.execute("DELETE FROM job WHERE id=?1", [&job_id])?;
        }
    }
    let folder = archive.join(kind).join(id);
    if folder.exists() {
        std::fs::remove_dir_all(folder)?;
    }
    Ok(())
}
