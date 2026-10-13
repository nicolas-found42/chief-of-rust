//! Server-rendered content development, research, and trend views.
use super::*;
fn input(name: &str, label: &str, value: &str) -> String {
    format!(
        "<label>{}<input name=\"{}\" value=\"{}\" required></label>",
        escape(label),
        escape(name),
        escape(value)
    )
}

fn textarea(name: &str, label: &str, value: &str) -> String {
    format!(
        "<label>{}<textarea name=\"{}\" rows=\"5\">{}</textarea></label>",
        escape(label),
        escape(name),
        escape(value)
    )
}

fn button_form(action: &str, label: &str, hidden: &str) -> String {
    format!(
        "<form method=\"post\" action=\"{}\">{}<button>{}</button></form>",
        escape(action),
        hidden,
        escape(label)
    )
}

fn ready_button_form(action: &str, label: &str, hidden: &str, blocked: Option<&str>) -> String {
    match blocked {
        None => button_form(action, label, hidden),
        Some(reason) => {
            let hint = escape(&format!("ready{}", action.replace('/', "-")));
            format!(
                "<form method=\"post\" action=\"{}\">{}<button disabled aria-describedby=\"{hint}\">{}</button><p id=\"{hint}\">{}</p></form>",
                escape(action),
                hidden,
                escape(label),
                escape(reason)
            )
        }
    }
}

fn fence(n: u64) -> String {
    format!("<input type=\"hidden\" name=\"revision\" value=\"{n}\">")
}

pub(super) async fn home(State(app): State<App>) -> web::Result<Response> {
    let brand = app.db.get::<Brand>("brand", "current").await?;
    let mut body="<p class=\"eyebrow\">Content Engine</p><h1>Build from evidence. Publish with intent.</h1><p>Shape a voice, discover useful angles, and carry each idea through reviewed evidence, an outline, and a finished draft.</p><div class=\"grid\"><section><h2>Brand profile</h2><form method=\"post\" action=\"/content/brand\">".to_owned();
    body.push_str(&format!(
        "<input type=\"hidden\" name=\"revision\" value=\"{}\">",
        brand.as_ref().map_or(0, |b| b.revision)
    ));
    body.push_str(&input(
        "name",
        "Brand name",
        brand.as_ref().map_or("", |b| &b.name),
    ));
    body.push_str(&input(
        "audience",
        "Who you serve",
        brand.as_ref().map_or("", |b| &b.audience),
    ));
    body.push_str(&textarea(
        "voice",
        "Voice and positioning",
        brand.as_ref().map_or("", |b| &b.voice),
    ));
    body.push_str(&textarea(
        "boundaries",
        "Constraints and topics to avoid",
        brand.as_ref().map_or("", |b| &b.boundaries),
    ));
    body.push_str(&textarea(
        "evidence",
        "Your approved examples, facts, and evidence",
        brand.as_ref().map_or("", |b| &b.evidence),
    ));
    body.push_str("<button>Save brand revision</button></form>");
    if let Some(brand) = brand {
        body.push_str(&format!(
            "<p>Revision {} · {}</p>",
            brand.revision,
            escape(&brand.updated_at)
        ));
    }
    body.push_str("</section><section><h2>Source watchlist</h2><p>Public pages and feeds are collected only when you run Scout or enable a schedule.</p><form method=\"post\" action=\"/content/sources\">");
    body.push_str(&input("label", "Source label", ""));
    body.push_str(&input("url", "Public URL or feed", ""));
    body.push_str("<button>Add source</button></form>");
    for source in app.db.list::<Source>("content.source").await? {
        body.push_str(&format!(
            "<article><a href=\"{}\">{}</a> · {}{}</article>",
            escape(&source.url),
            escape(&source.label),
            if source.paused { "Paused" } else { "Active" },
            button_form(
                &format!("/content/sources/{}/toggle", source.id),
                if source.paused { "Resume" } else { "Pause" },
                ""
            )
        ));
    }
    body.push_str(&button_form("/content/scout", "Scout opportunities", ""));
    body.push_str("</section></div><section><h2>Opportunity shortlist</h2>");
    let opportunities = app.db.list::<Opportunity>("content.opportunity").await?;
    if opportunities.is_empty() {
        body.push_str(
            "<p>No opportunities yet. Save your brand, add a source, then run Scout.</p>",
        );
    }
    for opportunity in opportunities {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>{}</p><p>{} · Brand revision {}</p>",
            escape(&opportunity.title),
            escape(&opportunity.angle),
            escape(&opportunity.state),
            opportunity.brand.revision
        ));
        if let Some(project_id) = opportunity.project_id {
            body.push_str(&format!(
                "<a href=\"/content/projects/{project_id}\">Open project</a>"
            ));
        } else if opportunity.state == "shortlisted" {
            body.push_str(&button_form(
                &format!("/content/opportunities/{}/select", opportunity.id),
                "Develop this idea",
                "",
            ));
            body.push_str(&button_form(
                &format!("/content/opportunities/{}/skip", opportunity.id),
                "Skip",
                "",
            ));
        }
        for evidence in opportunity.evidence {
            if let Some(url) = evidence.url {
                body.push_str(&format!(
                    "<p><a href=\"{}\">{}</a></p>",
                    escape(&url),
                    escape(&evidence.title)
                ));
            }
        }
        body.push_str("</article>");
    }
    body.push_str("</section><section><h2>Content projects</h2>");
    for project in app.db.list::<Project>("content.project").await? {
        let rev = project.current();
        body.push_str(&format!(
            "<article><a href=\"/content/projects/{}\">{}</a><p>{} · Revision {}</p></article>",
            project.id,
            escape(&rev.subject),
            escape(&rev.target),
            rev.number
        ));
    }
    body.push_str("<details><summary>Start a project from your own idea</summary><form method=\"post\" action=\"/content/projects\">");
    body.push_str(&project_form(None));
    body.push_str("<button>Create project</button></form></details></section>");
    Ok(web::page("Content Engine", body))
}

fn project_form(rev: Option<&Revision>) -> String {
    let mut body = input(
        "subject",
        "Topic or subject",
        rev.map_or("", |r| &r.subject),
    );
    body.push_str(&input(
        "objective",
        "What should this piece accomplish?",
        rev.map_or("", |r| &r.objective),
    ));
    body.push_str(&input(
        "audience",
        "Audience",
        rev.map_or("", |r| &r.audience),
    ));
    body.push_str("<label>Publication format<select name=\"target\">");
    for target in TARGETS {
        body.push_str(&format!(
            "<option value=\"{target}\" {}>{}</option>",
            if rev.is_some_and(|r| r.target == target) {
                "selected"
            } else {
                ""
            },
            escape(&target.replace('-', " "))
        ));
    }
    body.push_str("</select></label>");
    body.push_str(&textarea(
        "material",
        "Your original material and constraints",
        rev.map_or("", |r| &r.material),
    ));
    if let Some(r) = rev {
        body.push_str(&fence(r.number));
    }
    body
}

pub(super) async fn project_page(
    State(app): State<App>,
    Path(id): Path<String>,
) -> web::Result<Response> {
    let project = load_project(&app, &id).await?;
    let r = project.current();
    let base = format!("/content/projects/{id}");
    let mut body = format!(
        "<a href=\"/content\">← Content Engine</a><h1>{}</h1><p>Revision {} · {} · {}</p><p>{}</p><details><summary>Revise intent</summary><p>A new revision preserves all previous evidence, outlines, and drafts. New work requires review again.</p><form method=\"post\" action=\"{base}/revise\">{}<button>Save new revision</button></form></details><section><h2>1. Evidence</h2><p>Review each source before approving it for use. Source text is untrusted material; every generated claim still needs your judgment.</p>",
        escape(&r.subject),
        r.number,
        escape(&r.target),
        escape(&r.audience),
        escape(&r.objective),
        project_form(Some(r))
    );
    if !r.material.is_empty() {
        body.push_str(&format!(
            "<h3>Your original material</h3><pre>{}</pre>",
            escape(&r.material)
        ));
    }
    for e in &r.evidence {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>Evidence {} · {}</p>",
            escape(&e.title),
            escape(&e.id),
            escape(&e.observed_at)
        ));
        if let Some(url) = &e.url {
            body.push_str(&format!("<a href=\"{}\">Open source</a>", escape(url)));
        }
        body.push_str(&format!(
            "<details><summary>Read captured evidence</summary><pre>{}</pre></details></article>",
            escape(&e.text)
        ));
        body.push_str(&button_form(
            &format!("{base}/evidence/{}/exclude", e.id),
            "Exclude this source in a new revision",
            &fence(r.number),
        ));
    }
    render_artifacts(&mut body, r, "research", &base);
    body.push_str(&format!("<form method=\"post\" action=\"{base}/evidence\">{}{}<label>Public source URL (optional)<input name=\"url\" type=\"url\"></label>{}<button>Attach evidence in a new revision</button></form>",fence(r.number),input("title","Evidence title",""),textarea("text","Evidence text (required; attributed manual evidence)","")));
    body.push_str(&button_form(
        &format!("{base}/generate/research"),
        "Research this topic",
        &fence(r.number),
    ));
    if r.evidence_reviewed {
        body.push_str(&format!(
            "<p class=\"badge\">Evidence reviewed · Brand revision {}</p>",
            r.brand.as_ref().map_or(0, |b| b.revision)
        ));
    } else {
        body.push_str(&button_form(
            &format!("{base}/review"),
            "I reviewed this evidence and approve it for generation",
            &fence(r.number),
        ));
    }
    body.push_str("</section><section><h2>2. Outline</h2>");
    body.push_str(&ready_button_form(
        &format!("{base}/generate/outline"),
        "Generate outline",
        &fence(r.number),
        (!r.evidence_reviewed)
            .then_some("Review and approve the evidence in step 1 to generate an outline."),
    ));
    render_artifacts(&mut body, r, "outline", &base);
    body.push_str("</section><section><h2>3. Draft</h2><p>Approve the latest outline to generate a draft. Review its claims before approving export.</p>");
    body.push_str(&ready_button_form(
        &format!("{base}/generate/draft"),
        "Generate draft",
        &fence(r.number),
        if !r.evidence_reviewed {
            Some("Review and approve the evidence in step 1, then approve an outline in step 2.")
        } else if !latest(r, "outline").is_some_and(|a| a.approved_at.is_some()) {
            Some("Generate and approve the latest outline in step 2 to generate a draft.")
        } else {
            None
        },
    ));
    render_artifacts(&mut body, r, "draft", &base);
    if latest(r, "draft").is_some_and(|a| a.approved_at.is_some() && draft_current(r, a)) {
        body.push_str(&format!(
            "<a class=\"button\" href=\"{base}/export\">Download reviewed draft</a>"
        ));
    }
    body.push_str("</section><details><summary>Revision history</summary>");
    for revision in &project.revisions {
        body.push_str(&format!("<article><h3>Revision {} · {}</h3><p>{} · {} evidence items · {} generated versions</p>",revision.number,escape(&revision.created_at),escape(&revision.subject),revision.evidence.len(),revision.artifacts.len()));
        for artifact in &revision.artifacts {
            body.push_str(&format!(
                "<details><summary>{} · {}</summary><pre>{}</pre></details>",
                escape(&artifact.stage),
                escape(&artifact.created_at),
                escape(&artifact.body)
            ));
        }
        body.push_str("</article>");
    }
    body.push_str("</details>");
    Ok(web::page(&r.subject, body))
}

fn render_artifacts(body: &mut String, r: &Revision, stage: &str, base: &str) {
    for artifact in r.artifacts.iter().filter(|a| a.stage == stage) {
        body.push_str(&format!(
            "<article><p>{} · {} · {}</p><pre>{}</pre><p>Cited evidence: {}</p>",
            escape(&artifact.created_at),
            escape(&artifact.model),
            if artifact.approved_at.is_some() {
                "Approved"
            } else {
                "Needs review"
            },
            escape(&artifact.body),
            escape(&artifact.source_ids.join(", "))
        ));
        if !artifact.unsupported_claims.is_empty() {
            body.push_str("<h3>Claims requiring verification</h3><ul>");
            for claim in &artifact.unsupported_claims {
                body.push_str(&format!("<li>{}</li>", escape(claim)));
            }
            body.push_str("</ul>");
        }
        if matches!(stage, "outline" | "draft")
            && artifact.approved_at.is_none()
            && latest(r, stage).is_some_and(|a| a.id == artifact.id)
            && (stage != "draft" || draft_current(r, artifact))
        {
            body.push_str(&button_form(
                &format!("{base}/approve/{}", artifact.id),
                if stage == "outline" {
                    "Approve this outline"
                } else {
                    "I reviewed the draft and approve export"
                },
                &fence(r.number),
            ));
        }
        if matches!(stage, "outline" | "draft")
            && latest(r, stage).is_some_and(|a| a.id == artifact.id)
            && (stage != "draft" || draft_current(r, artifact))
        {
            body.push_str(&format!("<details><summary>Edit this {}</summary><p>Saving creates a new version that needs review.</p><form method=\"post\" action=\"{base}/edit/{}\">{}{}<button>Save edited version</button></form></details>",escape(stage),artifact.id,fence(r.number),textarea("body","Copy",&artifact.body)));
        }
        body.push_str("</article>");
    }
}

pub(super) async fn research_page(State(app): State<App>) -> web::Result<Response> {
    let mut body="<p class=\"eyebrow\">Content Research</p><h1>Keep up with the people shaping your field.</h1><p>Watch a public name or subject. Each finite run saves its sources and a research report. Pause a watch without losing its history.</p><div class=\"grid\"><section><h2>Add a watch</h2><form method=\"post\" action=\"/research/watches\">".to_owned();
    body.push_str(&input("name", "Person or subject", ""));
    body.push_str(&input("query", "Public research query", ""));
    body.push_str(
        "<button>Add watch</button></form></section><section><h2>Watched people and subjects</h2>",
    );
    let watches = app.db.list::<Watch>("content.watch").await?;
    let has_active_watch = watches.iter().any(|watch| !watch.paused);
    if watches.is_empty() {
        body.push_str("<p>No watches yet.</p>");
    }
    for watch in watches {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>{} · {}</p>{}</article>",
            escape(&watch.name),
            escape(&watch.query),
            if watch.paused { "Paused" } else { "Active" },
            button_form(
                &format!("/research/watches/{}/toggle", watch.id),
                if watch.paused { "Resume" } else { "Pause" },
                ""
            )
        ));
    }
    body.push_str(&ready_button_form(
        "/research/run",
        "Research active watches",
        "",
        (!has_active_watch).then_some("Add or resume a watch before running research."),
    ));
    body.push_str("<p><a href=\"/settings\">Configure recurring research in Settings</a></p></section></div><section><h2>Durable reports</h2>");
    for report in app.db.list::<Report>("content.report").await? {
        body.push_str(&format!(
            "<article><a href=\"/research/reports/{}\">{}</a><p>{} · {} sources</p></article>",
            report.id,
            escape(&report.person_name),
            escape(&report.created_at),
            report.evidence.len()
        ));
    }
    body.push_str("</section><p><a href=\"/youtube\">YouTube channel trends →</a></p>");
    Ok(web::page("Content Research", body))
}

pub(super) async fn report_page(
    State(app): State<App>,
    Path(id): Path<String>,
) -> web::Result<Response> {
    uuid_path(&id)?;
    let report = app
        .db
        .get::<Report>("content.report", &id)
        .await?
        .ok_or_else(|| web::Error::not_found("Report not found."))?;
    let mut body = format!(
        "<a href=\"/research\">← Research</a><h1>{}</h1><p>{} · {}</p><pre>{}</pre>",
        escape(&report.person_name),
        escape(&report.created_at),
        escape(&report.artifact.model),
        escape(&report.artifact.body)
    );
    if !report.artifact.unsupported_claims.is_empty() {
        body.push_str("<h2>Open questions and unsupported claims</h2><ul>");
        for claim in &report.artifact.unsupported_claims {
            body.push_str(&format!("<li>{}</li>", escape(claim)));
        }
        body.push_str("</ul>");
    }
    body.push_str("<h2>Captured public sources</h2>");
    for evidence in report.evidence {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>{}</p>",
            escape(&evidence.title),
            escape(&evidence.id)
        ));
        if let Some(url) = evidence.url {
            body.push_str(&format!("<a href=\"{}\">Open source</a>", escape(&url)));
        }
        body.push_str(&format!("<pre>{}</pre></article>", escape(&evidence.text)));
    }
    Ok(web::page(&report.person_name, body))
}

pub(super) async fn youtube_page(State(app): State<App>) -> web::Result<Response> {
    let mut body="<p class=\"eyebrow\">Content Research / YouTube</p><h1>Observe channel momentum.</h1><p>Measurements are saved exactly as observed. Missing days stay missing. Changes compare with the latest observation at least 7 or 30 days earlier.</p><section><h2>Watch a channel</h2><form method=\"post\" action=\"/youtube/channels\">".to_owned();
    body.push_str(&input("id", "Stable channel ID (UC…)", ""));
    body.push_str(&input("title", "Channel label", ""));
    body.push_str("<button>Add channel</button></form>");
    let observations = app.db.list::<Observation>("content.observation").await?;
    for channel in app.db.list::<Channel>("content.channel").await? {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>{} · {}</p>{}",
            escape(&channel.title),
            escape(&channel.id),
            if channel.paused { "Paused" } else { "Active" },
            button_form(
                &format!("/youtube/channels/{}/toggle", channel.id),
                if channel.paused { "Resume" } else { "Pause" },
                ""
            )
        ));
        let mut rows: Vec<_> = observations
            .iter()
            .filter(|o| o.channel_id == channel.id)
            .collect();
        rows.sort_by(|a, b| a.measured_at.cmp(&b.measured_at));
        if let Some(last) = rows.last() {
            let current = observed_total(&last.data);
            let measurement_label = if last.data.get("view_count").is_some_and(|v| !v.is_null()) {
                "channel lifetime views"
            } else {
                "views across observed uploads"
            };
            body.push_str(&format!("<p>{current} {measurement_label} · measured {}</p><p>Video coverage: {}. Channel totals use lifetime channel views when available. Upload-only changes require the same observed video set.</p><table><thead><tr><th>Window</th><th>Change</th></tr></thead><tbody>",escape(&last.measured_at),escape(last.data.get("coverage").and_then(Value::as_str).unwrap_or("saved uploads"))));
            for days in [7, 30] {
                let change = delta(&rows, days)
                    .map_or_else(|| "Not enough history".into(), |n| format!("{n:+}"));
                body.push_str(&format!("<tr><td>{days} days</td><td>{change}</td></tr>"));
            }
            body.push_str("</tbody></table><details><summary>Latest observed videos</summary><table><thead><tr><th>Video</th><th>Views</th></tr></thead><tbody>");
            if let Some(videos) = last.data.get("videos").and_then(Value::as_array) {
                for video in videos {
                    let video_id = video.get("id").and_then(Value::as_str).unwrap_or("");
                    let title = video
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Untitled");
                    body.push_str(&format!("<tr><td><a href=\"https://www.youtube.com/watch?v={}\">{}</a></td><td>{}</td></tr>",escape(video_id),escape(title),count(video.get("views"))));
                }
            }
            body.push_str("</tbody></table></details><details><summary>Measurement history</summary><table><thead><tr><th>Measured at</th><th>Observed views</th></tr></thead><tbody>");
            for row in rows {
                body.push_str(&format!(
                    "<tr><td>{}</td><td>{}</td></tr>",
                    escape(&row.measured_at),
                    observed_total(&row.data)
                ));
            }
            body.push_str("</tbody></table></details>");
        } else {
            body.push_str(
                "<p>No observations. Connect YouTube in Settings and record a measurement.</p>",
            );
        }
        body.push_str("</article>");
    }
    body.push_str(&button_form(
        "/youtube/run",
        "Record channel observations",
        "",
    ));
    body.push_str(
        "<p><a href=\"/settings\">Configure recurring measurements in Settings</a></p></section>",
    );
    Ok(web::page("YouTube Trends", body))
}
