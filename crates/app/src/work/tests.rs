use super::queue::{flush_events_tx, record_event_tx};
use super::*;
// Unit tests

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
            crate::connection::RecordedEvent::new("note", None, "ok", None, Some(&i.to_string()))
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
