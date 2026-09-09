import type {
  ExternalTaskBaseline,
  Task,
  TaskDestination,
  TaskLinkFailure,
} from "@chief-of-staff-demo/shared";
import { TaskValidationError, type WorkspaceTasks } from "./tasks.js";

/**
 * External Task Links (issues #184, #185, #189, ADR-0056).
 *
 * Local first, always. A Task is committed to the Workspace before anything is
 * sent outward, and a provider failure leaves the Task exactly as usable as it
 * was — with a link that says `waiting`, `failed` or `missing` rather than no
 * Task at all.
 *
 * One state machine serves every provider. Each outward destination — Google
 * Tasks, Asana — is a `RemoteTaskConnector` the machine dispatches on by the
 * destination's provider, so the local-first ordering, the one-link rule and
 * the failure quadrants are written once and cannot drift between providers.
 *
 * Linked records are read one at a time, and completion only: synchronizing a
 * link asks whether that one Task is done. Nothing is ever listed, and no
 * provider Task ever becomes a Workspace Task.
 */

/** The destination a Task can be linked outward to. */
type ExternalTaskDestination = Extract<TaskDestination, { provider: "google-tasks" | "asana" }>;

export type GoogleTasksDestination = Extract<TaskDestination, { provider: "google-tasks" }>;
export type AsanaDestination = Extract<TaskDestination, { provider: "asana" }>;

/**
 * The provider's own copy of one linked record, in the Workspace's own terms
 * (issue #186). Deliberately the same four fields as `ExternalTaskBaseline`:
 * detecting an outside edit is comparing what the provider holds now against
 * what the Workspace last sent, and a comparison between two different shapes
 * would eventually compare the wrong things.
 */
type RemoteTaskSnapshot = ExternalTaskBaseline;

/** Just the content half — what an outward content write carries. */
type RemoteTaskContent = Omit<ExternalTaskBaseline, "status">;

/**
 * One provider's outward write, as the shared state machine calls it. The
 * destination comes from the Task or link being worked on, so a connector
 * never guesses which container it was pointed at. `read` answers null when
 * the provider no longer holds the record — the machine marks the link
 * missing rather than failing the local Task.
 *
 * Content and status are separate writes because they are separate decisions:
 * an outside edit to the title and an outside completion are different facts
 * about a link, resolved by different answers, and one call that carried both
 * would make "restore my version" also assert a completion nobody chose.
 */
export interface RemoteTaskConnector<D extends ExternalTaskDestination = ExternalTaskDestination> {
  resolveDestination?(destination: D): Promise<D>;
  create(task: Task, destination: D): Promise<{ remoteId: string; url: string | null }>;
  read(destination: D, remoteId: string): Promise<RemoteTaskSnapshot | null>;
  updateStatus(destination: D, remoteId: string, completed: boolean): Promise<void>;
  updateContent(destination: D, remoteId: string, content: RemoteTaskContent): Promise<void>;
  delete(destination: D, remoteId: string): Promise<void>;
}

/** Which side of a drift or a conflict the owner chose to keep. */
export type TaskLinkResolution = "app" | "external";

/** What the owner chose for Google Tasks, as the Workspace stores it. */
export interface GoogleTasksDestinationSettings {
  enabled: boolean;
  taskListId: string;
  taskListTitle: string;
}

export interface TaskLinkingDeps {
  tasks: WorkspaceTasks;
  /** Changes when the owner reconnects; credentials themselves never leave composition. */
  authorizationRevision?: (provider: ExternalTaskDestination["provider"]) => string;
  /** The stored Google Tasks settings, read live. */
  settings: () => GoogleTasksDestinationSettings;
  save: (settings: GoogleTasksDestinationSettings) => void;
  /** The Google account's Task Lists, or a refusal explaining why not. */
  listRemoteLists: () => Promise<{ id: string; title: string }[]>;
  /** Google Tasks — the connector the original destination was built on. */
  google: RemoteTaskConnector<GoogleTasksDestination>;
  /** Asana, when the Workspace composes it (issue #189). */
  asana?: RemoteTaskConnector<AsanaDestination>;
}

/** The HTTP-ish status a provider failure carries, whatever its shape. */
function providerStatus(error: unknown): number | null {
  if (error !== null && typeof error === "object") {
    for (const key of ["code", "status", "statusCode"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    }
    const response = (error as Record<string, unknown>).response;
    if (response !== null && typeof response === "object") {
      const status = (response as Record<string, unknown>).status;
      if (typeof status === "number" && Number.isInteger(status)) return status;
    }
  }
  return null;
}

/**
 * Strip anything credential-shaped from a provider message and cap its
 * length. A redacted detail is still the provider's own words about this
 * call, never a secret about the account.
 */
function sanitizeDetail(message: string): string {
  const redacted = message
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(ya29\.)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|refresh[_-]?token|access[_-]?token|client[_-]?secret|id[_-]?token)\s*[:=]\s*)[^\s&"'}]+/gi,
      "$1[redacted]",
    )
    .trim();
  return redacted.length > 280 ? `${redacted.slice(0, 277)}…` : redacted;
}

/**
 * Classify a provider failure at the site that raised it (ADR-0008) and
 * answer the classified fact the link stores. Classified kinds get a fixed
 * sentence — a code is a fact, not prose to quote — while an unclassified
 * failure keeps its redacted detail, which is why a refusal the tests raise
 * by hand still reads the way it was raised.
 */
export function classifyTaskLinkError(error: unknown, provider: string): TaskLinkFailure {
  const status = providerStatus(error);
  const raw = error instanceof Error ? error.message : String(error);
  /* Google reports quota exhaustion over 403 with a reason in the body, so
     the reason is read before the status: a rate limit wants a retry, not a
     re-auth. */
  if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(raw)) {
    return { kind: "rate-limit", message: `${provider} is rate-limited. Retry shortly.` };
  }
  if (status === 401 || status === 403 || /invalid_grant/.test(raw)) {
    return {
      kind: "authorization",
      message: `${provider} refused the saved credential. Reconnect ${provider}.`,
    };
  }
  if (status === 400) {
    return { kind: "validation", message: `${provider} refused that change as invalid.` };
  }
  if (status === 404) {
    return { kind: "not-found", message: `${provider} no longer holds that Task.` };
  }
  if (status === 429) {
    return { kind: "rate-limit", message: `${provider} is rate-limited. Retry shortly.` };
  }
  if (
    status === 408 ||
    (status !== null && status >= 500) ||
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(raw)
  ) {
    return { kind: "network", message: `${provider} is unreachable; the Task is intact.` };
  }
  const detail = sanitizeDetail(raw);
  return {
    kind: "unavailable",
    message: detail === "" ? `${provider} failed; the Task is intact.` : detail,
  };
}

export class TaskLinking {
  private readonly authorizationRevisions = new Map<string, string>();
  private readonly pending = new Map<string, Promise<Task>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: TaskLinkingDeps) {
    for (const provider of ["google-tasks", "asana"] as const) {
      const revision = deps.authorizationRevision?.(provider);
      if (revision !== undefined) this.authorizationRevisions.set(provider, revision);
    }
  }

  private classify(error: unknown, provider: string): TaskLinkFailure {
    const failure = classifyTaskLinkError(error, provider);
    const revision = this.deps.authorizationRevision?.(
      provider === "Asana" ? "asana" : "google-tasks",
    );
    return failure.kind === "authorization" && revision !== undefined
      ? { ...failure, authorizationRevision: revision }
      : failure;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** All lifecycle triggers use the same per-Task path and isolate provider failures. */
  async refresh(options: { failedOnly?: boolean; manual?: boolean } = {}): Promise<Task[]> {
    const reconnected = new Set<string>();
    for (const provider of ["google-tasks", "asana"] as const) {
      const revision = this.deps.authorizationRevision?.(provider);
      if (revision !== undefined && this.authorizationRevisions.get(provider) !== revision) {
        reconnected.add(provider);
        this.authorizationRevisions.set(provider, revision);
      }
    }
    const selected = [...this.deps.tasks.list(), ...this.deps.tasks.list({ trashed: true })].filter(
      (task) => {
        const link = task.externalLink;
        return (
          link !== null &&
          (!options.failedOnly || link.state === "failed") &&
          (options.manual ||
            reconnected.has(link.destination.provider) ||
            (this.deps.authorizationRevision !== undefined &&
              link.failure?.authorizationRevision !== undefined &&
              link.destination.provider !== "local" &&
              link.failure.authorizationRevision !==
                this.deps.authorizationRevision(link.destination.provider)) ||
            link.failure?.kind !== "authorization")
        );
      },
    );
    const results = await Promise.allSettled(selected.map((task) => this.retry(task.id)));
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }

  /** Reconcile and retry one link; concurrent triggers share the same operation. */
  retry(taskId: string): Promise<Task> {
    const pending = this.pending.get(taskId);
    if (pending) return pending;
    const operation = this.retryOne(taskId).finally(() => this.pending.delete(taskId));
    this.pending.set(taskId, operation);
    return operation;
  }

  private async retryOne(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    const link = task.externalLink;
    if (task.deletedAt !== null) return this.deleteExternal(taskId);
    if (link === null || ["missing", "conflicted", "changed-externally"].includes(link.state)) {
      return task;
    }
    if (link.remoteId === null) return this.link(taskId);
    const read = { failed: false };
    task = await this.inspect(taskId, () => {
      read.failed = true;
    });
    if (read.failed) return task;
    if (["missing", "conflicted", "changed-externally"].includes(task.externalLink?.state ?? "")) {
      return task;
    }
    task = await this.pushStatus(taskId);
    if (task.externalLink?.state === "failed") return task;
    return this.pushContent(taskId);
  }

  async trash(taskId: string, external?: "delete" | "preserve"): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.externalLink !== null && external === undefined) {
      throw new TaskValidationError(
        "confirmation-required",
        "Choose whether to delete the external Task or preserve it and remove the link.",
      );
    }
    this.deps.tasks.trash(taskId);
    return external === "delete" ? this.deleteExternal(taskId) : this.removeLink(taskId);
  }

  private async deleteExternal(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (!link) return task;
    if (
      link.remoteId === null ||
      link.state === "missing" ||
      link.destination.provider === "local"
    ) {
      return this.removeLink(taskId);
    }
    const connector = this.connectorFor(link.destination.provider);
    if (!connector) return task;
    try {
      await connector.delete(link.destination, link.remoteId);
    } catch (error) {
      const failure = this.classify(error, this.providerName(link.destination));
      if (failure.kind !== "not-found") {
        return this.deps.tasks.refreshExternalLink(taskId, { ...link, state: "failed", failure });
      }
    }
    return this.removeLink(taskId);
  }

  /** The connector a destination's provider dispatches to; null when the Workspace does not compose it. */
  private connectorFor(provider: TaskDestination["provider"]): RemoteTaskConnector | null {
    if (provider === "google-tasks") return this.deps.google;
    if (provider === "asana") return this.deps.asana ?? null;
    return null;
  }

  /** The provider's name as a person reads it, for the sentences failures carry. */
  private providerName(destination: TaskDestination): string {
    return destination.provider === "asana" ? "Asana" : "Google Tasks";
  }

  settings(): GoogleTasksDestinationSettings {
    return this.deps.settings();
  }

  /** The Google Task Lists available as a destination. Containers only. */
  async availableLists(): Promise<{ id: string; title: string }[]> {
    return this.deps.listRemoteLists();
  }

  /**
   * Enable or disable Google Tasks, and choose the list. Enabling with a list
   * validates that Google still holds it — a destination that does not exist
   * would turn every later creation into the same failure, discovered one Task
   * at a time.
   *
   * Disabling keeps the remembered list and touches nothing else: the rest of
   * the Google connection, and every local Task, go on working.
   */
  async select(input: {
    enabled: boolean;
    taskListId?: string;
  }): Promise<GoogleTasksDestinationSettings> {
    const current = this.deps.settings();
    if (!input.enabled) {
      const next = { ...current, enabled: false };
      this.deps.save(next);
      return next;
    }
    const chosen = input.taskListId ?? current.taskListId;
    if (chosen === "") {
      throw new TaskValidationError(
        "invalid-destination",
        "Choose which Google Task List new Tasks are created in.",
      );
    }
    const lists = await this.deps.listRemoteLists();
    const match = lists.find((list) => list.id === chosen);
    if (!match) {
      throw new TaskValidationError(
        "invalid-destination",
        "Google does not have that Task List. Choose one of the lists it offers.",
      );
    }
    const next = { enabled: true, taskListId: match.id, taskListTitle: match.title };
    this.deps.save(next);
    return next;
  }

  /**
   * Create the external record for a Task already committed locally, and store
   * the one External Task Link it may have. A failure is recorded on the Task
   * rather than raised at the owner: the work is captured either way, and the
   * link is what is waiting.
   */
  async recoverCreation(taskId: string, remoteId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (!link?.creationUncertain || !remoteId.trim() || link.destination.provider === "local")
      throw new TaskValidationError(
        "invalid-destination",
        "Supply the existing provider record ID for an uncertain creation.",
      );
    const remote = await this.connectorFor(link.destination.provider)?.read(
      link.destination,
      remoteId,
    );
    if (!remote)
      throw new TaskValidationError("task-not-found", "That provider record was not found.");
    this.deps.tasks.recordExternalLink(task.id, {
      ...link,
      creationUncertain: false,
      remoteId,
      state: "synchronized",
      failure: null,
    });
    return this.retry(task.id);
  }

  async link(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.externalLink?.creationUncertain)
      return this.deps.tasks.recordExternalLink(task.id, {
        ...task.externalLink,
        state: "failed",
        failure: {
          kind: "network",
          message:
            "The creation response was lost. Inspect the provider and recover its existing record by ID before retrying.",
        },
      });
    /* A link that names a live record is one link already — whether it is
       synchronized or a failed outward write on top of it. Re-linking over
       one would strand the record Google still holds. Only a link that never
       reached the provider (`remoteId: null`) is an attempt to try again. */
    if (task.externalLink !== null && task.externalLink.remoteId !== null) {
      throw new TaskValidationError(
        "task-already-linked",
        "That Task already has an External Task Link.",
      );
    }
    if (task.destination.provider === "local") {
      throw new TaskValidationError(
        "invalid-destination",
        "That Task is filed locally and has nothing to link to.",
      );
    }
    const connector = this.connectorFor(task.destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "invalid-destination",
        `The Workspace does not compose ${this.providerName(task.destination)} as a Task Destination.`,
      );
    }
    const provider = this.providerName(task.destination);
    const destination = task.destination;
    /* Recorded before the provider is called at all, so an outward write that
       never returns leaves a Task that says it is waiting rather than one that
       silently says nothing happened. */
    this.deps.tasks.recordExternalLink(task.id, {
      state: "waiting",
      creationUncertain: true,
      destination: task.destination,
      remoteId: null,
      url: null,
      baseline: this.baselineFor(task, "open"),
      external: null,
      failure: null,
    });
    /* Only the provider calls sit inside try, for the same reason as
       `recreate`: a Workspace refusal is a domain fact, never provider prose. */
    let created: { remoteId: string; url: string | null };
    try {
      created = await connector.create(task, destination);
    } catch (error) {
      return this.deps.tasks.recordExternalLink(task.id, {
        state: "failed",
        destination: task.destination,
        remoteId: null,
        url: null,
        baseline: this.baselineFor(task, "open"),
        external: null,
        failure: this.classify(error, provider),
        creationUncertain: !["authorization", "validation", "rate-limit"].includes(
          this.classify(error, provider).kind,
        ),
      });
    }
    // Persist the remote identity before the separate status write can be interrupted.
    this.deps.tasks.recordExternalLink(task.id, {
      state: "synchronized",
      destination,
      remoteId: created.remoteId,
      url: created.url,
      baseline: this.baselineFor(task, "open"),
      external: null,
      failure: null,
    });
    /* Creation cannot carry completion on either provider (the record arrives
       open — Google's insert has no completed field, and Asana's is sent as
       its own call so the sequence stays recoverable), so a completed Task is
       completed in the same operation — and the baseline records the status
       the provider actually holds, never the status the Task wishes it held. */
    const sent = task.status;
    if (task.status === "completed") {
      try {
        await connector.updateStatus(destination, created.remoteId, true);
      } catch (error) {
        return this.deps.tasks.refreshExternalLink(task.id, {
          state: "failed",
          destination: task.destination,
          remoteId: created.remoteId,
          url: created.url,
          baseline: this.baselineFor(task, "open"),
          external: null,
          failure: this.classify(error, provider),
        });
      }
    }
    return this.deps.tasks.refreshExternalLink(task.id, {
      state: "synchronized",
      destination,
      remoteId: created.remoteId,
      url: created.url,
      baseline: this.baselineFor(task, sent),
      external: null,
      failure: null,
    });
  }

  /**
   * Push the Task's current open or completed state to its linked provider
   * record (issue #185). Runs after the local commit, never instead of it: a
   * provider failure is recorded on the link while the Task itself stays
   * exactly as the owner left it.
   *
   * Side-effect free when there is nothing to send — no link, no remote
   * identity, a link known to be missing, or a baseline that already carries
   * this status — so a repeated completion costs one local write and no
   * provider call. A failed push that left a live record behind is retried
   * here: the outward write is idempotent, and this is how an interrupted
   * completion converges without waiting for issue #187's retry machinery.
   */
  async pushStatus(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (
      link === null ||
      link.remoteId === null ||
      link.state === "missing" ||
      link.state === "conflicted" ||
      link.state === "changed-externally" ||
      link.destination.provider === "local" ||
      link.baseline?.status === task.status
    ) {
      return task;
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) return task;
    const baseline = { ...contentOf(link.baseline ?? task), status: task.status };
    try {
      await connector.updateStatus(link.destination, link.remoteId, task.status === "completed");
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "synchronized",
        baseline,
        failure: null,
      });
    } catch (error) {
      const classified = this.classify(error, this.providerName(link.destination));
      /* The provider answering not-found means the record is gone, not that
         the write was wrong: the local Task stays intact and the link says
         missing, which is what `recreate` and `removeLink` below resolve. */
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: classified.kind === "not-found" ? "missing" : "failed",
        failure: classified,
      });
    }
  }

  /**
   * Read the linked provider record and reconcile it with the canonical Task
   * (issues #185, #186).
   *
   * Three readings meet here: the Task (what the Workspace means), the
   * baseline (what the Workspace last sent) and the provider's snapshot (what
   * the provider holds now). Which of them moved decides what this read may
   * do, and the one thing it may never do is pick a winner when both did.
   *
   * - Only the provider moved, on completion: applied locally. Checking work
   *   off in either supported surface is the point of a link.
   * - Only the provider moved, on content: `changed-externally`, with both
   *   projections kept. An outside edit never silently replaces canonical
   *   content, because the Workspace is the source of truth for what a Task
   *   says.
   * - Both moved on completion: `conflicted`. Neither side wins implicitly.
   * - Only the Workspace moved: nothing to apply; `pushStatus` and
   *   `pushContent` are what carry it outward.
   *
   * A record the provider no longer holds marks the link missing with the
   * local Task intact. Repeated reads that agree with the Task write nothing.
   */
  synchronize(taskId: string): Promise<Task> {
    return this.inspect(taskId, () => {});
  }

  private async inspect(taskId: string, readFailed: () => void): Promise<Task> {
    const task = this.deps.tasks.get(taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    let link = task.externalLink;
    if (
      link === null ||
      link.remoteId === null ||
      link.state === "waiting" ||
      link.destination.provider === "local"
    ) {
      throw new TaskValidationError(
        "task-not-linked",
        "That Task has no linked Task to synchronize.",
      );
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "task-not-linked",
        "That Task has no linked Task to synchronize.",
      );
    }
    /* A missing link is resolved by recreating or removing it, never by
       reading: polling a record known to be gone would only spend quota to
       learn the same answer. A drift or a conflict is resolved by the owner,
       and re-reading one would keep overwriting the projection they are in
       the middle of comparing. */
    if (
      link.state === "missing" ||
      link.state === "changed-externally" ||
      link.state === "conflicted"
    ) {
      return task;
    }
    let remote: RemoteTaskSnapshot | null;
    try {
      const destination = connector.resolveDestination
        ? await connector.resolveDestination(link.destination)
        : link.destination;
      if (JSON.stringify(destination) !== JSON.stringify(link.destination)) {
        link = { ...link, destination };
        this.deps.tasks.refreshExternalLink(task.id, link);
      }
      remote = await connector.read(destination, link.remoteId!);
    } catch (error) {
      readFailed();
      const classified = this.classify(error, this.providerName(link.destination));
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: classified.kind === "not-found" ? "missing" : "failed",
        failure: classified,
      });
    }
    if (remote === null) {
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "missing",
        failure: {
          kind: "not-found",
          message: `${this.providerName(link.destination)} no longer holds that Task.`,
        },
      });
    }
    /* Who moved since the baseline. Every branch below is a reading of these
       two, and both are measured against the baseline rather than against
       each other: "they differ" says nothing about whose change it was. */
    const baseline = link.baseline;
    const remoteMovedStatus = baseline !== null && remote.status !== baseline.status;
    const localMovedStatus = baseline !== null && task.status !== baseline.status;
    /* Completion first. Both sides moving on the same field is the sharper
       claim, and the stored projection carries the content too — so an
       outside edit that accompanied an outside completion is still there to
       resolve once the completion has been settled. */
    if (remoteMovedStatus && localMovedStatus) {
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "conflicted",
        external: remote,
        failure: null,
      });
    }
    if (remoteMovedStatus) {
      const applied =
        remote.status === "completed"
          ? this.deps.tasks.complete(task.id)
          : this.deps.tasks.reopen(task.id);
      return this.deps.tasks.refreshExternalLink(applied.id, {
        ...link,
        state: "synchronized",
        baseline: { ...contentOf(baseline), status: applied.status },
        external: null,
        failure: null,
      });
    }
    /* Only the Workspace moved: an interrupted push, which `pushStatus`
       retries. Applying the provider's stale state here would revert accepted
       work, so this read answers unchanged. */
    if (localMovedStatus) return task;
    /* Content next, the same way. An unsent local edit is the Workspace
       moving, which `pushContent` carries outward — it is not the provider
       drifting, so the comparison is against the baseline. */
    if (baseline !== null && !sameContent(remote, baseline)) {
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "changed-externally",
        external: remote,
        failure: null,
      });
    }
    /* In agreement. Converge a stale baseline or clear a past failure without
       touching the provider; a converged link reads free. */
    if (baseline !== null && baseline.status === task.status && link.failure === null) {
      return task;
    }
    return this.deps.tasks.refreshExternalLink(task.id, {
      ...link,
      state: "synchronized",
      baseline: { ...contentOf(baseline ?? remote), status: task.status },
      external: null,
      failure: null,
    });
  }

  /**
   * Send the Task's current title, notes and due date to its linked record
   * (issues #186, story 72). The provider's copy is a representation of the
   * canonical Task, so this is how it catches up — and it is what "Restore
   * app version" performs after an outside edit.
   *
   * Local-first, like every other outward write: the Task is already what it
   * is, and a failure lands on the link.
   */
  async pushContent(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (
      link === null ||
      link.remoteId === null ||
      link.state === "missing" ||
      link.state === "conflicted" ||
      link.state === "changed-externally" ||
      link.destination.provider === "local"
    ) {
      return task;
    }
    const connector = this.connectorFor(link.destination.provider);
    if (connector === null) return task;
    if (link.baseline !== null && sameContent(link.baseline, this.baselineFor(task, task.status))) {
      return task;
    }
    try {
      await connector.updateContent(link.destination, link.remoteId, contentOf(task));
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: "synchronized",
        baseline: { ...contentOf(task), status: link.baseline?.status ?? task.status },
        external: null,
        failure: null,
      });
    } catch (error) {
      const classified = this.classify(error, this.providerName(link.destination));
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        state: classified.kind === "not-found" ? "missing" : "failed",
        failure: classified,
      });
    }
  }

  /**
   * Settle an External Task Drift (issue #186). `app` reasserts the canonical
   * content over the provider's copy; `external` accepts the outside edit as
   * canonical, which is a deliberate act rather than something a read did on
   * the owner's behalf.
   *
   * Either way the link only leaves the drifted state once the operation the
   * owner chose has actually succeeded — a failed push leaves the drift
   * standing, with both projections still there to try again from.
   */
  async resolveDrift(taskId: string, choice: TaskLinkResolution): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (
      link === null ||
      link.state !== "changed-externally" ||
      link.external === null ||
      link.remoteId === null ||
      link.destination.provider === "local"
    ) {
      throw new TaskValidationError(
        "link-not-drifted",
        "Only a link changed outside the Workspace can be restored or accepted.",
      );
    }
    const destination = link.destination;
    const remoteId = link.remoteId;
    if (choice === "external") {
      /* The local write first, and the baseline only after it: the provider
         already holds these values, so accepting them is one Workspace
         write and no outward call at all. */
      const external = link.external;
      const updated = this.deps.tasks.update(task.id, {
        title: external.title,
        notes: external.notes,
        dueDate: external.dueDate,
      });
      return this.deps.tasks.refreshExternalLink(updated.id, {
        ...link,
        state: "synchronized",
        baseline: { ...contentOf(external), status: link.baseline?.status ?? updated.status },
        external: null,
        failure: null,
      });
    }
    const connector = this.connectorFor(destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "invalid-destination",
        `The Workspace does not compose ${this.providerName(destination)} as a Task Destination.`,
      );
    }
    try {
      await connector.updateContent(destination, remoteId, contentOf(task));
    } catch (error) {
      /* Still drifted: the provider still holds the outside edit, so the
         link keeps saying so with the new reason attached. */
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        failure: this.classify(error, this.providerName(link.destination)),
      });
    }
    return this.deps.tasks.refreshExternalLink(task.id, {
      ...link,
      state: "synchronized",
      baseline: { ...contentOf(task), status: link.baseline?.status ?? task.status },
      external: null,
      failure: null,
    });
  }

  /**
   * Settle a Task Link Conflict (issue #186). `app` sends the Workspace's
   * completion state outward; `external` accepts the provider's. Neither is
   * the default, and the link stays conflicted until the chosen operation
   * succeeds — a conflict quietly resolved by a failed write would be the
   * silent winner this whole state exists to prevent.
   */
  async resolveConflict(taskId: string, choice: TaskLinkResolution): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (
      link === null ||
      link.state !== "conflicted" ||
      link.external === null ||
      link.remoteId === null ||
      link.destination.provider === "local"
    ) {
      throw new TaskValidationError(
        "link-not-conflicted",
        "Only a conflicted External Task Link can have its status resolved.",
      );
    }
    const destination = link.destination;
    const remoteId = link.remoteId;
    const external = link.external;
    if (choice === "external") {
      const applied =
        external.status === "completed"
          ? this.deps.tasks.complete(task.id)
          : this.deps.tasks.reopen(task.id);
      return this.deps.tasks.refreshExternalLink(applied.id, {
        ...link,
        state: "synchronized",
        baseline: { ...contentOf(link.baseline ?? external), status: applied.status },
        external: null,
        failure: null,
      });
    }
    const connector = this.connectorFor(destination.provider);
    if (connector === null) {
      throw new TaskValidationError(
        "invalid-destination",
        `The Workspace does not compose ${this.providerName(destination)} as a Task Destination.`,
      );
    }
    try {
      await connector.updateStatus(destination, remoteId, task.status === "completed");
    } catch (error) {
      return this.deps.tasks.refreshExternalLink(task.id, {
        ...link,
        failure: this.classify(error, this.providerName(link.destination)),
      });
    }
    return this.deps.tasks.refreshExternalLink(task.id, {
      ...link,
      state: "synchronized",
      baseline: { ...contentOf(link.baseline ?? external), status: task.status },
      external: null,
      failure: null,
    });
  }

  /**
   * Recreate the remote record for a link the provider no longer holds
   * (issue #185). Stores the replacement identity and a fresh baseline over
   * the current Task, so synchronization resumes from what the owner has
   * rather than from what went missing. Refused unless the link is missing —
   * any other state already names a record or a retry for it.
   */
  async recreate(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const link = task.externalLink;
    if (link === null || link.state !== "missing" || link.destination.provider === "local") {
      throw new TaskValidationError(
        "link-not-missing",
        "Only a missing External Task Link can be recreated.",
      );
    }
    this.deps.tasks.refreshExternalLink(task.id, {
      ...link,
      state: "waiting",
      remoteId: null,
      failure: null,
      creationUncertain: false,
    });
    return this.link(task.id);
  }

  /**
   * Remove the External Task Link while preserving the local Task (issue
   * #185). Never deletes the remote record — unlinking ends synchronization,
   * and deletion is a separate decision with its own confirmation.
   */
  async removeLink(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    return this.deps.tasks.clearExternalLink(task.id);
  }

  // ---------------------------------------------------------------------------

  /** The Task a link operation names, or the one refusal every caller shares. */
  private requireTask(taskId: string): Task {
    const task = this.deps.tasks.get(taskId);
    if (!task) {
      throw new TaskValidationError("task-not-found", `No Task with id ${taskId}`);
    }
    return task;
  }

  /**
   * The four outward fields as the provider holds them after this operation:
   * the Task's content, and the status that was actually sent — which is not
   * always the status the Task carries (a completion whose outward write
   * failed has not reached the provider, and the baseline must not claim it
   * did).
   */
  private baselineFor(task: Task, sentStatus: Task["status"]): ExternalTaskBaseline {
    return {
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      status: sentStatus,
    };
  }
}

/** The three outward content fields, without the status beside them. */
function contentOf(source: RemoteTaskSnapshot | Task): RemoteTaskContent {
  return { title: source.title, notes: source.notes, dueDate: source.dueDate };
}

/** Whether two projections say the same thing about the content. */
function sameContent(a: RemoteTaskSnapshot, b: RemoteTaskSnapshot): boolean {
  return a.title === b.title && a.notes === b.notes && a.dueDate === b.dueDate;
}
