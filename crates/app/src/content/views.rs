//! Server-rendered content development, research, and trend views.
//!
//! Architecture review card 6: a view is a pure function of the records its
//! handler loaded, so its interface states every input a page renders and no
//! view can read the store behind the handler's back.
use super::*;

fn ready_button_form(action: &str, label: &str, hidden: &str, blocked: Option<&str>) -> String {
    match blocked {
        None => web::button_form(action, label, hidden),
        Some(reason) => {
            let hint = escape(&format!("ready{}", action.replace('/', "-")));
            format!(
                "<form method=\"post\" action=\"{}\">{}<button class=\"btn-primary\" disabled aria-describedby=\"{hint}\">{}</button><p id=\"{hint}\">{}</p></form>",
                escape(action),
                hidden,
                escape(label),
                escape(reason)
            )
        }
    }
}

pub(super) fn home(
    brand: Option<Brand>,
    sources: &[Source],
    opportunities: &[Opportunity],
    projects: &[Project],
) -> Response {
    let mut body="<p class=\"eyebrow\">Content Engine</p><h1>Build from evidence. Publish with intent.</h1><p>Shape a voice, discover useful angles, and carry each idea through reviewed evidence, an outline, and a finished draft.</p><div class=\"grid\"><section id=\"brand-profile\">".to_owned();
    let configured = brand.is_some();
    if let Some(b) = &brand {
        let active = sources.iter().filter(|s| !s.paused).count();
        body.push_str(&format!(
            "<details><summary>Brand: {} · Revision {} · {} · Edit</summary>",
            escape(&b.name),
            b.revision,
            web::pluralize(active, "active source", "active sources")
        ));
    }
    body.push_str("<h2>Brand profile</h2><form method=\"post\" action=\"/content/brand\">");
    body.push_str(&format!(
        "<input type=\"hidden\" name=\"revision\" value=\"{}\">",
        brand.as_ref().map_or(0, |b| b.revision)
    ));
    body.push_str(&web::field(
        "Brand name",
        "name",
        brand.as_ref().map_or("", |b| &b.name),
        "text",
        None,
        true,
    ));
    body.push_str(&web::field(
        "Who you serve",
        "audience",
        brand.as_ref().map_or("", |b| &b.audience),
        "text",
        None,
        true,
    ));
    body.push_str(&web::textarea(
        "Voice and positioning",
        "voice",
        brand.as_ref().map_or("", |b| &b.voice),
    ));
    body.push_str(&web::textarea(
        "Constraints and topics to avoid",
        "boundaries",
        brand.as_ref().map_or("", |b| &b.boundaries),
    ));
    body.push_str(&web::textarea(
        "Your approved examples, facts, and evidence",
        "evidence",
        brand.as_ref().map_or("", |b| &b.evidence),
    ));
    body.push_str("<button class=\"btn-primary\">Save brand revision</button></form>");
    if let Some(brand) = brand {
        body.push_str(&format!(
            "<p>Revision {} · {}</p>",
            brand.revision,
            web::timestamp(&brand.updated_at)
        ));
    }
    if configured {
        body.push_str("</details>");
    }
    body.push_str("</section><section>");
    if configured {
        body.push_str("<details><summary>Source watchlist · Edit sources</summary>");
    }
    body.push_str("<h2>Source watchlist</h2><p>Public pages and feeds are collected only when you run Scout or enable a schedule.</p><form method=\"post\" action=\"/content/sources\">");
    body.push_str(&web::field("Source label", "label", "", "text", None, true));
    body.push_str(&web::field(
        "Public URL or feed",
        "url",
        "",
        "text",
        None,
        true,
    ));
    body.push_str("<button class=\"btn-primary\">Add source</button></form>");
    for source in sources {
        body.push_str(&format!(
            "<article><a href=\"{}\">{}</a> · {}{}</article>",
            escape(&source.url),
            escape(&source.label),
            if source.paused { "Paused" } else { "Active" },
            web::button_form(
                &format!("/content/sources/{}/toggle", source.id),
                if source.paused { "Resume" } else { "Pause" },
                ""
            )
        ));
    }
    if configured {
        body.push_str("</details>");
    }
    body.push_str(&web::button_form(
        "/content/scout",
        "Scout opportunities",
        "",
    ));
    body.push_str("</section></div><section><h2>Opportunity shortlist</h2>");
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
            web::badge(&opportunity.state),
            opportunity.brand.revision
        ));
        if let Some(project_id) = &opportunity.project_id {
            body.push_str(&format!(
                "<a href=\"/content/projects/{project_id}\">Open project</a>"
            ));
        } else if opportunity.state == "shortlisted" {
            body.push_str(&web::button_form(
                &format!("/content/opportunities/{}/select", opportunity.id),
                "Develop this idea",
                "",
            ));
            body.push_str(&web::button_form(
                &format!("/content/opportunities/{}/skip", opportunity.id),
                "Skip",
                "",
            ));
        }
        for evidence in &opportunity.evidence {
            if let Some(url) = &evidence.url {
                body.push_str(&format!(
                    "<p><a href=\"{}\">{}</a></p>",
                    escape(url),
                    escape(&evidence.title)
                ));
            }
        }
        body.push_str("</article>");
    }
    body.push_str("</section><section><h2>Content projects</h2>");
    for project in projects {
        let rev = project.current();
        body.push_str(&format!(
            "<article><a href=\"/content/projects/{}\">{}</a><p>{} · Revision {}</p></article>",
            project.id,
            escape(&rev.subject),
            escape(&web::display_label(&rev.target)),
            rev.number
        ));
    }
    body.push_str("<details><summary>Start a project from your own idea</summary><form method=\"post\" action=\"/content/projects\">");
    body.push_str(&project_form(None));
    body.push_str(
        "<button class=\"btn-primary\">Create project</button></form></details></section>",
    );
    web::page("Content Engine", web::Body::with_heading(body))
}

fn project_form(rev: Option<&Revision>) -> String {
    let mut body = web::field(
        "Topic or subject",
        "subject",
        rev.map_or("", |r| &r.subject),
        "text",
        None,
        true,
    );
    body.push_str(&web::field(
        "What should this piece accomplish?",
        "objective",
        rev.map_or("", |r| &r.objective),
        "text",
        None,
        true,
    ));
    body.push_str(&web::field(
        "Audience",
        "audience",
        rev.map_or("", |r| &r.audience),
        "text",
        None,
        true,
    ));
    body.push_str("<label>Publication format<select name=\"target\">");
    body.push_str(&web::value_options(
        TARGETS,
        rev.map_or("", |r| &r.target),
        "",
    ));
    body.push_str("</select></label>");
    body.push_str(&web::textarea(
        "Your original material and constraints",
        "material",
        rev.map_or("", |r| &r.material),
    ));
    if let Some(r) = rev {
        body.push_str(&web::revision_input(r.number));
    }
    body
}

pub(super) fn project_page(project: &Project, has_brand: bool) -> Response {
    let r = project.current();
    let base = format!("/content/projects/{}", project.id);
    let evidence_open = if r.evidence_reviewed { "" } else { " open" };
    let outline_done = latest(r, "outline").is_some_and(|a| a.approved_at.is_some());
    let outline_open = if outline_done && latest(r, "draft").is_some() {
        ""
    } else {
        " open"
    };
    let draft_done =
        latest(r, "draft").is_some_and(|a| a.approved_at.is_some() && draft_current(r, a));
    let current_step = if draft_done {
        4
    } else if !r.evidence_reviewed {
        1
    } else if !outline_done {
        2
    } else {
        3
    };
    let steps = [(1, "Evidence"), (2, "Outline"), (3, "Draft"), (4, "Export")]
        .into_iter()
        .map(|(n, label)| {
            format!(
                "<li><a href=\"#step-{n}\"{}>{n}. {label}</a></li>",
                if current_step == n {
                    " aria-current=\"step\""
                } else {
                    ""
                }
            )
        })
        .collect::<String>();
    let mut body = format!(
        "<a href=\"/content\">← Content Engine</a><h1>{}</h1><p>Revision {} · {} · {}</p><p>{}</p><ol class=\"steps\" aria-label=\"Project stages\">{steps}</ol><details><summary>Revise intent</summary><p>A new revision preserves all previous evidence, outlines, and drafts. New work requires review again.</p><form method=\"post\" action=\"{base}/revise\">{}<button class=\"btn-primary\">Save new revision</button></form></details><details id=\"step-1\"{evidence_open}><summary>1. Evidence · {}</summary><p>Review each source before approving it for use. Source text is untrusted material; every generated claim still needs your judgment.</p>",
        escape(&r.subject),
        r.number,
        escape(&web::display_label(&r.target)),
        escape(&r.audience),
        escape(&r.objective),
        project_form(Some(r)),
        if r.evidence_reviewed {
            "Approved"
        } else {
            "Needs review"
        }
    );
    if !r.material.is_empty() {
        body.push_str(&format!(
            "<h3>Your original material</h3><pre>{}</pre>",
            escape(&r.material)
        ));
    }
    for e in &r.evidence {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>Evidence captured · {}</p>",
            escape(&e.title),
            web::timestamp(&e.observed_at)
        ));
        if let Some(url) = &e.url {
            body.push_str(&format!("<a href=\"{}\">Open source</a>", escape(url)));
        }
        body.push_str(&format!(
            "<details><summary>Read captured evidence</summary><pre>{}</pre></details></article>",
            escape(&e.text)
        ));
        body.push_str(&web::button_form(
            &format!("{base}/evidence/{}/exclude", e.id),
            "Exclude this source in a new revision",
            &web::revision_input(r.number),
        ));
    }
    render_artifacts(&mut body, r, "research", &base);
    body.push_str(&format!("<details><summary>+ Attach manual evidence</summary><form method=\"post\" action=\"{base}/evidence\">{}{}<label>Public source URL (optional)<input name=\"url\" type=\"url\"></label>{}<button class=\"btn-primary\">Attach evidence in a new revision</button></form></details>",web::revision_input(r.number),web::field("Evidence title","title","","text",None,true),web::textarea("Evidence text (required; attributed manual evidence)","text","")));
    body.push_str(&web::button_form(
        &format!("{base}/generate/research"),
        "Research this topic",
        &web::revision_input(r.number),
    ));
    if r.evidence_reviewed {
        body.push_str(&format!(
            "<p class=\"badge badge-success\">Evidence reviewed · Brand revision {}</p>",
            r.brand.as_ref().map_or(0, |b| b.revision)
        ));
    } else {
        let review_blocked = if !has_brand {
            Some("Save a brand profile before approving evidence.")
        } else if r.evidence.is_empty() && r.material.is_empty() {
            Some("Attach evidence or add original material before approving evidence.")
        } else {
            None
        };
        body.push_str(&ready_button_form(
            &format!("{base}/review"),
            "I reviewed this evidence and approve it for generation",
            &web::revision_input(r.number),
            review_blocked,
        ));
        if !has_brand {
            body.push_str("<p><a href=\"/content#brand-profile\">Set up your brand profile</a>, then return to this project to approve its evidence.</p>");
        }
    }
    body.push_str(&format!(
        "</details><details id=\"step-2\"{outline_open}><summary>2. Outline · {}</summary>",
        if outline_done {
            "Approved"
        } else {
            "Needs review"
        }
    ));
    body.push_str(&ready_button_form(
        &format!("{base}/generate/outline"),
        "Generate outline",
        &web::revision_input(r.number),
        (!r.evidence_reviewed)
            .then_some("Review and approve the evidence in step 1 to generate an outline."),
    ));
    render_artifacts(&mut body, r, "outline", &base);
    body.push_str("</details><section id=\"step-3\"><h2>3. Draft</h2><p>Approve the latest outline to generate a draft. Review its claims before approving export.</p>");
    body.push_str(&ready_button_form(
        &format!("{base}/generate/draft"),
        "Generate draft",
        &web::revision_input(r.number),
        if !r.evidence_reviewed {
            Some("Review and approve the evidence in step 1, then approve an outline in step 2.")
        } else if !latest(r, "outline").is_some_and(|a| a.approved_at.is_some()) {
            Some("Generate and approve the latest outline in step 2 to generate a draft.")
        } else {
            None
        },
    ));
    if latest(r, "draft").is_some_and(|a| a.approved_at.is_some() && draft_current(r, a)) {
        body.push_str(&format!(
            "<a id=\"step-4\" class=\"button btn-primary\" href=\"{base}/export\">Download reviewed draft</a>"
        ));
    }
    render_artifacts(&mut body, r, "draft", &base);
    body.push_str("</section><details><summary>Revision history</summary>");
    for revision in &project.revisions {
        body.push_str(&format!(
            "<article><h3>Revision {} · {}</h3><p>{} · {} · {} generated versions</p>",
            revision.number,
            web::timestamp(&revision.created_at),
            escape(&revision.subject),
            web::pluralize(revision.evidence.len(), "evidence item", "evidence items"),
            revision.artifacts.len()
        ));
        for artifact in &revision.artifacts {
            body.push_str(&format!(
                "<details><summary>{} · {}</summary><div class=\"prose\">{}</div></details>",
                escape(&web::display_label(&artifact.stage)),
                web::timestamp(&artifact.created_at),
                web::markdown(&artifact.body)
            ));
        }
        body.push_str("</article>");
    }
    body.push_str("</details>");
    web::page(&r.subject, web::Body::with_heading(body))
}

fn render_artifacts(body: &mut String, r: &Revision, stage: &str, base: &str) {
    for artifact in r.artifacts.iter().filter(|a| a.stage == stage) {
        body.push_str(&format!(
            "<article><p>{} · {} · {}</p><div class=\"prose\">{}</div><p>Cited evidence: {}</p>",
            web::timestamp(&artifact.created_at),
            escape(&artifact.model),
            web::badge(if artifact.approved_at.is_some() {
                "Approved"
            } else {
                "Needs review"
            }),
            web::markdown(&artifact.body),
            escape(
                &artifact
                    .source_ids
                    .iter()
                    .filter_map(|id| r
                        .evidence
                        .iter()
                        .find(|e| &e.id == id)
                        .map(|e| e.title.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        ));
        if let Some(coverage) = &artifact.search_coverage {
            body.push_str(&web::search_coverage(coverage));
        }
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
            body.push_str(&web::button_form(
                &format!("{base}/approve/{}", artifact.id),
                if stage == "outline" {
                    "Approve this outline"
                } else {
                    "I reviewed the draft and approve export"
                },
                &web::revision_input(r.number),
            ));
        }
        if matches!(stage, "outline" | "draft")
            && latest(r, stage).is_some_and(|a| a.id == artifact.id)
            && (stage != "draft" || draft_current(r, artifact))
        {
            body.push_str(&format!("<details><summary>Edit this {}</summary><p>Saving creates a new version that needs review.</p><form method=\"post\" action=\"{base}/edit/{}\">{}{}<button class=\"btn-primary\">Save edited version</button></form></details>",escape(stage),artifact.id,web::revision_input(r.number),web::textarea("Copy","body",&artifact.body)));
        }
        body.push_str("</article>");
    }
}

pub(super) fn research_page(watches: &[Watch], reports: &[Report]) -> Response {
    let mut body="<p class=\"eyebrow\">Content Research</p><h1>Keep up with the people shaping your field.</h1><p>Watch a public name or subject. Each finite run saves its sources and a research report. Pause a watch without losing its history.</p><div class=\"grid\"><section><h2>Add a watch</h2><form method=\"post\" action=\"/research/watches\">".to_owned();
    body.push_str(&web::field(
        "Person or subject",
        "name",
        "",
        "text",
        None,
        true,
    ));
    body.push_str(&web::field(
        "Public research query",
        "query",
        "",
        "text",
        None,
        true,
    ));
    body.push_str(
        "<button class=\"btn-primary\">Add watch</button></form></section><section><h2>Watched people and subjects</h2>",
    );
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
            web::button_form(
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
    for report in reports {
        body.push_str(&format!(
            "<article><a href=\"/research/reports/{}\">{}</a><p>{} · {}</p></article>",
            report.id,
            escape(&report.person_name),
            web::timestamp(&report.created_at),
            web::pluralize(report.evidence.len(), "source", "sources")
        ));
    }
    body.push_str("</section><p><a href=\"/youtube\">YouTube channel trends →</a></p>");
    web::page("Content Research", web::Body::with_heading(body))
}

pub(super) fn report_page(report: &Report) -> Response {
    let citations = report
        .evidence
        .iter()
        .enumerate()
        .map(|(index, evidence)| web::Citation::numbered(index + 1, &evidence.id))
        .collect::<Vec<_>>();
    let mut body = format!(
        "<a href=\"/research\">← Research</a><h1>{}</h1><p>{} · {}</p><div class=\"prose\">{}</div>",
        escape(&report.person_name),
        web::timestamp(&report.created_at),
        escape(&report.artifact.model),
        web::cited(&web::markdown(&report.artifact.body), &citations)
    );
    if !report.artifact.unsupported_claims.is_empty() {
        body.push_str("<h2>Open questions and unsupported claims</h2><ul>");
        for claim in &report.artifact.unsupported_claims {
            body.push_str(&format!("<li>{}</li>", escape(claim)));
        }
        body.push_str("</ul>");
    }
    body.push_str("<h2>Captured public sources</h2>");
    if let Some(coverage) = &report.search_coverage {
        body.push_str(&web::search_coverage(coverage));
    } else {
        body.push_str("<p>Collection coverage was not recorded for this earlier report.</p>");
    }
    for (evidence, citation) in report.evidence.iter().zip(&citations) {
        body.push_str(&format!(
            "<article id=\"{}\"><h3>{} {}</h3><details><summary>Source identifier</summary><p>{}</p></details>",
            citation.anchor(),
            citation.text(),
            escape(&evidence.title),
            escape(&evidence.id)
        ));
        if let Some(url) = &evidence.url {
            body.push_str(&format!("<a href=\"{}\">Open source</a>", escape(url)));
        }
        body.push_str(&format!("<pre>{}</pre></article>", escape(&evidence.text)));
    }
    web::page(&report.person_name, web::Body::with_heading(body))
}

pub(super) fn youtube_page(channels: &[Channel], observations: &[Observation]) -> Response {
    let mut body="<p class=\"eyebrow\">Content Research / YouTube</p><h1>Observe channel momentum.</h1><p>Measurements are saved exactly as observed. Missing days stay missing. Changes compare with the latest observation at least 7 or 30 days earlier.</p><section><h2>Watch a channel</h2><form method=\"post\" action=\"/youtube/channels\">".to_owned();
    body.push_str(&web::field(
        "Stable channel ID (UC…)",
        "id",
        "",
        "text",
        None,
        true,
    ));
    body.push_str(&web::field(
        "Channel label",
        "title",
        "",
        "text",
        None,
        true,
    ));
    body.push_str("<button class=\"btn-primary\">Add channel</button></form>");
    for channel in channels {
        body.push_str(&format!(
            "<article><h3>{}</h3><p>{} · {}</p>{}",
            escape(&channel.title),
            escape(&channel.id),
            if channel.paused { "Paused" } else { "Active" },
            web::button_form(
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
            body.push_str(&format!("<p>{} {measurement_label} · measured {}</p><p>Video coverage: {}. Channel totals use lifetime channel views when available. Upload-only changes require the same observed video set.</p><table><thead><tr><th>Window</th><th>Change</th></tr></thead><tbody>",web::number(current),web::timestamp(&last.measured_at),escape(last.data.get("coverage").and_then(Value::as_str).unwrap_or("saved uploads"))));
            for days in [7, 30] {
                let change = delta(&rows, days).map_or_else(
                    || "Not enough history".into(),
                    |n| format!("{}{}", if n >= 0 { "+" } else { "" }, web::number(n)),
                );
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
                    body.push_str(&format!("<tr><td><a href=\"https://www.youtube.com/watch?v={}\">{}</a></td><td>{}</td></tr>",escape(video_id),escape(title),web::number(count(video.get("views")))));
                }
            }
            body.push_str("</tbody></table></details><details><summary>Measurement history</summary><table><thead><tr><th>Measured at</th><th>Observed views</th></tr></thead><tbody>");
            for row in rows {
                body.push_str(&format!(
                    "<tr><td>{}</td><td>{}</td></tr>",
                    web::timestamp(&row.measured_at),
                    web::number(observed_total(&row.data))
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
    body.push_str(&web::button_form(
        "/youtube/run",
        "Record channel observations",
        "",
    ));
    body.push_str(
        "<p><a href=\"/settings\">Configure recurring measurements in Settings</a></p></section>",
    );
    web::page("YouTube Trends", web::Body::with_heading(body))
}
