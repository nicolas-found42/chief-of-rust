# Tasks remain file-backed

Tasks and Action Items use stable identities and atomic file-backed records inside the Workspace, consistent with the app's other durable resources. Search and filters read a local projection of those records. The first version adds neither a database nor a Task event log: one trusted local user and the agreed query volume do not justify a second persistence model, migration runtime and backup contract.
