//! Identity review never moves or merges evidence. Each source stays with
//! the attributed subject, which makes a mistaken operator decision reversible.

use super::{active, enabled};
use crate::{
    App,
    people::Person,
    store,
    web::{Error, Result},
};
use axum::{
    extract::{Form, Path, State},
    response::Redirect,
};
use serde::{Deserialize, Serialize};

const DECISION: &str = "people_terminal_identity_decision";
#[derive(Serialize, Deserialize)]
struct Decision {
    id: String,
    person_id: String,
    person_ids: Vec<String>,
    duplicate: String,
    actor: String,
    reason: String,
    state: String,
    at: i64,
    supersedes: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Review {
    duplicate: String,
    version: u64,
    action: String,
    reason: String,
}

pub(crate) async fn review(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<Review>,
) -> Result<Redirect> {
    enabled(&app)?;
    if id == form.duplicate {
        return Err(Error::bad_request("Choose a different identity."));
    }
    let reason = match form.reason.as_str() {
        "profile" => "Reviewed matching official profile identifier",
        "distinct" => "Reviewed distinguishers establish separate identities",
        "unclear" => "Distinguishing evidence is not settled",
        _ => return Err(Error::bad_request("Choose an identity review reason.")),
    };
    let target = id.clone();
    app.db().transaction(move|tx|{
        let mut a=store::get::<Person>(tx,"person",&id)?.filter(active).ok_or_else(||anyhow::anyhow!("Canonical person unavailable"))?;
        let mut b=store::get::<Person>(tx,"person",&form.duplicate)?.ok_or_else(||anyhow::anyhow!("Second person unavailable"))?;
        anyhow::ensure!(a.version==form.version,"Identity changed; reload first");
        let pair=super::key(&(&a.id,&b.id))?;
        let last=store::get::<Decision>(tx,DECISION,&pair)?;
        let state=match form.action.as_str(){
            "merge"=>{
                anyhow::ensure!(active(&b)&&reason.starts_with("Reviewed matching")&&!a.profile_url.is_empty()
                    &&super::corpus::canonical_url(&a.profile_url).is_some_and(|url|super::corpus::canonical_url(&b.profile_url).as_ref()==Some(&url)),
                    "A reviewed, shared professional profile URL is required before merging identities");
                b.merged_into=Some(a.id.clone());b.archived=true;
                "same"
            }
            "split"=>{
                anyhow::ensure!(b.merged_into.as_ref()==Some(&a.id)&&last.as_ref().is_some_and(|d|d.state=="same"),
                    "Only a reviewed People Terminal merge can be split here");
                b.merged_into=None;b.archived=false;
                "undecided"
            }
            "reject"=>{
                anyhow::ensure!(active(&b),"Split the previous merge before marking identities distinct");
                "different"
            }
            "reopen"=>{
                anyhow::ensure!(active(&b),"Split the previous merge before reopening review");
                "undecided"
            }
            _=>anyhow::bail!("Unknown identity decision"),
        };
        a.version+=1;
        b.version+=1;
        let at=crate::now_ms();
        a.updated_at=at;b.updated_at=at;
        let decision=Decision{id:uuid::Uuid::new_v4().to_string(),person_id:a.id.clone(),person_ids:vec![a.id.clone(),b.id.clone()],duplicate:b.id.clone(),
            actor:"Workspace operator".into(),reason:reason.into(),state:state.into(),at,supersedes:last.map(|d|d.id)};
        store::put(tx,"person",&a.id,&a)?;
        store::put(tx,"person",&b.id,&b)?;
        store::put(tx,DECISION,&pair,&decision)
    }).await.map_err(|e|Error::conflict(e.to_string()))?;
    Ok(Redirect::to(&format!(
        "/terminal/people/{target}?view=history"
    )))
}

pub(super) fn history(
    tx: &rusqlite::Connection,
    person: &str,
) -> anyhow::Result<Vec<(String, String, String)>> {
    let mut stmt=tx.prepare("SELECT json_extract(body,'$.duplicate'),json_extract(body,'$.state'),json_extract(body,'$.reason')
        FROM revision WHERE kind=?1 AND json_extract(body,'$.person_id')=?2 ORDER BY at_ms DESC,revision DESC LIMIT 30")?;
    Ok(stmt
        .query_map([DECISION, person], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}
