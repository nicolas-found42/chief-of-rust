use super::Dossier;
use std::{io::Write, path::Path};

/// Archive before publication while the DB writer lock is held. A failed
/// write leaves the current dossier untouched. Content-addressed files make
/// a crash between filesystem and SQLite commits safe to retry.
pub(super) fn save(root: &Path, dossier: &Dossier) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec_pretty(dossier)?;
    save_bytes(
        root,
        &dossier.identity.kind,
        &dossier.subject_id,
        &dossier.id,
        &bytes,
        &dossier.body,
    )
}

pub(super) fn save_bytes(
    root: &Path,
    kind: &str,
    subject: &str,
    id: &str,
    bytes: &[u8],
    markdown: &str,
) -> anyhow::Result<()> {
    for part in [kind, subject, id] {
        anyhow::ensure!(
            !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "Invalid archive identifier"
        );
    }
    let dir = root.join(kind).join(subject);
    std::fs::create_dir_all(&dir)?;
    let digest = crate::research::content_hash(bytes);
    let stem = format!("{id}-{digest}");
    for (extension, content) in [("json", bytes), ("md", markdown.as_bytes())] {
        let path = dir.join(format!("{stem}.{extension}"));
        if path.exists() {
            anyhow::ensure!(std::fs::read(&path)? == content, "Archive content differs");
            continue;
        }
        let temporary = dir.join(format!(".{stem}-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
    }
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}
