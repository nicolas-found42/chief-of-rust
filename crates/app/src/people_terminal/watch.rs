use super::{
    active,
    corpus::{Scope, context, snapshots},
    enabled, key,
    views::{Screen, all_context, screen_people, selector, workspace},
};
use crate::{
    App,
    people::Person,
    store,
    terminal::automatic::{intake, person_identity},
    web::{self, Error, Result, escape, required},
};
use axum::{
    extract::{Form, Path, Query, State},
    response::{Redirect, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt::Write};

const WATCH: &str = "people_terminal_watch";
const DAY: i64 = 86_400_000;
const LIMIT: usize = 12;
#[derive(Serialize, Deserialize)]
struct Watchlist {
    id: String,
    name: String,
    person_ids: Vec<String>,
    query: Option<Screen>,
    cadence: i64,
    paused: bool,
    next: i64,
    revision: u64,
    previous_members: Vec<String>,
    reviewed: BTreeMap<String, String>,
    #[serde(default)]
    reviewed_at: Option<i64>,
    attempts: BTreeMap<String, String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct Prefill {
    person: String,
}

pub(crate) async fn index(
    State(app): State<App>,
    Query(query): Query<Prefill>,
) -> Result<Response> {
    enabled(&app)?;
    let lists = app.db().list::<Watchlist>(WATCH).await?;
    let people = app.db().list::<Person>("person").await?;
    let mut out = "<section class=\"cds-section\"><h2>Saved watchlists</h2><ul>".to_owned();
    for list in lists {
        let _ = write!(
            out,
            "<li><a href=\"/terminal/people/watchlists/{}\">{}</a> · {}</li>",
            escape(&list.id),
            escape(&list.name),
            if list.paused { "Paused" } else { "Monitoring" }
        );
    }
    let _ = write!(
        out,
        "</ul><h2>Save a static list</h2><form method=\"post\" class=\"cds-form\">{}<input type=\"hidden\" name=\"kind\" value=\"static\">{}{}{}<button class=\"cds-btn cds-btn--primary\">Save watchlist</button></form><p><a href=\"/terminal/people/research\">Save a structured query from research search</a></p></section>",
        web::field("Name", "name", "", "text", Some(100), true),
        selector(&people, "First person", "person", &query.person),
        selector(&people, "Second person (optional)", "second", ""),
        selector(&people, "Third person (optional)", "third", "")
    );
    Ok(workspace("Watchlists", out))
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct Save {
    name: String,
    kind: String,
    person: String,
    second: String,
    third: String,
    query: String,
}
pub(crate) async fn save(State(app): State<App>, Form(form): Form<Save>) -> Result<Redirect> {
    enabled(&app)?;
    let name = required(&form.name, "Watchlist name", 100)?;
    let (person_ids, query) = match form.kind.as_str() {
        "query" => {
            let mut screen: Screen = serde_json::from_str(&form.query)
                .map_err(|_| Error::bad_request("Invalid saved query."))?;
            screen.scope.page = 0;
            screen.scope.snapshot.clear();
            (Vec::new(), Some(screen.validate()?))
        }
        "static" => {
            let mut ids = vec![form.person, form.second, form.third];
            ids.retain(|id| !id.is_empty());
            ids.sort();
            ids.dedup();
            if ids.is_empty() {
                return Err(Error::bad_request("Select at least one active person."));
            }
            (ids, None)
        }
        _ => {
            return Err(Error::bad_request(
                "Choose static list or structured query.",
            ));
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    let list = Watchlist {
        id: id.clone(),
        name,
        person_ids,
        query,
        cadence: 7,
        paused: true,
        next: 0,
        revision: 1,
        previous_members: Vec::new(),
        reviewed: BTreeMap::new(),
        reviewed_at: None,
        attempts: BTreeMap::new(),
    };
    app.db()
        .transaction(move |tx| {
            for id in &list.person_ids {
                anyhow::ensure!(
                    store::get::<Person>(tx, "person", id)?
                        .filter(active)
                        .is_some(),
                    "Person unavailable"
                );
            }
            store::put(tx, WATCH, &list.id, &list)
        })
        .await?;
    Ok(Redirect::to(&format!("/terminal/people/watchlists/{id}")))
}

fn members(tx: &Connection, list: &Watchlist) -> anyhow::Result<Vec<String>> {
    if let Some(filter) = &list.query {
        return Ok(screen_people(tx, filter, LIMIT)?
            .into_iter()
            .take(LIMIT)
            .map(|(c, _)| c.person_id)
            .collect());
    }
    Ok(list.person_ids.clone())
}

#[derive(Deserialize)]
pub(crate) struct Update {
    action: String,
    version: u64,
    #[serde(default)]
    cadence: i64,
}
pub(crate) async fn update(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<Update>,
) -> Result<Redirect> {
    enabled(&app)?;
    let saved_id = id.clone();
    app.db()
        .transaction(move |tx| {
            let mut list: Watchlist = store::get(tx, WATCH, &id)?
                .ok_or_else(|| anyhow::anyhow!("Watchlist no longer available"))?;
            anyhow::ensure!(
                list.revision == form.version,
                "Watchlist changed; reload it"
            );
            match form.action.as_str() {
                "pause" => list.paused = true,
                "resume" => {
                    anyhow::ensure!(
                        [1, 7, 30].contains(&form.cadence),
                        "Select daily, weekly or monthly checks"
                    );
                    list.paused = false;
                    list.next = crate::now_ms();
                    list.cadence = form.cadence;
                }
                "review" => {
                    let people = members(tx, &list)?;
                    let mut reviewed = BTreeMap::new();
                    for id in &people {
                        if let Some(snapshot) =
                            context(tx, id, &Scope::default())?.and_then(|c| c.snapshot)
                        {
                            reviewed.insert(id.clone(), snapshot);
                        }
                    }
                    list.reviewed = reviewed;
                    list.reviewed_at = Some(crate::now_ms());
                    list.previous_members = people;
                }
                _ => anyhow::bail!("Unknown watchlist action"),
            }
            list.revision += 1;
            store::put(tx, WATCH, &id, &list)
        })
        .await
        .map_err(|e| Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!(
        "/terminal/people/watchlists/{saved_id}"
    )))
}

pub(super) fn latest_run(tx: &Connection, id: &str) -> anyhow::Result<Option<(String, String)>> {
    Ok(tx
        .query_row(
            "SELECT j.status,j.id FROM record r JOIN job j ON j.id=json_extract(r.body,'$.run_id')
         WHERE r.kind='terminal_request' AND json_extract(r.body,'$.identity.kind')='person'
         AND json_extract(r.body,'$.target_id')=?1 ORDER BY r.updated_at DESC,r.id LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

pub(crate) async fn schedule(app: &App) -> anyhow::Result<()> {
    // The worker stamps `schedule:people.terminal_watch`; propagating it makes
    // these admissions name their trigger like every other scheduled Run.
    let origin = crate::correlation::origin();
    // Scheduling is one short transaction. Competing lists for the same
    // identity share the active Run rather than spending twice.
    app.db()
        .transaction(move |tx| {
            let now = crate::now_ms();
            let mut stmt = tx.prepare(
                "SELECT body FROM record WHERE kind=?1 AND json_extract(body,'$.paused')=0
            AND json_extract(body,'$.next')<=?2 ORDER BY json_extract(body,'$.next'),id LIMIT 4",
            )?;
            let due = stmt
                .query_map(params![WATCH, now], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for raw in due {
                let mut list: Watchlist = serde_json::from_str(&raw)?;
                let mut attempts = BTreeMap::new();
                for id in members(tx, &list)? {
                    let Some(p) = store::get::<Person>(tx, "person", &id)?.filter(active) else {
                        continue;
                    };
                    if let Some((status, run_id)) = latest_run(tx, &id)?
                        && matches!(status.as_str(), "queued" | "running")
                    {
                        attempts.insert(id, run_id);
                        continue;
                    }
                    let identity = person_identity(&p);
                    let request = intake::admit(
                        tx,
                        identity,
                        Some(id.clone()),
                        Some(p.version),
                        None,
                        origin.as_deref(),
                    )?;
                    attempts.insert(id, request.run_id);
                }
                list.attempts = attempts;
                list.next = now.saturating_add(list.cadence.saturating_mul(DAY));
                list.revision += 1;
                store::put(tx, WATCH, &list.id, &list)?;
            }
            Ok(())
        })
        .await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Diff {
    before: String,
    after: String,
}
pub(crate) async fn detail(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(diff): Query<Diff>,
) -> Result<Response> {
    enabled(&app)?;
    let loaded = app
        .db()
        .transaction(move |tx| {
            let Some(list) = store::get::<Watchlist>(tx, WATCH, &id)? else {
                return Ok(None);
            };
            let members = members(tx, &list)?;
            let mut data = Vec::new();
            for id in &members {
                let current_scope = Scope {
                    snapshot: diff.after.clone(),
                    ..Scope::default()
                };
                let Some(current) = all_context(tx, id, &current_scope)? else {
                    continue;
                };
                let history = snapshots(tx, id)?;
                let older = if !diff.before.is_empty() {
                    Some(diff.before.clone())
                } else {
                    list.reviewed
                        .get(id)
                        .cloned()
                        .or_else(|| history.get(1).map(|(id, _)| id.clone()))
                };
                let previous = if let Some(snapshot) = older {
                    all_context(
                        tx,
                        id,
                        &Scope {
                            review_cutoff: list.reviewed_at.or_else(|| {
                                history
                                    .iter()
                                    .find(|(id, _)| id == &snapshot)
                                    .map(|(_, at)| *at)
                            }),
                            snapshot,
                            ..Scope::default()
                        },
                    )?
                } else {
                    None
                };
                let run = latest_run(tx, id)?;
                data.push((current, previous, run));
            }
            Ok(Some((list, members, data)))
        })
        .await?;
    let (list, members, data) = loaded.ok_or_else(|| Error::not_found("Watchlist not found."))?;
    let mut out = format!(
        "<p>{} · up to {LIMIT} people per scheduled check · next {}</p>",
        if list.paused {
            "Paused"
        } else {
            "Monitoring enabled"
        },
        if list.paused {
            "check paused".into()
        } else {
            chrono::DateTime::from_timestamp_millis(list.next)
                .map(|d| d.to_rfc3339())
                .unwrap_or_else(|| "when due".into())
        }
    );
    if let Some(query) = &list.query {
        let _ = write!(
            out,
            "<p><a href=\"/terminal/people/research?{}\">Open saved criteria</a></p>",
            escape(&super::views::screen_query(query))
        );
    }
    let added = members
        .iter()
        .filter(|id| !list.previous_members.contains(id))
        .count();
    let removed = list
        .previous_members
        .iter()
        .filter(|id| !members.contains(id))
        .count();
    let _ = write!(
        out,
        "<p>Membership since last review: {added} added · {removed} removed.</p><form class=\"cds-form\" method=\"post\">{}<label>Cadence <select name=\"cadence\"><option value=\"1\">Daily</option><option value=\"7\"{}>Weekly</option><option value=\"30\">Every 30 days</option></select></label><button class=\"cds-btn\" name=\"action\" value=\"{}\">{}</button><button class=\"cds-btn\" name=\"action\" value=\"review\">Mark current research reviewed</button></form><h2>Changes</h2>",
        web::revision_input(list.revision),
        if list.cadence == 7 { " selected" } else { "" },
        if list.paused { "resume" } else { "pause" },
        if list.paused {
            "Resume monitoring"
        } else {
            "Pause monitoring"
        }
    );
    for (current, previous, run) in data {
        let _ = write!(
            out,
            "<section class=\"cds-section\"><h3><a href=\"/terminal/people/{}\">{}</a></h3>",
            escape(&current.person_id),
            escape(&current.name)
        );
        if let Some(recorded) = current
            .recorded
            .and_then(chrono::DateTime::from_timestamp_millis)
        {
            let _ = write!(
                out,
                "<p>Last successful research: {}</p>",
                recorded.to_rfc3339()
            );
        }
        if let Some((state, run_id)) = run {
            let _ = write!(
                out,
                "<p>Collection status: {} · <a href=\"/runs/{}\">Run details</a>{}</p>",
                escape(&state),
                escape(&run_id),
                if state == "failed" {
                    " · Retry from the person’s Coverage view or at the next check."
                } else {
                    ""
                }
            );
        }
        let old = previous
            .as_ref()
            .map(|p| p.claims.as_slice())
            .unwrap_or_default();
        let mut count = 0;
        for claim in &current.claims {
            let before = old.iter().find(|f| f.id == claim.id);
            let event = match before {
                None if claim.positive() && claim.predicate == "departure" => {
                    "Documented departure"
                }
                None if claim.positive() => "New documented finding",
                None => "New unresolved evidence",
                Some(f) if f.review != claim.review => "Review change",
                Some(f) if f.state() != claim.state() => "Evidence disagreement changed",
                Some(f)
                    if origin_text(&f.supports) != origin_text(&claim.supports)
                        || origin_text(&f.contradicts) != origin_text(&claim.contradicts) =>
                {
                    "New evidence version"
                }
                Some(_) => continue,
            };
            let event_id = key(&(
                &current.person_id,
                &claim.id,
                event,
                claim.state(),
                claim.review.label(),
                claim
                    .supports
                    .iter()
                    .map(|p| (&p.origin_family, &p.text))
                    .collect::<Vec<_>>(),
            ))?;
            let _ = write!(
                out,
                "<article class=\"cds-card\" id=\"{}\"><p>{event}: <a href=\"/terminal/people/{}?view=evidence&amp;snapshot={}&amp;claim={}#inspector\">{}</a></p>{}</article>",
                escape(&event_id),
                escape(&current.person_id),
                escape(current.snapshot.as_deref().unwrap_or_default()),
                escape(&claim.id),
                escape(&claim.statement),
                before.map_or_else(String::new, |f| format!(
                    "<p>Previously: {} · {}</p>",
                    escape(f.state()),
                    escape(f.review.label())
                ))
            );
            count += 1;
        }
        if count == 0 {
            out.push_str("<p>No new supported findings or evidence in this comparison.</p>")
        }
        out.push_str("</section>");
    }
    Ok(workspace(&list.name, out))
}

pub(super) fn job_status(
    tx: &Connection,
    id: &str,
) -> anyhow::Result<Option<(String, Option<String>)>> {
    Ok(tx
        .query_row("SELECT status,error FROM job WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?)
}

fn origin_text(passages: &[super::corpus::Passage]) -> std::collections::BTreeSet<(&str, &str)> {
    passages
        .iter()
        .map(|p| (p.origin_family.as_str(), p.text.as_str()))
        .collect()
}
