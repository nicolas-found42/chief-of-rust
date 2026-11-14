use super::queue::{
    COLUMNS, Job, append_event_tx, flush_events_tx, from_row, record_event, record_event_tx,
};
use crate::App;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

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
        let recovered = tx.execute("UPDATE job SET status='queued',lease_until=NULL WHERE status='running' AND lease_until<=?1",[now])?;
        if recovered > 0 {
            tx.execute(
                "INSERT INTO ops_event (at_ms, source, event, detail) VALUES (?1, 'worker', 'lease_recovered', ?2)",
                params![now, format!("recovered={recovered}")],
            )?;
        }
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
        // The optional build id names the image that produced later Runs:
        // without it two identical stores cannot say which deployment ran
        // yesterday.
        let build = std::env::var("CHIEF_BUILD_ID")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unset".to_owned());
        let boot_detail = format!(
            "version={} build={} provider={} model={} people_terminal={}",
            env!("CARGO_PKG_VERSION"),
            build,
            app.llm().name(),
            app.cfg().llm_model(),
            app.cfg().people_terminal
        );
        let _ = app
            .db()
            .record_ops_event("worker", "started", Some(&boot_detail))
            .await;
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
    let people_schedule = app.cfg().people_terminal;
    if people_schedule {
        // Scheduled watch admissions name their trigger in the Run timeline.
        let scheduled = crate::correlation::scope_origin(
            "schedule:people.terminal_watch".to_owned(),
            crate::people_terminal::schedule(app),
        )
        .await;
        if let Err(error) = scheduled {
            let _ = app
                .db()
                .record_ops_event(
                    "schedule",
                    "people_terminal_admission_failed",
                    Some(&crate::llm::redact_error(&format!("{error:#}"), app.cfg())),
                )
                .await;
            tracing::error!(%error, "people_terminal schedule admission failed");
        }
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
