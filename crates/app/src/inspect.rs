//! Read-only inspection of a workspace store, for investigations that start
//! from a symptom and a time window instead of an operation id, and that must
//! work when the HTTP server is down. The same SQLite evidence the routes
//! expose, through a query surface an agent can run directly:
//!
//! ```text
//! chief-of-rust inspect runs      [--since TS] [--until TS] [--kind K] [--status S] [--request-id ID] [--limit N]
//! chief-of-rust inspect run <RUN_ID>
//! chief-of-rust inspect events    [--since TS] [--until TS] [--stage S] [--status S] [--action A] [--limit N]
//! chief-of-rust inspect ops       [--since TS] [--limit N]
//! chief-of-rust inspect http      [--since TS] [--request-id ID] [--limit N]
//! chief-of-rust inspect schedules
//! chief-of-rust inspect health
//! ```
//!
//! `TS` accepts RFC 3339 (`2026-11-03T14:00:00Z`) or epoch milliseconds.
//! Every timestamp in the output carries an explicit UTC rendering. The
//! store opens read-only: inspection never mutates a workspace.

use crate::db::OpsEvent;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

pub const HELP: &str = "Read-only investigation of the workspace store.

USAGE:
    chief-of-rust inspect runs      [--since TS] [--until TS] [--kind K] [--status S] [--request-id ID] [--limit N]
    chief-of-rust inspect run <RUN_ID>
    chief-of-rust inspect events    [--since TS] [--until TS] [--stage S] [--status S] [--action A] [--limit N]
    chief-of-rust inspect ops       [--since TS] [--limit N]
    chief-of-rust inspect http      [--since TS] [--request-id ID] [--limit N]
    chief-of-rust inspect schedules
    chief-of-rust inspect health
  runs       Runs in a time/kind/status window, newest first. Empty output
             means no matching rows — evidence of absence only within the window.
  run        One Run's durable evidence: record, attempts, timeline, usage,
             and the workflow checkpoints written beside it.
  events     Timeline rows across all Runs, filtered by stage/status/action,
             so a symptom class is findable without opening every Run.
  ops        Durable worker-lifecycle events (boot, panics, admission failures).
  http       Retained server-side HTTP failures (5xx) with request id, route
             and redacted cause. A pre-Run failure leaves no Run row.
  schedules  Saved schedule state: enabled, interval, last attempt, last error.
  health     Queue counters, worker heartbeat age, store integrity.

Timestamps accept RFC 3339 (2026-11-03T14:00:00Z) or epoch milliseconds.
All output times are UTC. The store opens read-only.

Set WORKSPACE_DIR to the installation's workspace volume (default: ./workspace).";

const HELP_SUMMARY: &str = "See `chief-of-rust inspect --help`.";

enum Command {
    Runs {
        since: Option<String>,
        until: Option<String>,
        kind: Option<String>,
        status: Option<String>,
        request_id: Option<String>,
        limit: usize,
    },
    Run {
        run_id: String,
    },
    Ops {
        since: Option<String>,
        limit: usize,
    },
    Events {
        since: Option<String>,
        until: Option<String>,
        stage: Option<String>,
        status: Option<String>,
        action: Option<String>,
        limit: usize,
    },
    Http {
        since: Option<String>,
        request_id: Option<String>,
        limit: usize,
    },
    Schedules,
    Health,
}

/// Hand-rolled like the rest of the config surface: the prototype judges the
/// shape before a parser crate earns its dependency weight.
fn parse_command(args: &[String]) -> anyhow::Result<Command> {
    let mut positional: Vec<String> = Vec::new();
    let mut flags: std::collections::HashMap<String, String> = Default::default();
    let mut values = args.iter().peekable();
    while let Some(arg) = values.next() {
        if let Some(name) = arg.clone().strip_prefix("--").map(str::to_owned) {
            let value = values
                .next()
                .filter(|next| !next.starts_with("--"))
                .ok_or_else(|| anyhow::anyhow!("--{name} needs a value. {HELP_SUMMARY}"))?
                .clone();
            flags.insert(name, value);
        } else {
            positional.push(arg.clone());
        }
    }
    // `--limit` belongs to the windowed commands only; a stray one elsewhere
    // is a mistake, not a no-op.
    let take_limit =
        |flags: &mut std::collections::HashMap<String, String>| match flags.remove("limit") {
            Some(raw) => raw
                .parse::<usize>()
                .map_err(|error| anyhow::anyhow!("--limit is not a number: {error}")),
            None => Ok(50),
        };
    let command: anyhow::Result<Command> = match positional.first().map(String::as_str) {
        Some("runs") => {
            let limit = take_limit(&mut flags)?;
            Ok(Command::Runs {
                since: flags.remove("since"),
                until: flags.remove("until"),
                kind: flags.remove("kind"),
                status: flags.remove("status"),
                request_id: flags.remove("request-id"),
                limit,
            })
        }
        Some("run") => Ok(Command::Run {
            run_id: positional
                .get(1)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("`run` needs a RUN_ID. {HELP_SUMMARY}"))?,
        }),
        Some("ops") => Ok(Command::Ops {
            since: flags.remove("since"),
            limit: take_limit(&mut flags)?,
        }),
        Some("events") => {
            let limit = take_limit(&mut flags)?;
            Ok(Command::Events {
                since: flags.remove("since"),
                until: flags.remove("until"),
                stage: flags.remove("stage"),
                status: flags.remove("status"),
                action: flags.remove("action"),
                limit,
            })
        }
        Some("http") => {
            let limit = take_limit(&mut flags)?;
            Ok(Command::Http {
                since: flags.remove("since"),
                request_id: flags.remove("request-id"),
                limit,
            })
        }
        Some("schedules") => Ok(Command::Schedules),
        Some("health") => Ok(Command::Health),
        _ => anyhow::bail!("Unknown inspect command. {HELP_SUMMARY}"),
    };
    // A misspelled flag must fail loudly: a silently ignored `--sine` would
    // return an unfiltered window that looks like a correct answer.
    let command = command?;
    if !flags.is_empty() {
        let mut unknown: Vec<String> = flags.into_keys().collect();
        unknown.sort();
        anyhow::bail!(
            "Unknown option{} {}. {HELP_SUMMARY}",
            if unknown.len() == 1 { "" } else { "s" },
            unknown
                .iter()
                .map(|name| format!("--{name}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(command)
}

#[derive(Serialize)]
struct RunSummary {
    id: String,
    kind: String,
    status: String,
    attempt: i64,
    created_at_ms: i64,
    created_at_utc: String,
    updated_at_ms: i64,
    updated_at_utc: String,
    retry_of: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Attempt {
    attempt: i64,
    started_at_ms: i64,
    started_at_utc: String,
    finished_at_ms: Option<i64>,
    finished_at_utc: Option<String>,
    outcome: Option<String>,
    provider: String,
    model: String,
}

/// One timeline row with its Run's kind, for cross-Run searches. The Run id
/// stays the join key back to `inspect run`.
#[derive(Serialize)]
struct EventRow {
    at_ms: i64,
    at_utc: String,
    run_id: String,
    kind: String,
    attempt: i64,
    stage: String,
    action: Option<String>,
    status: String,
    elapsed_ms: Option<i64>,
    detail: Option<String>,
}

#[derive(Serialize)]
struct TimelineEvent {
    at_ms: i64,
    at_utc: String,
    attempt: i64,
    stage: String,
    action: Option<String>,
    status: String,
    elapsed_ms: Option<i64>,
    detail: Option<String>,
}

/// The entry point behind `main`'s `inspect` argument. Exit code 1 with a
/// stderr message on query errors or a missing Run; empty-but-valid queries
/// print valid JSON.
pub fn run(args: &[String]) -> anyhow::Result<()> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let command = parse_command(args)?;
    let connection = open_store()?;
    match command {
        Command::Runs {
            since,
            until,
            kind,
            status,
            request_id,
            limit,
        } => {
            let since_ms = since.as_deref().map(parse_time_ms).transpose()?;
            let until_ms = until.as_deref().map(parse_time_ms).transpose()?;
            let clamped = limit.clamp(1, 500);
            let rows = runs(
                &connection,
                since_ms,
                until_ms,
                kind,
                status,
                request_id,
                clamped,
            )?;
            if rows.len() == clamped {
                eprintln!(
                    "Note: output reached --limit {clamped}; results may be truncated. Narrow the window or raise --limit (max 500)."
                );
            }
            print_json(rows);
        }
        Command::Run { run_id } => {
            let Some(detail) = run_detail(&connection, &run_id)? else {
                anyhow::bail!("Run {run_id} not found in {}", store_path().display());
            };
            print_json(detail);
        }
        Command::Ops { since, limit } => {
            let since_ms = since.as_deref().map(parse_time_ms).transpose()?;
            let clamped = limit.clamp(1, 500);
            let events: Vec<OpsEvent> = crate::db::ops_events_sync(&connection, since_ms, clamped)?;
            if events.len() == clamped {
                eprintln!(
                    "Note: output reached --limit {clamped}; ops_event retains at most 200 rows."
                );
            }
            print_json(events);
        }
        Command::Events {
            since,
            until,
            stage,
            status,
            action,
            limit,
        } => {
            let since_ms = since.as_deref().map(parse_time_ms).transpose()?;
            let until_ms = until.as_deref().map(parse_time_ms).transpose()?;
            let clamped = limit.clamp(1, 500);
            let rows = events(
                &connection,
                since_ms,
                until_ms,
                stage,
                status,
                action,
                clamped,
            )?;
            if rows.len() == clamped {
                eprintln!(
                    "Note: output reached --limit {clamped}; narrow the window or raise --limit (max 500)."
                );
            }
            print_json(rows);
        }
        Command::Http {
            since,
            request_id,
            limit,
        } => {
            let since_ms = since.as_deref().map(parse_time_ms).transpose()?;
            let clamped = limit.clamp(1, 500);
            let rows =
                crate::db::http_errors_sync(&connection, since_ms, request_id.as_deref(), clamped)?;
            if rows.len() == clamped {
                eprintln!(
                    "Note: output reached --limit {clamped}; http_error retains at most 200 rows."
                );
            }
            print_json(rows);
        }
        Command::Schedules => print_json(schedules(&connection)?),
        Command::Health => print_json(health(&connection)?),
    }
    Ok(())
}

fn print_json(value: impl Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).expect("serializeable diagnostics")
    );
}

/// The workspace store, resolved exactly like the server resolves it.
fn store_path() -> std::path::PathBuf {
    let workspace = std::env::var("WORKSPACE_DIR").unwrap_or_else(|_| "workspace".to_owned());
    std::path::Path::new(&workspace).join("chief.db")
}

fn open_store() -> anyhow::Result<Connection> {
    let path = store_path();
    if !path.exists() {
        anyhow::bail!(
            "Workspace store not found at {}. Set WORKSPACE_DIR to the installation's workspace volume.",
            path.display()
        );
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| anyhow::anyhow!("Cannot open {}: {error}", path.display()))?;
    // SQLite opens lazily; a corrupt or foreign file only fails at the first
    // read. Touch the header here so a bad store fails with the path named
    // instead of an anonymous error mid-query.
    connection
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| anyhow::anyhow!("Cannot open {}: {error}", path.display()))?;
    Ok(connection)
}

/// RFC 3339 or epoch milliseconds; anything else fails loudly instead of
/// silently querying the wrong window.
fn parse_time_ms(raw: &str) -> anyhow::Result<i64> {
    if let Ok(ms) = raw.parse::<i64>() {
        // Epoch seconds are the likeliest wrong-but-valid unit: read as
        // milliseconds they land in 1970 and silently widen the window.
        anyhow::ensure!(
            ms.unsigned_abs() >= 100_000_000_000,
            "--since/--until take epoch milliseconds or RFC 3339, not epoch seconds; got {ms}"
        );
        return Ok(ms);
    }
    Ok(chrono::DateTime::parse_from_rfc3339(raw)?.timestamp_millis())
}

fn utc(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| format!("{ms} (outside the representable range)"))
}

fn runs(
    connection: &Connection,
    since_ms: Option<i64>,
    until_ms: Option<i64>,
    kind: Option<String>,
    status: Option<String>,
    request_id: Option<String>,
    limit: usize,
) -> anyhow::Result<Vec<RunSummary>> {
    let mut statement = connection.prepare(
        "SELECT id, kind, status, attempt, created_at, updated_at, retry_of, error \
         FROM job WHERE (?1 IS NULL OR created_at >= ?1) \
         AND (?2 IS NULL OR created_at < ?2) \
         AND (?3 IS NULL OR kind = ?3) \
         AND (?4 IS NULL OR status = ?4) \
         AND (?5 IS NULL OR EXISTS(\
             SELECT 1 FROM run_event e WHERE e.run_id = job.id \
             AND e.stage = 'admitted' AND e.action = 'request:' || ?5\
         )) \
         ORDER BY created_at DESC, id LIMIT ?6",
    )?;
    let rows = statement.query_map(
        rusqlite::params![
            since_ms,
            until_ms,
            kind,
            status,
            request_id,
            limit.clamp(1, 500) as i64
        ],
        |row| {
            let created_at_ms: i64 = row.get(4)?;
            let updated_at_ms: i64 = row.get(5)?;
            Ok(RunSummary {
                id: row.get(0)?,
                kind: row.get(1)?,
                status: row.get(2)?,
                attempt: row.get(3)?,
                created_at_ms,
                created_at_utc: utc(created_at_ms),
                updated_at_ms,
                updated_at_utc: utc(updated_at_ms),
                retry_of: row.get(6)?,
                error: row.get(7)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[derive(Serialize)]
struct RunDetail {
    #[serde(flatten)]
    summary: RunSummary,
    retried_by: Vec<String>,
    result: Option<String>,
    attempts: Vec<Attempt>,
    timeline: Vec<TimelineEvent>,
    timeline_truncated: bool,
    usage_per_attempt: Vec<serde_json::Value>,
    /// Workflow checkpoints written beside the Run (meeting-debrief stages,
    /// terminal request phases). These are the durable state a phase failure
    /// leaves behind; they are not Run rows, so the timeline alone misses them.
    traces: Vec<serde_json::Value>,
    traces_truncated: bool,
}
fn run_detail(connection: &Connection, run_id: &str) -> anyhow::Result<Option<RunDetail>> {
    let summary = connection
        .query_row(
            "SELECT id, kind, status, attempt, created_at, updated_at, retry_of, error \
             FROM job WHERE id = ?1",
            [run_id],
            |row| {
                let created_at_ms: i64 = row.get(4)?;
                let updated_at_ms: i64 = row.get(5)?;
                Ok(RunSummary {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    status: row.get(2)?,
                    attempt: row.get(3)?,
                    created_at_ms,
                    created_at_utc: utc(created_at_ms),
                    updated_at_ms,
                    updated_at_utc: utc(updated_at_ms),
                    retry_of: row.get(6)?,
                    error: row.get(7)?,
                })
            },
        )
        .optional()?;
    let Some(summary) = summary else {
        // Reached only when the id genuinely has no row: a query error
        // propagates instead of masquerading as absence.
        return Ok(None);
    };

    let mut attempts = Vec::new();
    let mut statement = connection.prepare(
        "SELECT attempt, started_at, finished_at, outcome, provider, model \
         FROM job_attempt WHERE job_id = ?1 ORDER BY attempt",
    )?;
    let rows = statement.query_map([run_id], |row| {
        let started_at_ms: i64 = row.get(1)?;
        let finished_at_ms: Option<i64> = row.get(2)?;
        Ok(Attempt {
            attempt: row.get(0)?,
            started_at_ms,
            started_at_utc: utc(started_at_ms),
            finished_at_ms,
            finished_at_utc: finished_at_ms.map(utc),
            outcome: row.get(3)?,
            provider: row.get(4)?,
            model: row.get(5)?,
        })
    })?;
    attempts.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

    let mut timeline = Vec::new();
    let mut statement = connection.prepare(
        "SELECT at_ms, attempt, stage, action, status, elapsed_ms, detail \
         FROM run_event WHERE run_id = ?1 ORDER BY id",
    )?;
    let rows = statement.query_map([run_id], |row| {
        let at_ms: i64 = row.get(0)?;
        Ok(TimelineEvent {
            at_ms,
            at_utc: utc(at_ms),
            attempt: row.get(1)?,
            stage: row.get(2)?,
            action: row.get(3)?,
            status: row.get(4)?,
            elapsed_ms: row.get(5)?,
            detail: row.get(6)?,
        })
    })?;
    timeline.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

    // Usage is stored per attempt (`<run>:<attempt>`); a recovered lease
    // writes a new record beside the original attempt.
    let mut usage_per_attempt = Vec::new();
    for attempt in 0..=summary.attempt {
        if let Some(usage) = crate::store::get::<serde_json::Value>(
            connection,
            "run_usage",
            &format!("{run_id}:{attempt}"),
        )? {
            usage_per_attempt.push(serde_json::json!({"attempt": attempt, "usage": usage}));
        }
    }
    // Two independent truncation signals: the stored marker and the
    // recorder's dropped-event counter saved with each attempt's usage.
    let timeline_truncated = timeline
        .iter()
        .any(|event| event.stage == "diagnostics_truncated")
        || usage_per_attempt.iter().any(|entry| {
            entry["usage"]["timeline_dropped_events"]
                .as_u64()
                .unwrap_or_default()
                > 0
        });

    let mut retried_by = Vec::new();
    let mut statement =
        connection.prepare("SELECT id FROM job WHERE retry_of = ?1 ORDER BY created_at, id")?;
    let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
    retried_by.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);

    let (traces, traces_truncated) = crate::work::traces_sync(connection, run_id)?;

    Ok(Some(RunDetail {
        summary,
        retried_by,
        result: connection
            .query_row("SELECT result FROM job WHERE id = ?1", [run_id], |row| {
                row.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten(),
        attempts,
        timeline,
        timeline_truncated,
        usage_per_attempt,
        traces,
        traces_truncated,
    }))
}

#[derive(Serialize)]
struct RetentionCaps {
    ops_events: i64,
    http_errors: i64,
    ticks: i64,
    llm_calls: i64,
    run_events_per_run: i64,
}

/// Timeline rows across Runs. This is the symptom-first search a single Run
/// view cannot answer: "which Runs hit a judgment failure yesterday?"
fn events(
    connection: &Connection,
    since_ms: Option<i64>,
    until_ms: Option<i64>,
    stage: Option<String>,
    status: Option<String>,
    action: Option<String>,
    limit: usize,
) -> anyhow::Result<Vec<EventRow>> {
    let mut statement = connection.prepare(
        "SELECT e.at_ms, e.run_id, j.kind, e.attempt, e.stage, e.action, e.status, \
                e.elapsed_ms, e.detail \
         FROM run_event e JOIN job j ON j.id = e.run_id \
         WHERE (?1 IS NULL OR e.at_ms >= ?1) AND (?2 IS NULL OR e.at_ms < ?2) \
           AND (?3 IS NULL OR e.stage = ?3) AND (?4 IS NULL OR e.status = ?4) \
           AND (?5 IS NULL OR e.action = ?5) \
         ORDER BY e.id DESC LIMIT ?6",
    )?;
    let rows = statement.query_map(
        rusqlite::params![
            since_ms,
            until_ms,
            stage,
            status,
            action,
            limit.clamp(1, 500) as i64
        ],
        |row| {
            let at_ms: i64 = row.get(0)?;
            Ok(EventRow {
                at_ms,
                at_utc: utc(at_ms),
                run_id: row.get(1)?,
                kind: row.get(2)?,
                attempt: row.get(3)?,
                stage: row.get(4)?,
                action: row.get(5)?,
                status: row.get(6)?,
                elapsed_ms: row.get(7)?,
                detail: row.get(8)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Saved schedule state, with the last attempt rendered in UTC. `enabled`
/// with an old `last_enqueued_at` is a stalled scheduler; a recent attempt
/// with a `last_error` is a failing dependency, not a dead worker.
fn schedules(connection: &Connection) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut statement = connection
        .prepare("SELECT id, body, updated_at FROM record WHERE kind = 'schedule' ORDER BY id")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, body, updated_at) = row?;
        let mut value: serde_json::Value = serde_json::from_str(&body)?;
        value["kind"] = serde_json::json!(id);
        value["record_updated_at_utc"] = serde_json::json!(utc(updated_at));
        if let Some(at) = value["last_enqueued_at"].as_i64() {
            value["last_enqueued_at_utc"] = serde_json::json!(utc(at));
        }
        out.push(value);
    }
    Ok(out)
}

#[derive(Serialize)]
struct Health {
    version: &'static str,
    store_path: String,
    store: String,
    running: i64,
    queued: i64,
    failed: i64,
    worker_tick_age_ms: Option<i64>,
    ops_event_count: i64,
    http_failure_count: i64,
    http_failures_24h: i64,
    tick_count: i64,
    retention_caps: RetentionCaps,
    latest_ops_events: Vec<OpsEvent>,
}

fn health(connection: &Connection) -> anyhow::Result<Health> {
    let integrity =
        connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?;
    let worker_tick_age_ms = crate::db::worker_tick_age_sync(connection)?;
    let counts = crate::work::queue_counts(connection)?;
    let ops_event_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM ops_event", [], |row| row.get(0))?;
    let tick_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM tick", [], |row| row.get(0))?;
    let http_failure_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM http_error", [], |row| row.get(0))?;
    let http_failures_24h: i64 = connection.query_row(
        "SELECT COUNT(*) FROM http_error WHERE at_ms >= ?1",
        [crate::now_ms() - 86_400_000],
        |row| row.get(0),
    )?;
    Ok(Health {
        version: env!("CARGO_PKG_VERSION"),
        store_path: store_path().display().to_string(),
        store: integrity,
        running: counts.running,
        queued: counts.queued,
        failed: counts.failed,
        worker_tick_age_ms,
        ops_event_count,
        http_failure_count,
        http_failures_24h,
        tick_count,
        retention_caps: RetentionCaps {
            ops_events: 200,
            http_errors: 200,
            ticks: 500,
            llm_calls: 50,
            run_events_per_run: crate::work::RUN_EVENT_CAP,
        },
        latest_ops_events: crate::db::ops_events_sync(connection, None, 10)?,
    })
}
