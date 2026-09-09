# Modules are a registry in one process

Each workflow is a Module package that declares itself to the Shell, which mounts it at startup.
One server process, one container image, one Helm chart. We rejected two alternatives: plain tabs
in a monolith, which gives no seam and makes each new workflow a diffuse edit across the codebase;
and a service (and container) per Module behind the Shell as a gateway, which turns every new
workflow into an orchestration, OAuth, and inter-service auth problem.

## Consequences

Modules share a process, so one Module's runaway work can starve another's, and a crash takes the
Shell down. Accepted for now: the app is single-user and Runs are infrequent. The registry seam is
what keeps the option of splitting a Module into its own service later without rewriting it.
