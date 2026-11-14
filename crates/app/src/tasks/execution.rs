use super::routes::segment;
use super::*;

/// A durable uncertainty marker is written before remote create; crashes and
/// network timeouts cannot silently retry an ambiguous create.
pub async fn execute(app: &App, job: &work::Job) -> anyhow::Result<Value> {
    let snapshot: Task = serde_json::from_value(job.input["task"].clone())?;
    let provider = job.input["provider"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Provider missing"))?
        .to_owned();
    let container = job.input["container"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Container missing"))?
        .to_owned();
    if provider == "google" {
        anyhow::ensure!(
            snapshot.notes.chars().count() <= 8192,
            "Google Tasks notes support at most 8192 characters; shorten the local notes before delivery"
        );
    }
    let current = app
        .db()
        .get::<Task>("task", &snapshot.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Task missing"))?;
    anyhow::ensure!(
        !current.trashed && current.version == snapshot.version,
        "Task changed before remote delivery; enqueue again"
    );
    anyhow::ensure!(
        !current
            .links
            .iter()
            .any(|l| l.provider == provider && l.state == "uncertain"),
        "Previous remote create needs reconciliation"
    );
    let google_binding = if provider == "google" {
        Some(
            serde_json::from_value::<crate::integrations::GoogleBinding>(
                job.input["_google_binding"].clone(),
            )?,
        )
    } else {
        None
    };
    let delivery_binding = google_binding.clone();
    if let Some(binding) = &google_binding
        && let Some(link) = current.links.iter().find(|link| link.provider == "google")
    {
        anyhow::ensure!(
            binding.subject.is_some()
                && link
                    .google_binding
                    .as_ref()
                    .and_then(|b| b.subject.as_ref())
                    == binding.subject.as_ref(),
            "Task link belongs to another Google account; reconnect its owner before delivery"
        );
    }
    // Read-only preflight keeps missing credentials and container failures
    // retryable before any create can reach the provider.
    if provider == "google" {
        crate::integrations::google_get(
            app,
            &format!(
                "https://tasks.googleapis.com/tasks/v1/users/@me/lists/{}",
                segment(&container)
            ),
            &[],
        )
        .await?;
    } else if provider == "asana" {
        crate::integrations::asana_get(
            app,
            &format!(
                "https://app.asana.com/api/1.0/projects/{}",
                segment(&container)
            ),
            &[],
        )
        .await?;
    } else {
        anyhow::bail!("Unknown task provider");
    }
    let id = snapshot.id.clone();
    let p = provider.clone();
    let c = container.clone();
    let version = snapshot.version;
    let remote_id = app
        .db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            anyhow::ensure!(
                !t.trashed && t.version == version,
                "Task changed before remote delivery; enqueue again"
            );
            if let Some(l) = t.links.iter_mut().find(|l| l.provider == p) {
                anyhow::ensure!(l.container == c, "Task already links to another container");
                anyhow::ensure!(p != "google" || l.google_binding.as_ref().and_then(|b| b.subject.as_ref()) == google_binding.as_ref().and_then(|b| b.subject.as_ref()),
                    "Task link belongs to another Google connection; resolve work in the original account before delivering a new local task");
                anyhow::ensure!(
                    l.state != "uncertain",
                    "Previous remote create needs reconciliation"
                );
                if l.synced_version == Some(version) {
                    return Ok(Some((l.remote_id.clone(), true)));
                }
                if l.remote_id.is_some() {
                    return Ok(Some((l.remote_id.clone(), false)));
                }
                l.state = "uncertain".into();
                l.error = Some(
                    "Create started; confirm remote outcome before retrying if interrupted.".into(),
                );
                store::put(tx, "task", &id, &t)?;
                return Ok(None);
            }
            t.links.push(ExternalLink {
                provider: p,
                container: c,
                remote_id: None,
                state: "uncertain".into(),
                error: Some(
                    "Create started; confirm remote outcome before retrying if interrupted.".into(),
                ),
                synced_version: None,
                google_binding,
            });
            store::put(tx, "task", &id, &t)?;
            Ok(None)
        })
        .await?;
    if matches!(remote_id, Some((_, true))) {
        return Ok(json!({"task_id":snapshot.id,"already_synced":true}));
    }
    let existing = remote_id.and_then(|(id, _)| id);
    let body = if provider == "google" {
        let mut body = json!({"title":snapshot.title,"notes":snapshot.notes,"status":if snapshot.status=="done"{"completed"}else{"needsAction"}});
        if let Some(due) = &snapshot.due {
            body["due"] = json!(format!("{due}T00:00:00Z"));
        } else {
            body["due"] = Value::Null;
        }
        body
    } else {
        let mut body = json!({"data":{"name":snapshot.title,"notes":snapshot.notes,"completed":snapshot.status=="done","due_on":snapshot.due}});
        if existing.is_none() {
            body["data"]["projects"] = json!([container.clone()]);
        }
        body
    };
    let result = if provider == "google" {
        let base = format!(
            "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks",
            segment(&container)
        );
        if let Some(id) = &existing {
            crate::integrations::google_patch(app, &format!("{base}/{}", segment(id)), &body).await
        } else {
            crate::integrations::google_post(app, &base, &body).await
        }
    } else if provider == "asana" {
        if let Some(id) = &existing {
            crate::integrations::asana_put(
                app,
                &format!("https://app.asana.com/api/1.0/tasks/{}", segment(id)),
                &body,
            )
            .await
        } else {
            crate::integrations::asana_post(app, "https://app.asana.com/api/1.0/tasks", &body).await
        }
    } else {
        anyhow::bail!("Unknown task provider")
    };
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            record_link_error(app, &snapshot.id, &provider, &error.to_string()).await?;
            return Err(error);
        }
    };
    let remote = value
        .get("id")
        .or_else(|| value.pointer("/data/gid"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or(existing)
        .ok_or_else(|| {
            anyhow::anyhow!("Remote response has no task ID; reconcile before retrying")
        })?;
    let id = snapshot.id.clone();
    app.db()
        .transaction(move |tx| {
            let mut t: Task = store::get(tx, "task", &id)?
                .ok_or_else(|| anyhow::anyhow!("Local task missing"))?;
            let l = t
                .links
                .iter_mut()
                .find(|l| l.provider == provider)
                .ok_or_else(|| anyhow::anyhow!("Delivery marker missing"))?;
            l.remote_id = Some(remote);
            l.state = "linked".into();
            l.error = None;
            l.synced_version = Some(version);
            l.google_binding = delivery_binding;
            store::put(tx, "task", &id, &t)
        })
        .await?;
    Ok(
        json!({"task_id":snapshot.id,"synced_version":version,"url":format!("/tasks/{}",snapshot.id)}),
    )
}
async fn record_link_error(app: &App, id: &str, provider: &str, error: &str) -> anyhow::Result<()> {
    let (id, provider, error) = (id.to_owned(), provider.to_owned(), error.to_owned());
    app.db()
        .transaction(move |tx| {
            let mut t: Task =
                store::get(tx, "task", &id)?.ok_or_else(|| anyhow::anyhow!("Task missing"))?;
            if let Some(l) = t.links.iter_mut().find(|l| l.provider == provider) {
                l.error = Some(error);
                if l.remote_id.is_some() {
                    l.state = "update_failed".into();
                }
            }
            store::put(tx, "task", &id, &t)
        })
        .await
}
