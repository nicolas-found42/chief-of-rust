//! Google Workspace connection, skeleton edition: one authenticated call
//! (calendar list) through yup-oauth2's installed flow + the generated
//! google-calendar3 hub. The full connection UX — who owns the callback
//! sink, which scopes, which accounts — is the connection-flow design that
//! sharpens after the Meeting Wizard spec (map fog); this module only makes
//! the crate wiring concrete.
//!
//! Without `GOOGLE_CLIENT_SECRET_PATH` the route renders "not connected";
//! with it, the first visit starts the installed flow on a fixed loopback
//! port (Google requires the exact localhost port to be pre-registered on
//! the OAuth client), and tokens persist under the workspace dir.

use std::path::PathBuf;

use google_calendar3::{hyper_rustls, hyper_util, yup_oauth2};

use crate::Config;

/// The skeleton's Google knobs, sliced off [`Config`] so handlers gate on
/// one thing.
#[derive(Debug, Clone)]
pub struct GoogleCfg {
    pub secret_path: Option<PathBuf>,
    pub token_path: PathBuf,
    pub redirect_port: u16,
}

impl GoogleCfg {
    pub fn from_config(cfg: &Config) -> Self {
        Self {
            secret_path: cfg.google_secret_path.clone(),
            token_path: cfg.google_token_path.clone(),
            redirect_port: cfg.google_redirect_port,
        }
    }

    pub fn connected(&self) -> bool {
        self.secret_path.is_some()
    }
}

/// Human-facing connection state for the home page.
pub fn connection_state(cfg: &GoogleCfg) -> String {
    if cfg.connected() {
        format!(
            "configured — visit /google/calendars (redirect receiver on :{})",
            cfg.redirect_port
        )
    } else {
        "not connected — set GOOGLE_CLIENT_SECRET_PATH to configure".to_string()
    }
}

/// List the user's calendars. First call (or expired refresh token) blocks
/// on the installed flow: it prints the authorization URL to stdout and
/// binds the redirect receiver on [`GoogleCfg::redirect_port`], waiting for
/// the human to finish in their browser. That is deliberate skeleton
/// behavior, not the final connection UX.
pub async fn list_calendars(cfg: &GoogleCfg) -> anyhow::Result<Vec<String>> {
    let secret_path = cfg
        .secret_path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("no Google client secret configured"))?;
    let secret = yup_oauth2::read_application_secret(&secret_path).await?;

    let auth = yup_oauth2::InstalledFlowAuthenticator::builder(
        secret,
        yup_oauth2::InstalledFlowReturnMethod::HTTPPortRedirect(cfg.redirect_port),
    )
    .persist_tokens_to_disk(&cfg.token_path)
    .build()
    .await?;

    // Native roots (the system CA store) need ca-certificates present in the
    // runtime image.
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build(
            hyper_rustls::HttpsConnectorBuilder::new()
                .with_native_roots()?
                .https_or_http()
                .enable_http2()
                .build(),
        );

    let hub = google_calendar3::CalendarHub::new(client, auth);
    let (_, list) = hub.calendar_list().list().doit().await?;
    Ok(list
        .items
        .unwrap_or_default()
        .into_iter()
        .map(|calendar| {
            calendar
                .summary
                .unwrap_or_else(|| "<unnamed calendar>".to_string())
        })
        .collect())
}
