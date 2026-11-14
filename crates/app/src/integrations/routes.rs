use super::*;

pub fn router() -> Router<App> {
    Router::new()
        .route("/google/connect", get(connect))
        .route("/google/callback", get(callback))
        .route("/google/disconnect", axum::routing::post(disconnect))
}
fn redirect_uri(app: &App) -> String {
    format!("http://localhost:{}/google/callback", app.cfg().port)
}
async fn connect(State(app): State<App>) -> web::Result<Redirect> {
    let config = google_client(&app).await?;
    let state = uuid::Uuid::new_v4().to_string();
    let _guard = TOKEN_LOCK.lock().await;
    let state_id = state.clone();
    app.db()
        .transaction(move |tx| {
            let record = OAuthState {
                expires_at: crate::now_ms() + 600_000,
                binding: GoogleBinding::load(tx)?,
            };
            crate::store::put(tx, "oauth_state", &state_id, &record)
        })
        .await?;
    let mut url =
        url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").expect("Google URL");
    url.query_pairs_mut().extend_pairs(&[("client_id",config.id.as_str()),("redirect_uri",redirect_uri(&app).as_str()),("response_type","code"),("access_type","offline"),("prompt","consent"),("state",state.as_str()),("scope","openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/youtube.readonly")]);
    Ok(Redirect::to(url.as_str()))
}
#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
async fn callback(State(app): State<App>, Query(query): Query<Callback>) -> web::Result<Redirect> {
    let state = query.state.ok_or_else(|| {
        web::Error::bad_request("Google sign-in state is missing. Start again from Settings.")
    })?;
    let binding = app
        .db()
        .transaction(move |tx| {
            let state_record = crate::store::get::<OAuthState>(tx, "oauth_state", &state)?;
            crate::store::purge(tx, "oauth_state", &state)?;
            Ok(state_record
                .filter(|s| s.expires_at > crate::now_ms())
                .filter(|s| GoogleBinding::load(tx).is_ok_and(|current| current == s.binding))
                .map(|s| s.binding))
        })
        .await?;
    let binding = binding.ok_or_else(|| {
        web::Error::bad_request(
            "Google sign-in state is expired or already used. Start again from Settings.",
        )
    })?;
    if query.error.is_some() {
        return Err(web::Error::bad_request(
            "Google sign-in was cancelled. No connection was saved.",
        ));
    }
    let code = query
        .code
        .ok_or_else(|| web::Error::bad_request("Google did not return a sign-in code"))?;
    let config = google_client(&app).await?;
    let value = json_response(
        client()?
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", config.id.as_str()),
                ("client_secret", config.secret.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", redirect_uri(&app).as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google authorization exchange failed"))?,
    )
    .await?;
    let access = value["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Google access token missing"))?;
    let identity = json_response(
        client()?
            .get("https://www.googleapis.com/oauth2/v2/userinfo")
            .bearer_auth(access)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Google identity lookup failed"))?,
    )
    .await?;
    let next_binding = GoogleBinding {
        generation: binding
            .generation
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Google connection generation exhausted"))?,
        subject: Some(
            identity["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Google account subject missing"))?
                .into(),
        ),
    };
    let token = GoogleToken {
        access_token: access.into(),
        refresh_token: value["refresh_token"].as_str().map(ToOwned::to_owned),
        expires_at: crate::now_ms() + value["expires_in"].as_i64().unwrap_or(3600) * 1000,
        email: identity["email"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google account email missing"))?
            .into(),
        binding: next_binding.clone(),
    };
    install_google_token(&app, binding, token).await?;
    Ok(Redirect::to("/settings"))
}
// An exchange may finish after disconnect or another sign-in. Its saved
// starting generation must still own the connection before any cache is written.
pub(super) async fn install_google_token(
    app: &App,
    binding: GoogleBinding,
    token: GoogleToken,
) -> anyhow::Result<()> {
    let next_binding = token.binding.clone();
    let _guard = TOKEN_LOCK.lock().await;
    let old_binding = binding.clone();
    app.db()
        .transaction(move |tx| old_binding.assert_current(tx))
        .await?;
    write_token(app, &token).await?;
    app.db()
        .transaction(move |tx| {
            binding.assert_current(tx)?;
            crate::store::put(tx, "google_connection", "current", &next_binding)?;
            tx.execute("DELETE FROM record WHERE kind='oauth_state'", [])?;
            tx.execute("DELETE FROM revision WHERE kind='oauth_state'", [])?;
            Ok(())
        })
        .await?;
    Ok(())
}
async fn disconnect(State(app): State<App>) -> web::Result<Redirect> {
    let _guard = TOKEN_LOCK.lock().await;
    app.db()
        .transaction(move |tx| {
            let current = GoogleBinding::load(tx)?;
            let next = GoogleBinding {
                generation: current
                    .generation
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("Google connection generation exhausted"))?,
                subject: None,
            };
            crate::store::put(tx, "google_connection", "current", &next)?;
            tx.execute("DELETE FROM record WHERE kind='oauth_state'", [])?;
            tx.execute("DELETE FROM revision WHERE kind='oauth_state'", [])?;
            Ok(())
        })
        .await?;
    // The user asked to disconnect this one credential cache; avoid traversing
    // or clearing any Workspace path and never revoke someone else's session.
    let path = app.cfg().google_token_path.clone();
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::Error::new(e).into()),
    }
    Ok(Redirect::to("/settings"))
}
