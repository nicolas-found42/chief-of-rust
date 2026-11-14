use super::{active, corpus::*, enabled, key};
use crate::{
    App,
    people::Person,
    research::CoverageState,
    store,
    terminal::automatic::Dossier,
    web::{self, Error, Result, escape},
    work,
};
use axum::{
    extract::{Form, Path, Query, State},
    response::{IntoResponse, Redirect, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fmt::Write};

const TABS: [(&str, &str); 7] = [
    ("overview", "Overview"),
    ("timeline", "Timeline"),
    ("connections", "Connections"),
    ("evidence", "Evidence"),
    ("coverage", "Coverage"),
    ("history", "History"),
    ("all", "All research"),
];

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct ProfileQuery {
    view: String,
    claim: String,
    pin: String,
    #[serde(flatten)]
    scope: Scope,
}

fn root(id: &str) -> String {
    format!("/terminal/people/{}", escape(id))
}
fn view_url(id: &str, tab: &str, scope: &Scope) -> String {
    format!(
        "{}?view={}&amp;{}",
        root(id),
        escape(tab),
        escape(&scope.query())
    )
}
fn claim_url(id: &str, tab: &str, scope: &Scope, claim: &str) -> String {
    format!(
        "{}&amp;claim={}#inspector",
        view_url(id, tab, scope),
        escape(claim)
    )
}
fn timestamp(value: i64) -> String {
    chrono::DateTime::from_timestamp_millis(value)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "Unknown".into())
}
pub(super) fn date_scope(scope: &Scope) -> String {
    let modes = [
        ("latest", "Latest research", TimeMode::Latest),
        ("effective", "Effective on", TimeMode::Effective),
        ("known", "Known to this system by", TimeMode::Known),
        ("published", "Published by", TimeMode::Published),
    ];
    let mut out = "<label>Time interpretation <select name=\"mode\">".to_owned();
    for (id, label, mode) in modes {
        let selected = if mode == scope.mode { " selected" } else { "" };
        let _ = write!(out, "<option value=\"{id}\"{selected}>{label}</option>");
    }
    let _ = write!(
        out,
        "</select></label><label>On or by <input type=\"date\" name=\"date\" value=\"{}\"></label>",
        escape(&scope.date)
    );
    out
}
fn hidden(name: &str, value: &str) -> String {
    format!(
        "<input type=\"hidden\" name=\"{name}\" value=\"{}\">",
        escape(value)
    )
}
fn nav() -> &'static str {
    "<nav aria-label=\"People workspace\"><a href=\"/terminal\">Workspace overview</a> · <a href=\"/terminal/people\">People</a> · <a href=\"/terminal/companies\">Companies</a> · <a href=\"/terminal/people/research\">Search the research</a> · <a href=\"/terminal/people/watchlists\">Watchlists</a> · <a href=\"/terminal/people/compare\">Compare</a> · <a href=\"/terminal/people/outputs\">Briefs and Reports</a></nav>"
}
pub(super) fn workspace(title: &str, contents: String) -> Response {
    web::page(
        title,
        web::Body::with_heading(format!("<h1>{}</h1>{}{contents}", escape(title), nav())),
    )
}

pub(crate) async fn profile(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<ProfileQuery>,
) -> Result<Response> {
    if !super::requires_safe_view(&app, &id).await? {
        return crate::terminal::automatic::person_detail(State(app), Path(id)).await;
    }
    let scope = query.scope.validate()?;
    let tab = TABS
        .iter()
        .find(|(tab, _)| *tab == query.view)
        .map_or("overview", |(tab, _)| *tab);
    let claim_id = query.claim.clone();
    let (person, ctx, dossier, history, identity_history, reviews, inspected, recent, person_list) =
        app.db()
            .transaction({
                let id = id.clone();
                let scope = scope.clone();
                move |tx| {
                    let person: Option<Person> = store::get(tx, "person", &id)?;
                    let ctx = context(tx, &id, &scope)?;
                    let dossier: Option<Dossier> = if matches!(tab, "coverage" | "all" | "evidence")
                    {
                        super::corpus::dossier(tx, &id, &scope)?
                    } else {
                        None
                    };
                    let history = if tab == "history" {
                        snapshots(tx, &id)?
                    } else {
                        Vec::new()
                    };
                    let identity_history = if tab == "history" {
                        super::identity::history(tx, &id)?
                    } else {
                        Vec::new()
                    };
                    let reviews = if !claim_id.is_empty() {
                        reviews(tx, &id, Some(&claim_id))?
                    } else {
                        Vec::new()
                    };
                    let inspected = if tab == "evidence" {
                        snapshot_passages(tx, &id, &scope)?
                    } else {
                        Vec::new()
                    };
                    let recent = super::watch::latest_run(tx, &id)?;
                    let mut list = tx.prepare(
                        "SELECT id,json_extract(body,'$.name') FROM record WHERE kind='person'
                AND json_extract(body,'$.archived')=0 AND json_extract(body,'$.merged_into') IS NULL
                ORDER BY updated_at DESC,id LIMIT 12",
                    )?;
                    let person_list = list
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok((
                        person,
                        ctx,
                        dossier,
                        history,
                        identity_history,
                        reviews,
                        inspected,
                        recent,
                        person_list,
                    ))
                }
            })
            .await?;
    let person = person.ok_or_else(|| Error::not_found("Person not found."))?;
    if !active(&person) {
        let text = if let Some(target) = person.merged_into {
            format!(
                "<p>Merged profile. <a href=\"{}\">Open canonical person</a>.</p>",
                root(&target)
            )
        } else {
            "<p>Archived Person. Restore from Profile management before researching.</p><a href=\"/terminal#profile-management\">Profile management</a>".into()
        };
        return Ok(workspace(&person.name, text));
    }
    let ctx = ctx.ok_or_else(|| Error::not_found("Snapshot not found."))?;
    let mut selected_scope = scope.clone();
    if let Some(snapshot) = &ctx.snapshot {
        selected_scope.snapshot = snapshot.clone();
    }
    let mut out = format!(
        "<p>{}</p><p>Last documented affiliation: {}</p><p>{}</p><p><a href=\"/terminal?update=person:{}#update\">Profile details</a></p>        <form class=\"cds-inline-form\" method=\"post\" action=\"/terminal/profiles/person/{}/refresh\"><button class=\"cds-btn cds-btn--primary\">Refresh dossier</button></form>",
        if person.profile_url.is_empty()
            || scope.mode != TimeMode::Latest
            || !scope.snapshot.is_empty()
        {
            "Professional identity".into()
        } else {
            escape(&person.profile_url)
        },
        escape(
            ctx.claims
                .iter()
                .find(|fact| fact.predicate == "affiliation" && fact.positive())
                .map_or("Unknown", |fact| fact.value.as_str())
        ),
        ctx.recorded.map_or_else(
            || "No versioned refresh yet".into(),
            |date| format!("Snapshot recorded {}", timestamp(date))
        ),
        escape(&id),
        escape(&id),
    );
    if let Some((state, run)) = recent {
        let _ = write!(
            out,
            "<p>{} · <a href=\"/runs/{}\">Research run</a></p>",
            match state.as_str() {
                "queued" | "running" => "Research running; previous evidence remains available",
                "failed" => "The last research run failed",
                _ => "Last research run completed",
            },
            escape(&run)
        );
    }
    let _ = write!(
        out,
        "<p><a href=\"/terminal/people/outputs?person={}\">Create person Brief or ask a research question</a> · <a href=\"/terminal/people/watchlists?person={}\">Watch</a></p>",
        escape(&id),
        escape(&id)
    );
    out.push_str("<div class=\"cds-people-workspace\"><aside aria-label=\"Person navigation\"><nav aria-label=\"Dossier views\"><ul>");
    for (slug, label) in TABS {
        let selected = if slug == tab {
            " aria-current=\"page\""
        } else {
            ""
        };
        let _ = write!(
            out,
            "<li><a href=\"{}\"{selected}>{label}</a></li>",
            view_url(&id, slug, &selected_scope)
        );
    }
    out.push_str("</ul></nav><nav aria-label=\"Recent people\"><ul>");
    for (pid, name) in person_list {
        let selected = if pid == id {
            " aria-current=\"true\""
        } else {
            ""
        };
        let _ = write!(
            out,
            "<li><a href=\"{}?view={}&amp;{}\"{selected}>{}</a></li>",
            root(&pid),
            escape(tab),
            escape(
                &Scope {
                    snapshot: String::new(),
                    page: 0,
                    ..scope.clone()
                }
                .query()
            ),
            escape(&name)
        );
    }
    out.push_str(
        "</ul></nav></aside><section class=\"cds-section\" aria-label=\"Selected research view\">",
    );
    let _ = write!(
        out,
        "<details><summary>Time scope: {} {}</summary><form class=\"cds-form cds-form--grid\" method=\"get\" action=\"{}\">{}{}<button class=\"cds-btn cds-full-width\">Apply time scope</button></form></details>",
        time_label(scope.mode),
        escape(&scope.date),
        root(&id),
        hidden("view", tab),
        date_scope(&scope)
    );
    for note in &ctx.limitations {
        let _ = write!(out, "<p>{}</p>", escape(note));
    }
    let facts = ctx
        .claims
        .iter()
        .filter(|f| f.review != ReviewState::Rejected);
    match tab {
        "overview" => {
            out.push_str("<h2>Overview</h2>");
            if ctx.snapshot.is_none() {
                out.push_str(
                    "<p>No dossier yet in this scope. Start or refresh independent research.</p>",
                );
            }
            out.push_str("<h3>Documented work and affiliations</h3>");
            render_facts(
                &mut out,
                facts.clone().filter(|f| f.positive()).take(5),
                &id,
                tab,
                &selected_scope,
            );
            out.push_str("<h3>Open questions and disagreements</h3>");
            render_facts(
                &mut out,
                facts.filter(|f| !f.positive()).take(4),
                &id,
                tab,
                &selected_scope,
            );
            out.push_str(
                "<p><a href=\"/terminal/people/watchlists\">Review changes and monitoring</a></p>",
            );
            let _ = write!(
                out,
                "<p><a href=\"{}/export?format=json&amp;{}\">Export JSON</a> · <a href=\"{}/export?format=csv&amp;{}\">Export CSV</a></p>",
                root(&id),
                escape(&selected_scope.query()),
                root(&id),
                escape(&selected_scope.query())
            );
        }
        "timeline" => {
            out.push_str("<h2>Timeline</h2><p>Effective dates retain the source’s precision. Observation dates appear on the evidence.</p>");
            let mut dated = facts
                .clone()
                .filter(|f| f.effective.start.is_some() || f.effective.end.is_some())
                .collect::<Vec<_>>();
            dated.sort_by(|a, b| {
                a.effective
                    .start
                    .cmp(&b.effective.start)
                    .then_with(|| a.id.cmp(&b.id))
            });
            render_facts(&mut out, dated.into_iter(), &id, tab, &selected_scope);
            out.push_str("<h3>Undated</h3>");
            render_facts(
                &mut out,
                facts.filter(|f| f.effective.start.is_none() && f.effective.end.is_none()),
                &id,
                tab,
                &selected_scope,
            );
        }
        "connections" => {
            out.push_str(
                "<h2>Connections</h2><p>Explicitly documented professional relationships.</p>",
            );
            render_facts(
                &mut out,
                facts.filter(|f| {
                    ["affiliation", "founding", "relationship"].contains(&f.predicate.as_str())
                }),
                &id,
                tab,
                &selected_scope,
            );
        }
        "evidence" => {
            out.push_str("<h2>Evidence</h2>");
            let _ = write!(
                out,
                "<form class=\"cds-form\" method=\"post\" action=\"{}/collection\">{}{}{}<button class=\"cds-btn\">Inspect public original</button></form>",
                root(&id),
                web::revision_input(person.version),
                hidden("action", "inspect"),
                web::field(
                    "Independently published original URL",
                    "target",
                    "",
                    "url",
                    Some(4000),
                    true
                )
            );
            render_facts(&mut out, ctx.claims.iter(), &id, tab, &selected_scope);
            for source in inspected {
                passage_original(&mut out, &source);
            }
            if let Some(dossier) = &dossier {
                discovery(&mut out, dossier, &person);
            }
        }
        "coverage" => {
            out.push_str("<h2>Research coverage</h2><p>Unknown means the retained research does not settle the question.</p><ul>");
            for predicate in [
                "affiliation",
                "role",
                "work",
                "topic",
                "event",
                "relationship",
            ] {
                let present = ctx
                    .claims
                    .iter()
                    .any(|f| f.predicate == predicate && f.positive());
                let _ = write!(
                    out,
                    "<li>{}: {}</li>",
                    predicate,
                    if present {
                        "Inspected support"
                    } else {
                        "Unknown in this view"
                    }
                );
            }
            out.push_str("</ul><h2>Collection health</h2>");
            if let Some(dossier) = &dossier {
                coverage(&mut out, dossier, &person);
            }
        }
        "history" => {
            out.push_str("<h2>Research history</h2><ol>");
            for (snapshot, recorded) in history {
                let url = view_url(
                    &id,
                    "overview",
                    &Scope {
                        snapshot: snapshot.clone(),
                        ..Scope::default()
                    },
                );
                let _ = write!(
                    out,
                    "<li><a href=\"{url}\">{}</a></li>",
                    timestamp(recorded)
                );
            }
            out.push_str("</ol><h2>Identity review</h2><ul>");
            for (other, state, reason) in identity_history {
                let _ = write!(
                    out,
                    "<li><a href=\"{}\">Identity {}</a> · {} · {}</li>",
                    root(&other),
                    escape(&other),
                    escape(&state),
                    escape(&reason)
                );
            }
            let _ = write!(
                out,
                "</ul><form class=\"cds-form\" method=\"post\" action=\"{}/identity\">{}{}<label>Reason <select name=\"reason\"><option value=\"profile\">Reviewed shared official profile URL</option><option value=\"distinct\">Reviewed distinct identities</option><option value=\"unclear\">Needs further investigation</option></select></label><button class=\"cds-btn\" name=\"action\" value=\"merge\">Merge reviewed identities</button><button class=\"cds-btn\" name=\"action\" value=\"split\">Split prior merge</button><button class=\"cds-btn\" name=\"action\" value=\"reject\">Mark distinct</button><button class=\"cds-btn\" name=\"action\" value=\"reopen\">Reopen decision</button></form>",
                root(&id),
                web::revision_input(person.version),
                web::field("Other profile ID", "duplicate", "", "text", Some(100), true)
            );
        }
        _ => {
            out.push_str("<h2>All research</h2>");
            render_facts(&mut out, ctx.claims.iter(), &id, tab, &selected_scope);
            if let Some(dossier) = dossier {
                // A pre-beta generated narrative has no enforceable manifest.
                // Its bytes remain archived for reconciliation, outside the UI.
                if ctx.snapshot.as_ref() == Some(&dossier.id) {
                    let _ = write!(out, "<details><summary>Run limitations</summary><ul>");
                    for limit in &dossier.limitations {
                        let _ = write!(out, "<li>{}</li>", escape(limit));
                    }
                    out.push_str("</ul></details>");
                } else {
                    out.push_str("<p>Legacy dossier retained for reconciliation. Claims without inspected anchors have not been promoted.</p>");
                }
            }
        }
    }
    if ctx.next_page {
        let next = Scope {
            page: scope.page + 1,
            ..selected_scope.clone()
        };
        let _ = write!(
            out,
            "<p><a href=\"{}\">Next page</a></p>",
            view_url(&id, tab, &next)
        );
    }
    out.push_str("</section>");
    if let Some(fact) = ctx.claims.iter().find(|f| f.id == query.claim) {
        inspector(&mut out, &ctx, fact, &reviews, &selected_scope, tab);
    } else if !query.pin.is_empty() {
        out.push_str("<aside id=\"inspector\" aria-label=\"Pinned evidence\"><p>The pinned evidence is no longer in this scope.</p></aside>");
    }
    out.push_str("</div>");
    Ok(workspace(&ctx.name, out))
}

fn render_facts<'a>(
    out: &mut String,
    facts: impl Iterator<Item = &'a Fact>,
    id: &str,
    tab: &str,
    scope: &Scope,
) {
    let mut count = 0;
    for fact in facts {
        count += 1;
        let date = match (&fact.effective.start, &fact.effective.end) {
            (Some(start), Some(end)) => format!(" · {} to {}", escape(start), escape(end)),
            (Some(start), None) => format!(" · {} · end unknown", escape(start)),
            (None, Some(end)) => format!(" · start unknown · ends {}", escape(end)),
            _ => String::new(),
        };
        let _ = write!(
            out,
            "<article class=\"cds-card\"><p><a href=\"{}\">{}</a></p><p>{} · {}{date}</p></article>",
            claim_url(id, tab, scope, &fact.id),
            escape(&fact.statement),
            fact.state(),
            fact.review.label()
        );
    }
    if count == 0 {
        out.push_str("<p class=\"cds-empty\">Unknown · No matching evidence in this scope.</p>");
    }
}

fn inspector(
    out: &mut String,
    ctx: &Context,
    fact: &Fact,
    reviews: &[Review],
    scope: &Scope,
    tab: &str,
) {
    let _ = write!(
        out,
        "<aside id=\"inspector\" class=\"cds-section\" aria-label=\"Evidence inspector\"><h2>Evidence inspector</h2><p>{} · {}</p><p>{}</p><p>{} · {}</p><p><a href=\"{}\">Return to {tab}</a></p>",
        escape(&ctx.name),
        escape(ctx.snapshot.as_deref().unwrap_or("No snapshot")),
        escape(&fact.statement),
        fact.state(),
        fact.review.label(),
        view_url(&ctx.person_id, tab, scope)
    );
    for (label, passages) in [
        ("Supporting passages", &fact.supports),
        ("Contrary passages", &fact.contradicts),
    ] {
        let _ = write!(out, "<h3>{label}</h3>");
        for p in passages {
            passage_original(out, p);
            let _ = write!(
                out,
                "<form class=\"cds-inline-form\" method=\"post\" action=\"{}/review\">{}{}{}{}{}{}<button class=\"cds-btn\" name=\"decision\" value=\"reject\">Reject evidence link</button><button class=\"cds-btn\" name=\"decision\" value=\"accept\">Accept evidence link</button></form>",
                root(&ctx.person_id),
                web::revision_input(ctx.revision),
                hidden("snapshot", ctx.snapshot.as_deref().unwrap_or_default()),
                hidden("claim", &fact.id),
                hidden("view", tab),
                hidden("passage", &p.id),
                hidden("reason", "checked")
            );

            let _ = write!(
                out,
                "<form method=\"post\" class=\"cds-inline-form\" action=\"{}/revoke\">{}{}<button class=\"cds-btn\">Revoke source from research</button></form>",
                root(&ctx.person_id),
                web::revision_input(ctx.revision),
                hidden("source", &p.version)
            );
        }
    }
    let _ = write!(out, "<h3>Review history</h3><ul>");
    for review in reviews {
        let _ = write!(
            out,
            "<li>{} · {} · {}: {}</li>",
            timestamp(review.at),
            escape(&review.actor),
            review.state.label(),
            escape(&review.reason)
        );
    }
    let _ = write!(
        out,
        "</ul><form class=\"cds-form\" action=\"{}/review\" method=\"post\">{}{}{}{}<label>Decision <select name=\"decision\"><option value=\"accept\">Accept</option><option value=\"reject\">Reject</option><option value=\"reopen\">Reopen</option></select></label><label>Reason <select name=\"reason\"><option value=\"checked\">Checked exact attribution and passage</option><option value=\"identity\">Identity needs investigation</option><option value=\"conflict\">Contrary or insufficient evidence</option><option value=\"date\">Date needs investigation</option></select></label><button class=\"cds-btn\">Save review</button></form></aside>",
        root(&ctx.person_id),
        hidden("snapshot", ctx.snapshot.as_deref().unwrap_or_default()),
        hidden("claim", &fact.id),
        hidden("view", tab),
        web::revision_input(ctx.revision)
    );
}

fn passage_original(out: &mut String, p: &Passage) {
    let _ = write!(
        out,
        "<article class=\"cds-card\"><p><a href=\"{}\" rel=\"noreferrer\">{}</a> · {}</p>{}<p>Observed {} · Published {} · {}</p><p>{}</p><details><summary>Source version and anchor</summary><p>{} · {} · {}</p></details></article>",
        escape(&p.url),
        escape(&p.title),
        escape(&p.asserting_party),
        web::quote(&p.text, ""),
        escape(&p.observed),
        escape(p.published.as_deref().unwrap_or("Unknown")),
        escape(&p.inspection),
        escape(&p.origin_family),
        escape(&p.source_id),
        escape(&p.version),
        escape(&p.anchor)
    );
}

fn discovery(out: &mut String, dossier: &Dossier, person: &Person) {
    out.push_str("<h2>Discovery results</h2><p>Discovery matches are leads. Original passages need separate inspection and attribution.</p>");
    for source in dossier
        .sources
        .iter()
        .filter(|s| super::source_kind(s) == super::SourceKind::Discovery)
        .take(30)
    {
        for (title, url) in leads(source).into_iter().take(8) {
            let inspected = dossier.sources.iter().any(|s| {
                super::source_kind(s) == super::SourceKind::Original
                    && s.request_url.as_deref() == Some(&url)
            });
            let _ = write!(
                out,
                "<article class=\"cds-card\"><p><a href=\"{}\" rel=\"noreferrer\">{}</a> · {} · {}</p>{}</article>",
                escape(&url),
                escape(&title),
                escape(&source.origin),
                if inspected {
                    "Original retrieved"
                } else {
                    "Not inspected"
                },
                if inspected {
                    String::new()
                } else {
                    collect_button(person, "inspect", &url, "Inspect original")
                }
            );
        }
    }
}

fn leads(source: &crate::research::SourceRecord) -> Vec<(String, String)> {
    if source.search_provenance.is_some() {
        return source
            .source_url
            .as_ref()
            .filter(|u| canonical_url(u).is_some())
            .map(|u| vec![(source.title.clone(), u.clone())])
            .unwrap_or_default();
    }
    let mut items = Vec::new();
    for excerpt in &source.excerpts {
        if matches!(
            source.title.as_str(),
            "github_search evidence" | "gdelt_news evidence"
        ) && let Some(url) = excerpt
            .locator
            .as_ref()
            .filter(|u| canonical_url(u).is_some())
            && !excerpt.text.trim_start().starts_with(['{', '['])
            && source.request_url.as_ref() != Some(url)
        {
            items.push((excerpt.text.clone(), url.clone()));
            continue;
        }
        if let Ok(envelope) = serde_json::from_str::<Value>(&excerpt.text) {
            for item in ["items", "articles", "hits"]
                .iter()
                .filter_map(|key| envelope[*key].as_array())
                .flatten()
            {
                let title = ["title", "full_name", "login", "name"]
                    .iter()
                    .find_map(|field| item[*field].as_str());
                let url = ["html_url", "url"]
                    .iter()
                    .find_map(|field| item[*field].as_str())
                    .filter(|u| canonical_url(u).is_some());
                if let (Some(title), Some(url)) = (title, url) {
                    items.push((title.into(), url.into()));
                }
            }
        }
    }
    items
}

fn collect_button(person: &Person, action: &str, target: &str, label: &str) -> String {
    format!(
        "<form method=\"post\" class=\"cds-inline-form\" action=\"{}/collection\">{}{}{}<button class=\"cds-btn\">{label}</button></form>",
        root(&person.id),
        web::revision_input(person.version),
        hidden("action", action),
        hidden("target", target)
    )
}
fn coverage(out: &mut String, dossier: &Dossier, person: &Person) {
    for row in &dossier.coverage {
        let state = match row.state {
            CoverageState::Covered => "Search completed within configured scope",
            CoverageState::BoundedEmpty => "No matches in this scope",
            CoverageState::Blocked => "Configuration or access blocked collection",
            CoverageState::Partial => "Partial collection",
            CoverageState::Error => "Source unavailable",
            _ => row.state.as_str(),
        };
        let _ = write!(
            out,
            "<article class=\"cds-card\"><h3>{}</h3><p>{state}</p><p>{}</p><p>Returned {} · Inspected {}</p>",
            escape(&web::display_label(&row.family)),
            escape(row.stop_reason.as_deref().unwrap_or("Reason not recorded")),
            row.retrieved_count
                .map_or_else(|| "Unknown".into(), |n| n.to_string()),
            row.inspected_count
                .map_or_else(|| "Unknown".into(), |n| n.to_string())
        );
        if let Some(provider) = &row.search_provider {
            let _ = write!(
                out,
                "<p>Selected {} · Omitted {} · Duplicates {} · Invalid {} · Empty {}</p>",
                provider.selected,
                provider.omitted,
                provider.duplicate,
                provider.invalid,
                provider.empty
            );
        }
        if let Some(selection) = &row.search_call {
            let _ = write!(
                out,
                "<details><summary>Dropped results audit ({}; cross-provider duplicates {})</summary><ul>",
                selection.dropped.len(),
                selection.cross_provider_duplicates
            );
            for item in selection.dropped.iter().take(100) {
                let _ = write!(
                    out,
                    "<li>{} · {} · {}</li>",
                    escape(&item.provider),
                    escape(&item.url),
                    item.disposition.label()
                );
            }
            out.push_str("</ul></details>");
        }
        if row.state == CoverageState::Blocked {
            out.push_str("<p><a href=\"/settings\">Review provider settings</a></p>");
        }
        if matches!(
            row.state,
            CoverageState::Blocked | CoverageState::Error | CoverageState::Partial
        ) {
            out.push_str(&collect_button(
                person,
                "retry",
                &row.family,
                "Retry bounded collector",
            ));
        }
        let _ = write!(
            out,
            "<details><summary>Attempt scope and exclusions</summary><p>{}</p></details></article>",
            escape(&row.boundary)
        );
    }
}

#[derive(Deserialize)]
pub(crate) struct ReviewForm {
    snapshot: String,
    claim: String,
    #[serde(default)]
    passage: String,
    decision: String,
    reason: String,
    version: u64,
    view: String,
}
pub(crate) async fn review(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<ReviewForm>,
) -> Result<Redirect> {
    enabled(&app)?;
    let state = match form.decision.as_str() {
        "accept" => ReviewState::Accepted,
        "reject" => ReviewState::Rejected,
        "reopen" => ReviewState::NeedsReview,
        _ => return Err(Error::bad_request("Unknown review decision.")),
    };
    let reason = match form.reason.as_str() {
        "checked" => "Checked exact attribution and passage",
        "identity" => "Identity needs investigation",
        "conflict" => "Contrary or insufficient evidence",
        "date" => "Date needs investigation",
        _ => return Err(Error::bad_request("Select a review reason.")),
    };
    let review = Review {
        id: uuid::Uuid::new_v4().to_string(),
        person_id: id.clone(),
        claim: form.claim.clone(),
        passage: (!form.passage.is_empty()).then_some(form.passage),
        snapshot: form.snapshot.clone(),
        actor: "Workspace operator".into(),
        reason: reason.into(),
        state,
        at: crate::now_ms(),
    };
    let saved = app
        .db()
        .transaction(move |tx| save_review(tx, &review, form.version))
        .await?;
    if !saved {
        return Err(Error::conflict(
            "Person or claim changed. Reload before reviewing.",
        ));
    }
    let tab = TABS
        .iter()
        .find(|(id, _)| *id == form.view)
        .map_or("evidence", |(id, _)| *id);
    let scope = Scope {
        snapshot: form.snapshot,
        ..Scope::default()
    };
    Ok(Redirect::to(
        &claim_url(&id, tab, &scope, &form.claim).replace("&amp;", "&"),
    ))
}

#[derive(Deserialize)]
pub(crate) struct CollectForm {
    action: String,
    target: String,
    version: u64,
}
pub(crate) async fn collect(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<CollectForm>,
) -> Result<Redirect> {
    enabled(&app)?;
    if !["inspect", "retry"].contains(&form.action.as_str()) || form.target.len() > 4000 {
        return Err(Error::bad_request("Invalid collection action."));
    }
    let correlation = crate::correlation::current();
    let job = app.db().transaction(move|tx| {
        let p = store::get::<Person>(tx,"person",&id)?.filter(active).ok_or_else(||anyhow::anyhow!("Person not active"))?;
        anyhow::ensure!(p.version==form.version,"Person changed; reload first");
        let selection = if form.action=="inspect" {
            anyhow::ensure!(crate::collect::validate_target(&form.target).is_ok(),"Use a valid public source URL");
            ("fetch_url".to_owned(),json!({"url":form.target}))
        } else {
            let ctx = crate::research::ResearchContext { subject:p.name.clone(),subject_kind:"person".into(),research_date:String::new(),as_of_date:None,depth:"deep".into(),presentation:"short".into(),geography:String::new(),questions:vec![],history:String::new(),offering:None,internal_sources:vec![] };
            crate::terminal::person::planned_actions(&p,&ctx).into_iter().find(|(a,_)|*a==form.target).ok_or_else(||anyhow::anyhow!("No configured bounded action for this provider"))?
        };
        let input=json!({"person_id":id,"version":p.version,"collector":selection.0,"args":selection.1});
        work::enqueue_tx(tx,"people.terminal_inspect",&key(&input)?,input,correlation.as_deref(),None)
    }).await.map_err(|e|Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!("/runs/{}", job.id)))
}

pub(super) async fn execute_collect(
    app: &crate::connection::RunScope,
    job: &work::Job,
) -> anyhow::Result<Value> {
    let id = job.input["person_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let p = app
        .db()
        .get::<Person>("person", &id)
        .await?
        .filter(active)
        .ok_or_else(|| anyhow::anyhow!("Person no longer active"))?;
    anyhow::ensure!(
        Some(p.version) == job.input["version"].as_u64(),
        "Person changed before inspection"
    );
    anyhow::ensure!(
        app.cfg().llm_provider != "mock",
        "Offline installation does not contact public collectors"
    );
    let mut sources = Vec::new();
    let mut coverage = Vec::new();
    let collector = job.input["collector"].as_str().unwrap_or_default();
    let collect_started = std::time::Instant::now();
    let collect_outcome = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        crate::terminal::runner::run_single(
            app,
            collector,
            &job.input["args"],
            "Targeted independent inspection",
            crate::settings::load(app.db())
                .await?
                .research_contact
                .as_deref(),
            &mut sources,
            &mut coverage,
            &mut Vec::new(),
            &mut Vec::new(),
        ),
    )
    .await;
    let collect_ms = collect_started.elapsed().as_millis() as u64;
    let collector_status = match collect_outcome {
        Ok(Ok(())) => {
            let errored = coverage
                .iter()
                .find(|row| matches!(row.state, CoverageState::Error));
            let blocked = coverage
                .iter()
                .find(|row| matches!(row.state, CoverageState::Blocked));
            let (status, detail) = if let Some(row) = errored {
                (
                    "failed",
                    row.stop_reason
                        .clone()
                        .unwrap_or_else(|| "collector reported error coverage".into()),
                )
            } else if let Some(row) = blocked {
                (
                    "blocked",
                    row.stop_reason
                        .clone()
                        .unwrap_or_else(|| "collector blocked".into()),
                )
            } else {
                ("ok", format!("sources={}", sources.len()))
            };
            let detail: String = crate::llm::redact_error(&detail, app.cfg())
                .chars()
                .take(200)
                .collect();
            app.recorder().record_event(
                "collector",
                Some(collector),
                status,
                Some(collect_ms),
                Some(&detail),
            );
            status
        }
        Ok(Err(error)) => {
            let detail: String = crate::llm::redact_error(&format!("{error:#}"), app.cfg())
                .chars()
                .take(200)
                .collect();
            app.recorder().record_event(
                "collector",
                Some(collector),
                "failed",
                Some(collect_ms),
                Some(&detail),
            );
            "failed"
        }
        Err(_) => {
            app.recorder().record_event(
                "collector",
                Some(collector),
                "timed_out",
                Some(collect_ms),
                Some("collector exceeded 60s timeout"),
            );
            "timed_out"
        }
    };
    sources = app
        .db()
        .transaction({
            let id = id.clone();
            move |tx| {
                super::apply_revocations(tx, &id, &mut sources)?;
                Ok(sources)
            }
        })
        .await?;
    super::screen_originals(app, &mut sources).await?;
    let snapshot = if sources
        .iter()
        .any(|source| super::source_kind(source) == super::SourceKind::Original)
    {
        let dossier = Dossier {
            id: job.id.clone(),
            subject_id: id.clone(),
            identity: crate::terminal::automatic::person_identity(&p),
            subject_version: p.version,
            body: String::new(),
            sources: sources.clone(),
            coverage: coverage.clone(),
            frontier: Vec::new(),
            claims: Vec::new(),
            limitations: Vec::new(),
            created_at: crate::now_ms(),
            run_id: job.id.clone(),
            employment_history: Vec::new(),
        };
        Some(super::assess(app, &dossier).await?)
    } else {
        None
    };
    let sources_collected = sources.len();
    let record = json!({"person_id":id,"sources":sources,"coverage":coverage,"collector_status":collector_status,"at":crate::now_ms()});
    let job_id = job.id.clone();
    let attempt = job.attempt;
    app.db()
        .transaction(move |tx| {
            ensure_worker(tx, &job_id, attempt)?;
            let current = store::get::<Person>(tx, "person", &id)?.filter(active);
            anyhow::ensure!(
                current.is_some_and(|current| current.version == p.version),
                "Person changed during inspection"
            );
            store::put(tx, INSPECTION, &job_id, &record)?;
            if let Some(snapshot) = snapshot {
                extend_snapshot(tx, snapshot)?;
            }
            Ok(())
        })
        .await?;
    Ok(
        json!({"url":format!("/terminal/people/{}?view=evidence",p.id),"collector_status":collector_status,"sources_collected":sources_collected}),
    )
}

pub(super) fn ensure_worker(
    tx: &rusqlite::Connection,
    id: &str,
    attempt: u32,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        work::owns_attempt(tx, id, attempt)?,
        "Run is no longer active"
    );
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Screen {
    pub q: String,
    pub predicate: String,
    pub review: String,
    pub unknown: String,
    pub year: String,
    #[serde(flatten)]
    pub scope: Scope,
}
impl Screen {
    pub fn validate(mut self) -> Result<Self> {
        if self.q.len() > 200
            || self.predicate.len() > 40
            || self.review.len() > 32
            || self.year.len() > 4
            || !matches!(self.unknown.as_str(), "" | "include" | "exclude" | "only")
            || (!self.year.is_empty() && period(&self.year).is_none())
        {
            return Err(Error::bad_request("Invalid research search criteria."));
        }
        self.scope = self.scope.validate()?;
        Ok(self)
    }
    pub fn matches(&self, fact: &Fact) -> bool {
        if fact.review == ReviewState::Rejected && self.review != "Rejected" {
            return false;
        }
        (self.predicate.is_empty() || self.predicate == fact.predicate)
            && (self.review.is_empty() || self.review == fact.review.label())
            && (self.year.is_empty()
                || [&fact.effective.start, &fact.effective.end]
                    .into_iter()
                    .flatten()
                    .any(|s| s.starts_with(&self.year)))
            && (self.q.trim().is_empty() || {
                let needle = self.q.trim().trim_matches('"').to_lowercase();
                [&fact.statement, &fact.value]
                    .into_iter()
                    .chain(
                        fact.supports
                            .iter()
                            .chain(&fact.contradicts)
                            .flat_map(|p| [&p.title, &p.text]),
                    )
                    .any(|s| s.to_lowercase().contains(&needle))
            })
    }
}

pub(super) fn all_context(
    tx: &rusqlite::Connection,
    id: &str,
    scope: &Scope,
) -> anyhow::Result<Option<Context>> {
    let scope = Scope {
        page: 0,
        ..scope.clone()
    };
    let Some(mut ctx) = context(tx, id, &scope)? else {
        return Ok(None);
    };
    let mut page = 1;
    while ctx.next_page {
        let Some(mut next) = context(
            tx,
            id,
            &Scope {
                page,
                ..scope.clone()
            },
        )?
        else {
            break;
        };
        ctx.next_page = next.next_page;
        ctx.claims.append(&mut next.claims);
        page += 1;
    }
    Ok(Some(ctx))
}

pub(super) fn screen_people(
    tx: &rusqlite::Connection,
    filter: &Screen,
    limit: usize,
) -> anyhow::Result<Vec<(Context, Vec<Fact>)>> {
    let mut stmt=tx.prepare("SELECT id FROM record WHERE kind='person' AND json_extract(body,'$.archived')=0
        AND json_extract(body,'$.merged_into') IS NULL ORDER BY json_extract(body,'$.name') COLLATE NOCASE,id")?;
    let mut out = Vec::new();
    let skip = filter.scope.page.saturating_mul(limit);
    let mut matched = 0;
    for id in stmt.query_map([], |row| row.get::<_, String>(0))? {
        let Some(mut ctx) = all_context(tx, &id?, &filter.scope)? else {
            continue;
        };
        let facts = ctx
            .claims
            .drain(..)
            .filter(|f| filter.matches(f))
            .collect::<Vec<_>>();
        let positive = facts.iter().any(Fact::positive);
        let identity_match = filter.predicate.is_empty()
            && filter.review.is_empty()
            && filter.year.is_empty()
            && !filter.q.trim().is_empty()
            && ctx
                .name
                .to_lowercase()
                .contains(&filter.q.trim().trim_matches('"').to_lowercase());
        let passages_match = filter.predicate.is_empty()
            && filter.review.is_empty()
            && filter.year.is_empty()
            && !filter.q.trim().is_empty()
            && snapshot_passages(
                tx,
                &ctx.person_id,
                &Scope {
                    page: 0,
                    ..filter.scope.clone()
                },
            )?
            .iter()
            .any(|p| {
                let phrase = filter.q.trim().trim_matches('"').to_lowercase();
                p.title.to_lowercase().contains(&phrase) || p.text.to_lowercase().contains(&phrase)
            });
        let contested = facts.iter().any(|f| f.state() == "Contested");
        let nonmatch = facts.iter().any(|f| f.state() == "Contradicted");
        let include = match filter.unknown.as_str() {
            "include" => true,
            "only" => !positive && !contested && !nonmatch && !identity_match && !passages_match,
            "exclude" => positive || identity_match || passages_match,
            _ => positive || contested || nonmatch || identity_match || passages_match,
        };
        if include {
            if matched >= skip {
                out.push((ctx, facts));
            }
            matched += 1;
            if out.len() > limit {
                break;
            }
        }
    }
    Ok(out)
}

fn search_form(filter: &Screen) -> String {
    let fields = [
        "",
        "affiliation",
        "role",
        "work",
        "topic",
        "event",
        "relationship",
        "education",
        "founding",
        "departure",
    ];
    let options = fields
        .iter()
        .map(|f| {
            format!(
                "<option value=\"{f}\"{}>{}</option>",
                if *f == filter.predicate {
                    " selected"
                } else {
                    ""
                },
                if f.is_empty() { "All fields" } else { f }
            )
        })
        .collect::<String>();
    let review = ["", "Unreviewed", "Accepted", "Rejected", "Needs review"]
        .iter()
        .map(|f| {
            format!(
                "<option value=\"{f}\"{}>{}</option>",
                if *f == filter.review { " selected" } else { "" },
                if f.is_empty() { "Any review state" } else { f }
            )
        })
        .collect::<String>();
    let unknown = [
        ("", "Show documented results"),
        ("include", "Include Unknown"),
        ("exclude", "Positive matches only"),
        ("only", "Unknown only"),
    ]
    .iter()
    .map(|(k, l)| {
        format!(
            "<option value=\"{k}\"{}>{l}</option>",
            if *k == filter.unknown {
                " selected"
            } else {
                ""
            }
        )
    })
    .collect::<String>();
    format!(
        "{}<label>Field <select name=\"predicate\">{options}</select></label><label>Review state <select name=\"review\">{review}</select></label><label>Missing evidence <select name=\"unknown\">{unknown}</select></label>{}{}",
        web::field(
            "Exact phrase or value",
            "q",
            &filter.q,
            "search",
            Some(200),
            false
        ),
        web::field(
            "Effective year",
            "year",
            &filter.year,
            "text",
            Some(4),
            false
        ),
        date_scope(&filter.scope)
    )
}

pub(crate) async fn search(
    State(app): State<App>,
    Query(filter): Query<Screen>,
) -> Result<Response> {
    enabled(&app)?;
    let filter = filter.validate()?;
    let filters = filter.clone();
    let hits = app
        .db()
        .transaction(move |tx| screen_people(tx, &filters, 20))
        .await?;
    let mut out = format!(
        "<p><a href=\"/terminal/people\">Find a person</a></p><form class=\"cds-form\" method=\"get\">{}<button class=\"cds-btn cds-btn--primary\">Search evidence</button></form><section class=\"cds-section\"><h2>Matching research</h2>",
        search_form(&filter)
    );
    if hits.is_empty() {
        out.push_str("<p>No matches for this query. Choose Include Unknown to see people whose research does not settle it.</p>")
    }
    for (ctx, facts) in hits.iter().take(20) {
        let scope = Scope {
            snapshot: ctx.snapshot.clone().unwrap_or_default(),
            page: 0,
            ..filter.scope.clone()
        };
        let _ = write!(
            out,
            "<h3><a href=\"{}\">{}</a></h3>",
            view_url(&ctx.person_id, "evidence", &scope),
            escape(&ctx.name)
        );
        render_facts(
            &mut out,
            facts.iter().take(4),
            &ctx.person_id,
            "evidence",
            &scope,
        );
    }
    if hits.len() > 20 {
        let mut next = filter.clone();
        next.scope.page += 1;
        let _ = write!(
            out,
            "<p><a href=\"?{}\">Next page</a></p>",
            escape(&screen_query(&next))
        );
    }
    let _ = write!(
        out,
        "</section><form method=\"post\" class=\"cds-form\" action=\"/terminal/people/watchlists\">{}{}{}<button class=\"cds-btn\">Save as a watchlist</button></form>",
        web::field("Watchlist name", "name", "", "text", Some(100), true),
        hidden("kind", "query"),
        hidden(
            "query",
            &serde_json::to_string(&filter).map_err(anyhow::Error::from)?
        )
    );
    Ok(workspace("Search the research", out))
}

pub(super) fn screen_query(filter: &Screen) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in [
        ("q", &filter.q),
        ("predicate", &filter.predicate),
        ("review", &filter.review),
        ("unknown", &filter.unknown),
        ("year", &filter.year),
    ] {
        q.append_pair(k, v);
    }
    format!("{}&{}", q.finish(), filter.scope.query())
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Shortlist {
    pub person: String,
    pub second: String,
    pub third: String,
    pub fields: String,
    #[serde(flatten)]
    pub scope: Scope,
}
impl Shortlist {
    pub fn ids(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        [&self.person, &self.second, &self.third]
            .into_iter()
            .filter(|s| !s.is_empty() && seen.insert(*s))
            .cloned()
            .collect()
    }
    fn fields(&self) -> Result<Vec<&str>> {
        let fields = if self.fields.is_empty() {
            "affiliation,role,work"
        } else {
            &self.fields
        };
        let items = fields.split(',').map(str::trim).collect::<Vec<_>>();
        if items.is_empty()
            || items.len() > 6
            || items.iter().any(|f| {
                ![
                    "affiliation",
                    "role",
                    "work",
                    "topic",
                    "event",
                    "relationship",
                    "education",
                    "founding",
                    "departure",
                ]
                .contains(f)
            })
        {
            return Err(Error::bad_request("Choose up to six comparison fields."));
        }
        Ok(items)
    }
}
#[derive(Serialize, Deserialize)]
struct Comparison {
    person_ids: Vec<String>,
    shortlist: Shortlist,
    snapshots: Vec<(String, Option<String>)>,
}

pub(super) fn selector(people: &[Person], label: &str, field: &str, value: &str) -> String {
    let mut out = format!(
        "<label>{label} <select name=\"{field}\"><option value=\"\">Select a person</option>"
    );
    for p in people.iter().filter(|p| active(p)) {
        let _ = write!(
            out,
            "<option value=\"{}\"{}>{} · {}</option>",
            escape(&p.id),
            if p.id == value { " selected" } else { "" },
            escape(&p.name),
            escape(&p.company)
        );
    }
    out.push_str("</select></label>");
    out
}

pub(crate) async fn compare(
    State(app): State<App>,
    Query(mut list): Query<Shortlist>,
) -> Result<Response> {
    enabled(&app)?;
    list.scope = list.scope.validate()?;
    let people = app.db().list::<Person>("person").await?;
    let mut out = format!(
        "<form class=\"cds-form\" method=\"get\">{}{}{}{}{}<button class=\"cds-btn cds-btn--primary\">Compare</button></form>",
        selector(&people, "First person", "person", &list.person),
        selector(&people, "Second person", "second", &list.second),
        selector(&people, "Third person (optional)", "third", &list.third),
        web::field(
            "Fields (affiliation, role, work, topic, event, relationship, education, founding, departure)",
            "fields",
            &list.fields,
            "text",
            Some(110),
            false
        ),
        date_scope(&list.scope)
    );
    let ids = list.ids();
    if ids.len() >= 2 {
        let scopes = list.clone();
        let contexts = app
            .db()
            .transaction(move |tx| {
                ids.iter()
                    .map(|id| all_context(tx, id, &scopes.scope))
                    .collect::<anyhow::Result<Vec<_>>>()
            })
            .await?;
        table(&mut out, &list, contexts)?;
        let encoded = serde_json::to_string(&list).map_err(anyhow::Error::from)?;
        let _ = write!(
            out,
            "<form class=\"cds-inline-form\" method=\"post\">{}<button class=\"cds-btn\">Save comparison snapshot</button></form>",
            hidden("selection", &encoded)
        );
    }
    Ok(workspace("Compare people", out))
}

fn table(out: &mut String, list: &Shortlist, contexts: Vec<Option<Context>>) -> Result<()> {
    let _ = write!(
        out,
        "<section class=\"cds-section\"><h2>Comparison matrix</h2><p>Scope: {} {}. An empty cell means Unknown.</p><div class=\"cds-table-scroll\"><table class=\"cds-table\"><thead><tr><th>Criterion</th>",
        time_label(list.scope.mode),
        escape(&list.scope.date)
    );
    for ctx in &contexts {
        let _ = write!(
            out,
            "<th scope=\"col\">{}</th>",
            escape(ctx.as_ref().map_or("Unavailable", |c| c.name.as_str()))
        );
    }
    out.push_str("</tr></thead><tbody>");
    for field in list.fields()? {
        let _ = write!(out, "<tr><th scope=\"row\">{}</th>", escape(field));
        for ctx in &contexts {
            out.push_str("<td>");
            if let Some(ctx) = ctx {
                let scope = Scope {
                    snapshot: ctx.snapshot.clone().unwrap_or_default(),
                    page: 0,
                    ..list.scope.clone()
                };
                render_facts(
                    out,
                    ctx.claims
                        .iter()
                        .filter(|f| f.predicate == field && f.review != ReviewState::Rejected)
                        .take(6),
                    &ctx.person_id,
                    "evidence",
                    &scope,
                );
            } else {
                out.push_str("Unknown");
            }
            out.push_str("</td>");
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table></div></section>");
    Ok(())
}
fn time_label(mode: TimeMode) -> &'static str {
    match mode {
        TimeMode::Latest => "Latest research",
        TimeMode::Effective => "Effective on",
        TimeMode::Known => "Known to this system by",
        TimeMode::Published => "Published by",
    }
}

#[derive(Deserialize)]
pub(crate) struct SaveComparison {
    selection: String,
}
pub(crate) async fn save_comparison(
    State(app): State<App>,
    Form(form): Form<SaveComparison>,
) -> Result<Redirect> {
    enabled(&app)?;
    let mut shortlist: Shortlist = serde_json::from_str(&form.selection)
        .map_err(|_| Error::bad_request("Invalid comparison selection."))?;
    shortlist.scope = shortlist.scope.validate()?;
    shortlist.fields()?;
    let person_ids = shortlist.ids();
    if !(2..=3).contains(&person_ids.len()) {
        return Err(Error::bad_request("Compare two or three different people."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let saved_id = id.clone();
    app.db()
        .transaction(move |tx| {
            let mut snapshots = Vec::new();
            for p in &person_ids {
                let ctx = context(tx, p, &shortlist.scope)?
                    .ok_or_else(|| anyhow::anyhow!("Person unavailable"))?;
                snapshots.push((p.clone(), ctx.snapshot));
            }
            store::put(
                tx,
                "people_terminal_comparison",
                &saved_id,
                &Comparison {
                    person_ids,
                    shortlist,
                    snapshots,
                },
            )
        })
        .await?;
    Ok(Redirect::to(&format!("/terminal/people/compare/{id}")))
}

pub(crate) async fn saved_comparison(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Response> {
    enabled(&app)?;
    let saved: Comparison = app
        .db()
        .get("people_terminal_comparison", &id)
        .await?
        .ok_or_else(|| Error::not_found("Comparison no longer available."))?;
    let scope = saved.shortlist.scope.clone();
    let contexts = app
        .db()
        .transaction(move |tx| {
            saved
                .snapshots
                .into_iter()
                .map(|(id, revision)| {
                    if let Some(snapshot) = revision {
                        all_context(
                            tx,
                            &id,
                            &Scope {
                                snapshot,
                                ..scope.clone()
                            },
                        )
                    } else {
                        let mut ctx = context(tx, &id, &Scope::default())?;
                        if let Some(c) = &mut ctx {
                            c.claims.clear();
                            c.snapshot = None;
                            c.recorded = None;
                        }
                        Ok(ctx)
                    }
                })
                .collect::<anyhow::Result<Vec<_>>>()
        })
        .await?;
    let refresh = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("person", &saved.shortlist.person)
        .append_pair("second", &saved.shortlist.second)
        .append_pair("third", &saved.shortlist.third)
        .append_pair("fields", &saved.shortlist.fields)
        .finish();
    let mut out = format!(
        "<p>Saved snapshot · <a href=\"/terminal/people/compare?{}&amp;{}\">Open with current research</a></p>",
        escape(&refresh),
        escape(&saved.shortlist.scope.query())
    );
    table(&mut out, &saved.shortlist, contexts)?;
    Ok(workspace("Saved comparison", out))
}

#[derive(Deserialize)]
pub(crate) struct ExportScope {
    format: String,
    #[serde(flatten)]
    scope: Scope,
}
pub(crate) async fn export(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<ExportScope>,
) -> Result<Response> {
    enabled(&app)?;
    let scope = query.scope.validate()?;
    let ctx = app
        .db()
        .transaction(move |tx| all_context(tx, &id, &scope))
        .await?
        .ok_or_else(|| Error::not_found("Person or snapshot unavailable."))?;
    match query.format.as_str() {
        "json" => Ok(axum::Json(ctx).into_response()),
        "csv" => {
            let mut csv="person_id,snapshot,claim_id,field,value,statement,start,end,support,review,source_version,source_url,observed,published,anchor,relation\r\n".to_owned();
            for fact in &ctx.claims {
                for (relation, link) in fact
                    .supports
                    .iter()
                    .map(|p| ("supports", p))
                    .chain(fact.contradicts.iter().map(|p| ("contradicts", p)))
                {
                    let fields = [
                        ctx.person_id.as_str(),
                        ctx.snapshot.as_deref().unwrap_or_default(),
                        &fact.id,
                        &fact.predicate,
                        &fact.value,
                        &fact.statement,
                        fact.effective.start.as_deref().unwrap_or_default(),
                        fact.effective.end.as_deref().unwrap_or_default(),
                        fact.state(),
                        fact.review.label(),
                        &link.version,
                        &link.url,
                        &link.observed,
                        link.published.as_deref().unwrap_or_default(),
                        &link.anchor,
                        relation,
                    ];
                    csv.push_str(
                        &fields
                            .into_iter()
                            .map(csv_cell)
                            .collect::<Vec<_>>()
                            .join(","),
                    );
                    csv.push_str("\r\n");
                }
            }
            Ok((
                [
                    (axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        "attachment; filename=people-research.csv",
                    ),
                ],
                csv,
            )
                .into_response())
        }
        _ => Err(Error::bad_request("Export format must be json or csv.")),
    }
}
fn csv_cell(s: &str) -> String {
    let prefix = if s.trim_start().starts_with(['=', '+', '-', '@']) {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", s.replace('"', "\"\""))
}

#[derive(Deserialize)]
pub(crate) struct RevokeForm {
    source: String,
    version: u64,
}
pub(crate) async fn revoke_source(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<RevokeForm>,
) -> Result<Redirect> {
    enabled(&app)?;
    let person = id.clone();
    if !app
        .db()
        .transaction(move |tx| revoke(tx, &person, &form.source, form.version))
        .await?
    {
        return Err(Error::conflict("Source or person revision changed."));
    }
    Ok(Redirect::to(
        &format!("{}/?view=evidence", root(&id)).replace("/?", "?"),
    ))
}
