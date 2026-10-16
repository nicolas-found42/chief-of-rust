# Terminal dossier archive

The app writes superseded dossiers here before publishing their successful
replacements. Each revision has a Markdown file and a JSON evidence snapshot.
Person and company folders use stable profile IDs, so namesakes stay separate.

Docker bind-mounts this directory. Native runs use `TERMINAL_ARCHIVE_DIR`,
defaulting to this path from the repository root. Keep this directory writable
by the app and backed up. Files are retained locally; the app does not commit
or push research data. The application does not expose historical revisions.
