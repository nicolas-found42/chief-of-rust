import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ActionItem,
  PersonProfile,
  Task,
  TaskDuplicateCandidate,
  TaskList,
  TaskPriority,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";
import {
  INBOX_TASK_LIST_ID,
  TASK_GROUPS,
  TASK_GROUP_LABELS,
  TASK_PRIORITIES,
  groupTasks,
} from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import {
  tasksApi,
  type AsanaCheckConnection,
  type ActionItemPolicySetting,
  type AsanaDestination,
  type GoogleTasksDestination,
  type TasksClient,
} from "../clients/tasks";
import { peopleApi, type PeopleClient } from "../clients/people";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Tasks — the fifth product area (ADR-0052), and the canonical home of
 * accepted work. Everything here is a Workspace operation: no Google account,
 * no Asana token, and no connection state can stop a Task being captured,
 * edited, completed or filed.
 *
 * The pending Action Items section reads proposals a Meeting Debrief made. It
 * is deliberately a different section with different controls: a proposal is
 * not accepted work, and this page never lets one quietly become a Task.
 */

/** The owner, nobody, or a confirmed Person Profile, as one select value. */
const OWNER_VALUE = "owner";
const NOBODY_VALUE = "";

function responsibleValue(person: TaskResponsiblePerson | null): string {
  if (person === null) return NOBODY_VALUE;
  return person.kind === "owner" ? OWNER_VALUE : person.profileId;
}

function responsibleFromValue(value: string): TaskResponsiblePerson | null {
  if (value === NOBODY_VALUE) return null;
  return value === OWNER_VALUE ? { kind: "owner" } : { kind: "person-profile", profileId: value };
}

function personName(profiles: PersonProfile[], profileId: string): string {
  return profiles.find((profile) => profile.id === profileId)?.fullName ?? profileId;
}

function responsibleLabel(person: TaskResponsiblePerson | null, profiles: PersonProfile[]): string {
  if (person === null) return "Nobody";
  return person.kind === "owner" ? "You" : personName(profiles, person.profileId);
}

function listName(lists: TaskList[], listId: string): string {
  return lists.find((list) => list.id === listId)?.name ?? listId;
}

/** The fields an expanded Task form edits, as strings the inputs hold. */
interface TaskFormValues {
  title: string;
  notes: string;
  dueDate: string;
  priority: TaskPriority;
  listId: string;
  responsible: string;
}

function formValuesFrom(task: Task): TaskFormValues {
  return {
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate ?? "",
    priority: task.priority,
    listId: task.listId,
    responsible: responsibleValue(task.responsiblePerson),
  };
}

/** The shared field set — the same in Quick Add's expansion and in an edit. */
function TaskFields({
  idPrefix,
  values,
  lists,
  profiles,
  onChange,
}: {
  idPrefix: string;
  values: TaskFormValues;
  lists: TaskList[];
  profiles: PersonProfile[];
  onChange: (values: TaskFormValues) => void;
}) {
  const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
    onChange({ ...values, [key]: value });
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor={`${idPrefix}-notes`}>Notes</label>
        <textarea
          id={`${idPrefix}-notes`}
          rows={3}
          value={values.notes}
          onChange={(event) => set("notes", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-due`}>Due date</label>
        <input
          id={`${idPrefix}-due`}
          type="date"
          value={values.dueDate}
          onChange={(event) => set("dueDate", event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-priority`}>Priority</label>
        <select
          id={`${idPrefix}-priority`}
          value={values.priority}
          onChange={(event) => set("priority", event.target.value as TaskPriority)}
        >
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-list`}>Task List</label>
        <select
          id={`${idPrefix}-list`}
          value={values.listId}
          onChange={(event) => set("listId", event.target.value)}
        >
          {lists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-responsible`}>Responsible Person</label>
        <select
          id={`${idPrefix}-responsible`}
          value={values.responsible}
          onChange={(event) => set("responsible", event.target.value)}
        >
          <option value={OWNER_VALUE}>You</option>
          <option value={NOBODY_VALUE}>Nobody</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.fullName ?? profile.id}
            </option>
          ))}
        </select>
        <p className="field-hint">
          Responsibility only. Nobody is granted access and nobody is notified.
        </p>
      </div>
    </div>
  );
}

/**
 * The Possible duplicate warning (issue #180): the open Tasks a would-be Task
 * would duplicate, each linked. It is advisory by construction — the create
 * and promote routes take no confirmation token — so the form's next submit,
 * the one labeled "anyway", is the whole override mechanism.
 */
function DuplicateWarning({ duplicates }: { duplicates: Task[] }) {
  return (
    <div className="banner banner-warn" role="status">
      <strong>Possible duplicate.</strong> An open Task already has this title, Responsible Person,
      and due date:{" "}
      {duplicates.map((duplicate) => (
        <details key={duplicate.id}>
          <summary>Compare: {duplicate.title}</summary>
          <p>
            {duplicate.listId === INBOX_TASK_LIST_ID ? "Inbox" : "Task List"} ·{" "}
            {duplicate.dueDate ? `due ${duplicate.dueDate}` : "no due date"} · {duplicate.status}
          </p>
          <p>{duplicate.notes || "No notes."}</p>
          <p>
            Responsible Person:{" "}
            {duplicate.responsiblePerson?.kind === "owner"
              ? "You"
              : (duplicate.responsiblePerson?.profileId ?? "Nobody")}
          </p>
        </details>
      ))}
      . Submit again to create the Task anyway.
    </div>
  );
}

/** The provider a Task's destination names, as the row's sentences read it. */
function providerName(destination: Task["destination"]): string {
  return destination.provider === "asana" ? "Asana" : "Google Tasks";
}

/** One Task in a list, with its controls and its own edit form. */
function TaskRow({
  task,
  lists,
  profiles,
  busy,
  onComplete,
  onReopen,
  onSave,
  onTrash,
  onLink,
  onRecreate,
  onRecover,
  onRetry,
  onRemoveLink,
  onResolve,
  sourceAvailable,
}: {
  task: Task;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  onComplete: () => Promise<void>;
  onReopen: () => Promise<void>;
  onSave: (values: TaskFormValues) => Promise<boolean>;
  onTrash: (external?: "delete" | "preserve") => Promise<void>;
  onLink: () => Promise<void>;
  onRecreate: () => Promise<void>;
  onRecover: (remoteId: string) => Promise<void>;
  onRetry: () => Promise<void>;
  onRemoveLink: () => Promise<void>;
  /** Settle a drift or a conflict by keeping one side (issue #186). */
  onResolve: (kind: "drift" | "conflict", keep: "app" | "external") => Promise<void>;
  /** False once what the Task was promoted from has been deleted. */
  sourceAvailable: boolean;
}) {
  const [recoveryId, setRecoveryId] = useState("");
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashExternal, setTrashExternal] = useState<"delete" | "preserve">("delete");
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<TaskFormValues>(() => formValuesFrom(task));
  const editButton = useRef<HTMLButtonElement>(null);

  /* Focus returns to the control that opened the form, so a keyboard user is
     not dropped at the top of the document when the form closes. A saved edit
     is handled by the page instead: it can move the Task into a different
     due-date group, and this button is then a different element. */
  const close = useCallback(() => {
    setEditing(false);
    editButton.current?.focus();
  }, []);

  return (
    <li className="card" id={`task-${task.id}`}>
      <h3>{task.title}</h3>
      <p className="muted">
        {listName(lists, task.listId)} · {task.dueDate ? `due ${task.dueDate}` : "no due date"} ·{" "}
        {task.priority === "none" ? "no priority" : `${task.priority} priority`} ·{" "}
        {responsibleLabel(task.responsiblePerson, profiles)}
      </p>
      {task.notes && <p>{task.notes}</p>}
      {/* The Task links back to the Action Item's own surface, and says so
          honestly when what it came from is no longer there to open. */}
      {task.source && (
        <p className="muted">
          Promoted from a Meeting Debrief.{" "}
          {sourceAvailable ? (
            /* The Meeting Debrief is where an Action Item is read; it has no
               surface of its own to deep-link into yet. */
            <Link to={`/meeting-debrief/${encodeURIComponent(task.source.debriefRunId)}`}>
              Open the Action Item it came from
            </Link>
          ) : (
            /* The Task is a snapshot and outlived what proposed it. Saying so
               is the honest answer; a link into nothing is not. */
            "That Action Item is no longer available. This Task is unaffected."
          )}
        </p>
      )}
      {task.externalLink && (
        <p className="muted">
          {task.externalLink.state === "synchronized"
            ? `Sent to ${providerName(task.destination)}.`
            : task.externalLink.state === "failed"
              ? `${providerName(task.destination)} refused it: ${task.externalLink.failure?.message ?? "no reason given"}`
              : task.externalLink.state === "missing"
                ? `${providerName(task.destination)} no longer holds this Task. Recreate it there or remove the link — this Task is unaffected.`
                : task.externalLink.state === "changed-externally"
                  ? `Changed in ${providerName(task.destination)}: “${task.externalLink.external?.title ?? ""}”. This Task still says what you wrote.`
                  : task.externalLink.state === "conflicted"
                    ? `You and ${providerName(task.destination)} both changed whether this is done. Nothing was applied — choose which is right.`
                    : `Waiting to reach ${providerName(task.destination)}.`}{" "}
          {task.externalLink.url && (
            <a href={task.externalLink.url} target="_blank" rel="noreferrer">
              Open in {providerName(task.destination)}
            </a>
          )}
        </p>
      )}
      {task.externalLink?.creationUncertain && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onRecover(recoveryId);
          }}
        >
          <p>
            The provider may have created this Task. Retry will not create another copy. Inspect the
            provider and enter the existing record ID to recover the link.
          </p>
          <label htmlFor={`recover-${task.id}`}>Existing provider Task ID</label>
          <input
            id={`recover-${task.id}`}
            value={recoveryId}
            onChange={(event) => setRecoveryId(event.target.value)}
          />
          <button type="submit" disabled={busy || !recoveryId.trim()}>
            Recover existing Task
          </button>
        </form>
      )}
      {confirmTrash && (
        <fieldset>
          <legend>Move linked Task to Trash</legend>
          <label>
            <input
              type="radio"
              name={`trash-${task.id}`}
              checked={trashExternal === "delete"}
              onChange={() => setTrashExternal("delete")}
            />
            Delete the external Task
          </label>
          <label>
            <input
              type="radio"
              name={`trash-${task.id}`}
              checked={trashExternal === "preserve"}
              onChange={() => setTrashExternal("preserve")}
            />
            Preserve the external Task and remove the link
          </label>
          <button type="button" disabled={busy} onClick={() => void onTrash(trashExternal)}>
            Confirm move to Trash
          </button>
          <button type="button" onClick={() => setConfirmTrash(false)}>
            Cancel
          </button>
        </fieldset>
      )}
      <div className="toolbar">
        {task.externalLink?.state === "failed" && (
          <button type="button" disabled={busy} onClick={() => void onRetry()}>
            Retry link
          </button>
        )}
        {task.externalLink &&
          !["missing", "conflicted", "changed-externally"].includes(task.externalLink.state) && (
            <button type="button" disabled={busy} onClick={() => void onRemoveLink()}>
              Remove link
            </button>
          )}
        {task.status === "open" ? (
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onComplete()}
          >
            Complete
          </button>
        ) : (
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onReopen()}
          >
            Reopen
          </button>
        )}
        {task.destination.provider !== "local" &&
          task.externalLink?.state !== "synchronized" &&
          task.externalLink?.state !== "missing" &&
          /* A failed push that left a record behind is one link already:
             offering another create would strand a second provider Task. */
          task.externalLink?.remoteId === null && (
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onLink()}
            >
              Send to {providerName(task.destination)}
            </button>
          )}
        {/* An outside edit and an outside completion are different facts, so
            each is settled by its own pair of answers — and neither is a
            default (issue #186). */}
        {task.externalLink?.state === "changed-externally" && (
          <>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onResolve("drift", "app")}
            >
              Restore app version
            </button>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onResolve("drift", "external")}
            >
              Use {providerName(task.destination)} values
            </button>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onRemoveLink()}
            >
              Remove link
            </button>
          </>
        )}
        {task.externalLink?.state === "conflicted" && (
          <>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onResolve("conflict", "app")}
            >
              Use app status
            </button>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onResolve("conflict", "external")}
            >
              Use {providerName(task.destination)} status
            </button>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onRemoveLink()}
            >
              Remove link
            </button>
          </>
        )}
        {task.externalLink?.state === "missing" && (
          <>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onRecreate()}
            >
              Recreate in {providerName(task.destination)}
            </button>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => void onRemoveLink()}
            >
              Remove link
            </button>
          </>
        )}
        <button
          type="button"
          className="action-button"
          aria-disabled={busy}
          onClick={() => (task.externalLink ? setConfirmTrash(true) : void onTrash())}
        >
          Move to Trash
        </button>
        <button
          type="button"
          className="action-button"
          id={`task-${task.id}-edit`}
          ref={editButton}
          aria-expanded={editing}
          onClick={() => {
            setValues(formValuesFrom(task));
            setEditing((open) => !open);
          }}
        >
          Edit details
        </button>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(values).then((saved) => {
              if (saved) close();
            });
          }}
        >
          <div className="field-row">
            <label htmlFor={`task-${task.id}-title`}>Title</label>
            <input
              id={`task-${task.id}-title`}
              value={values.title}
              autoFocus
              onChange={(event) => setValues({ ...values, title: event.target.value })}
            />
          </div>
          <TaskFields
            idPrefix={`task-${task.id}`}
            values={values}
            lists={lists}
            profiles={profiles}
            onChange={setValues}
          />
          <div className="toolbar">
            <button type="submit" className="action-button primary" aria-disabled={busy}>
              Save details
            </button>
            <button type="button" className="action-button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * One pending Action Item, and the review that promotes or dismisses it
 * (issues #178, #179, #180).
 *
 * The panel is where a proposal becomes accepted work: every field is editable
 * before anything is created, and both buttons open the same panel — creating
 * a completed Task is the same decision about the same fields, made about work
 * the meeting already finished. Dismissal is the other decision: immediate and
 * local-only, with an Undo on the page that dismissed it. A submit that
 * matches an open Task warns first and stops; submitting again is the owner's
 * decision that the work really is different.
 */
function ActionItemRow({
  item,
  lists,
  profiles,
  busy,
  checkDuplicates,
  onPromote,
  onDismiss,
}: {
  item: ActionItem;
  lists: TaskList[];
  profiles: PersonProfile[];
  busy: boolean;
  checkDuplicates: TasksClient["checkDuplicates"];
  onPromote: (values: TaskFormValues, completed: boolean) => Promise<boolean>;
  onDismiss: () => Promise<void>;
}) {
  const [reviewing, setReviewing] = useState<"open" | "completed" | null>(null);
  const [values, setValues] = useState<TaskFormValues>({
    title: item.proposal.title,
    notes: item.proposal.notes,
    dueDate: item.proposal.dueDate ?? "",
    priority: "none",
    listId: INBOX_TASK_LIST_ID,
    responsible: responsibleValue(item.proposal.responsiblePerson),
  });
  /* The Possible duplicate warning (issue #180). Its presence is the armed
     override: the next submit creates the Task, and any edit clears it. */
  const [duplicates, setDuplicates] = useState<Task[] | null>(null);

  /* Closing the panel drops its transient states with it: reopening is a
     fresh look at the proposal, not the old warning again. */
  const closeReview = () => {
    setReviewing(null);
    setDuplicates(null);
  };

  const edit = (next: TaskFormValues) => {
    setValues(next);
    setDuplicates(null);
  };

  async function submitReview() {
    if (duplicates === null) {
      try {
        const check = await checkDuplicates({
          title: values.title,
          dueDate: values.dueDate === "" ? null : values.dueDate,
          responsiblePerson: responsibleFromValue(values.responsible),
        });
        if (check.duplicates.length > 0) {
          setDuplicates(check.duplicates);
          return;
        }
      } catch {
        /* An unanswerable check is not an objection. The warning is advisory,
           so when it cannot be produced the promotion proceeds exactly as it
           did before there was a check at all. */
      }
    }
    setDuplicates(null);
    void onPromote(values, reviewing === "completed").then((promoted) => {
      if (promoted) closeReview();
    });
  }

  return (
    /* The anchor a compact surface links a proposal by (issue #192). */
    <li className="card" id={`action-item-${item.id}`}>
      <h3>{item.proposal.title}</h3>
      <p className="muted">
        Proposed · {item.proposal.dueDate ? `due ${item.proposal.dueDate}` : "no due date"} ·{" "}
        {responsibleLabel(item.proposal.responsiblePerson, profiles)}
        {item.evidence.responsibleSurfaceName
          ? ` · named ${item.evidence.responsibleSurfaceName}`
          : ""}
      </p>
      <p className="muted">
        From a Meeting Debrief.{" "}
        <Link to={`/meeting-debrief/${encodeURIComponent(item.source.debriefRunId)}`}>
          Open full Debrief
        </Link>
      </p>
      {item.state === "promoted" && item.promotedTaskId && (
        <p className="muted">
          Promoted. <Link to={`/tasks#task-${item.promotedTaskId}`}>Open the Task</Link>
        </p>
      )}
      {item.state === "pending" && (
        <div className="toolbar">
          <button
            type="button"
            className="action-button"
            aria-expanded={reviewing === "open"}
            onClick={() => (reviewing === "open" ? closeReview() : setReviewing("open"))}
          >
            Create Task
          </button>
          <button
            type="button"
            className="action-button"
            aria-expanded={reviewing === "completed"}
            onClick={() => (reviewing === "completed" ? closeReview() : setReviewing("completed"))}
          >
            Create completed Task
          </button>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onDismiss()}
          >
            Dismiss
          </button>
        </div>
      )}
      {reviewing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitReview();
          }}
        >
          <div className="field-row">
            <label htmlFor={`action-item-${item.id}-title`}>Title</label>
            <input
              id={`action-item-${item.id}-title`}
              value={values.title}
              autoFocus
              onChange={(event) => edit({ ...values, title: event.target.value })}
            />
          </div>
          <TaskFields
            idPrefix={`action-item-${item.id}`}
            values={values}
            lists={lists}
            profiles={profiles}
            onChange={edit}
          />
          {duplicates && <DuplicateWarning duplicates={duplicates} />}
          <div className="toolbar">
            <button type="submit" className="action-button primary" aria-disabled={busy}>
              {reviewing === "completed"
                ? duplicates
                  ? "Create completed Task anyway"
                  : "Create completed Task"
                : duplicates
                  ? "Create Task anyway"
                  : "Create Task"}
            </button>
            <button type="button" className="action-button" onClick={closeReview}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

/** One trashed Task, with the two operations only Trash offers. */
function TrashRow({
  task,
  busy,
  onRestore,
  onDeleteForever,
  onRetry,
}: {
  task: Task;
  busy: boolean;
  onRestore: () => Promise<void>;
  onDeleteForever: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  /* Two presses rather than a browser dialog: permanent deletion is the one
     Task operation with nothing behind it, and confirming it has to be a
     deliberate act on this screen rather than a reflex on a modal. */
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="card">
      <h3>{task.title}</h3>
      <p className="muted">
        In Trash · was {task.status} · restoring returns it exactly as it was.
      </p>
      {task.externalLink && (
        <p role="status">
          External deletion has not succeeded. The external Task may remain after permanent local
          deletion. {task.externalLink.failure?.message}{" "}
          <button type="button" disabled={busy} onClick={() => void onRetry()}>
            Retry external deletion
          </button>
        </p>
      )}
      <div className="toolbar">
        <button
          type="button"
          className="action-button"
          aria-disabled={busy}
          onClick={() => void onRestore()}
        >
          Restore
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="action-button primary"
              aria-disabled={busy}
              onClick={() => void onDeleteForever()}
            >
              Yes, delete {task.title} forever
            </button>
            <button type="button" className="action-button" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="action-button" onClick={() => setConfirming(true)}>
            Delete forever
          </button>
        )}
      </div>
    </li>
  );
}

export function TasksPage({
  client = tasksApi,
  people = peopleApi,
}: {
  client?: TasksClient;
  people?: PeopleClient;
}) {
  useTitle("Tasks");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trash, setTrash] = useState<Task[]>([]);
  const [unavailableSources, setUnavailableSources] = useState<string[]>([]);
  /** Which Task's edit control should take focus back after a save. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const [lists, setLists] = useState<TaskList[]>([]);
  /* Asana's destination state, its chosen containers, and the answer of the
     last Check connection (issue #189). */
  const [asana, setAsana] = useState<AsanaDestination | null>(null);
  const [asanaToken, setAsanaToken] = useState("");
  /* The answer of the last Check connection: the user the token belongs to
     and the workspaces it reaches. Only ever filled by an explicit check. */
  const [asanaCheck, setAsanaCheck] = useState<AsanaCheckConnection | null>(null);
  const [asanaProjectList, setAsanaProjectList] = useState<{ gid: string; name: string }[]>([]);
  const [asanaSectionList, setAsanaSectionList] = useState<{ gid: string; name: string }[]>([]);
  const [asanaNotice, setAsanaNotice] = useState<string | null>(null);
  const [asanaError, setAsanaError] = useState<string | null>(null);
  const [asanaBusy, setAsanaBusy] = useState(false);
  /** The most recently dismissed proposal, while its Undo stays available. */
  const [lastDismissed, setLastDismissed] = useState<ActionItem | null>(null);
  const [pending, setPending] = useState<ActionItem[]>([]);
  const [dismissed, setDismissed] = useState<ActionItem[]>([]);
  const undoRef = useRef<HTMLButtonElement>(null);
  const [destination, setDestination] = useState<GoogleTasksDestination | null>(null);
  /* The Action Item Policy (issue #181), and whether the owner has been shown
     what turning it on would send outward. The warning is state rather than a
     branch in the button: the server refuses the unconfirmed change, and the
     card has to say why before asking again. */
  const [policy, setPolicy] = useState<ActionItemPolicySetting | null>(null);
  const [policyWarning, setPolicyWarning] = useState<string | null>(null);
  const [googleLists, setGoogleLists] = useState<{ id: string; title: string }[]>([]);
  /* The filters, held as one value so the load below is a function of them
     rather than of five pieces of state that can disagree. */
  const [filters, setFilters] = useState({
    search: "",
    listId: "",
    priority: "",
    responsible: "",
    linked: "",
  });
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [quickTitle, setQuickTitle] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickValues, setQuickValues] = useState<TaskFormValues>({
    title: "",
    notes: "",
    dueDate: "",
    priority: "none",
    listId: INBOX_TASK_LIST_ID,
    responsible: OWNER_VALUE,
  });
  /* The Possible duplicate warning (issue #180), set when a submit matched an
     open Task. Its presence is also the armed override: the next submit is
     the owner's explicit decision to create the Task anyway. */
  const [quickDuplicates, setQuickDuplicates] = useState<Task[] | null>(null);
  const quickInput = useRef<HTMLInputElement>(null);
  /** Any edit after a warning makes it stale: it described other values. */
  const editQuick = (values: TaskFormValues) => {
    setQuickValues(values);
    setQuickDuplicates(null);
  };
  const editQuickTitle = (title: string) => {
    setQuickTitle(title);
    setQuickDuplicates(null);
  };
  const [newListName, setNewListName] = useState("");

  /** What the page shows: the filtered Tasks, Trash, and the Action Items. */
  const load = useCallback(async () => {
    const [index, trashed, queue, dismissedQueue] = await Promise.all([
      client.tasks({
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.listId ? { listId: filters.listId } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.responsible ? { responsible: filters.responsible } : {}),
        ...(filters.linked ? { linked: filters.linked === "linked" } : {}),
      }),
      client.tasks({ trashed: true }),
      client.actionItems({ state: "pending" }),
      client.actionItems({ state: "dismissed" }),
    ]);
    setTasks(index.tasks);
    setLists(index.lists);
    setToday(index.today);
    setUnavailableSources(index.unavailableSources);
    setTrash(trashed.tasks);
    setPending(queue.items);
    setDismissed(dismissedQueue.items);
  }, [client, filters]);

  useEffect(() => {
    let live = true;
    Promise.all([
      load(),
      people.people(),
      client.googleDestination(),
      client.asanaDestination(),
      client.actionItemPolicy(),
    ])
      .then(([, directory, googleDestination, asanaDestination, actionItemPolicy]) => {
        if (!live) return;
        /* The same test the Workspace applies: offering a Profile it would
           refuse turns a chooser into a way to earn a 400. */
        setProfiles(
          directory.filter(
            (profile) => profile.archivedAt === null && profile.mergedInto === undefined,
          ),
        );
        setDestination(googleDestination);
        setAsana(asanaDestination);
        setPolicy(actionItemPolicy);
      })
      .catch((err) => {
        if (live) setError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, people, load]);

  useEffect(() => {
    void client
      .refresh()
      .then(load)
      .catch((err) => setError(errorMessage(err)));
    // The Tasks-open trigger runs once; filter changes only reload the local projection.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [client]);

  /* Dismissal moves its row out of the pending queue, so focus moves to the
     Undo that reverses it — the one control that can bring the row back. */
  useEffect(() => {
    if (lastDismissed !== null) undoRef.current?.focus();
  }, [lastDismissed]);

  /* A saved edit can move a Task into a different due-date group, which
     re-parents its row and replaces the button that was focused. Focus is
     therefore restored here, once the redrawn list is in the document, rather
     than by the row that no longer exists. */
  useEffect(() => {
    if (focusTaskId === null) return;
    document.getElementById(`task-${focusTaskId}-edit`)?.focus();
    setFocusTaskId(null);
  }, [focusTaskId, tasks]);

  /**
   * One place where a Workspace write and its consequences meet: the action
   * runs, the page reloads what it shows, and a refusal becomes a message
   * rather than a silently unchanged screen.
   */
  const act = useCallback(
    async (announce: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        setNotice(announce);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  /**
   * The same discipline as act, scoped to the Asana card: its writes answer
   * with their new state, so nothing here reloads the page's Tasks — a
   * refusal becomes the card's message, not a silently unchanged screen.
   */
  const asanaAct = useCallback(
    async (announce: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (asanaBusy) return false;
      setAsanaBusy(true);
      setAsanaError(null);
      try {
        await action();
        setAsanaNotice(announce);
        return true;
      } catch (err) {
        setAsanaError(errorMessage(err));
        return false;
      } finally {
        setAsanaBusy(false);
      }
    },
    [asanaBusy],
  );

  /**
   * Restore one dismissed Action Item to pending, whether from the temporary
   * Undo or from the Dismissed history. A spent Undo goes away with the item
   * it remembered.
   */
  const restoreItem = (item: ActionItem): Promise<void> =>
    act(`Restored ${item.proposal.title}.`, () => client.restoreActionItem(item.id)).then(
      (restored) => {
        if (restored && lastDismissed?.id === item.id) setLastDismissed(null);
      },
    );

  async function quickAdd(event: React.FormEvent) {
    event.preventDefault();
    const title = quickOpen ? quickValues.title : quickTitle;
    const candidate: TaskDuplicateCandidate = {
      title,
      dueDate: quickOpen && quickValues.dueDate !== "" ? quickValues.dueDate : null,
      responsiblePerson: quickOpen
        ? responsibleFromValue(quickValues.responsible)
        : { kind: "owner" },
    };
    /* Warn, then stop: the first submit that matches an open Task asks the
       question, and the next one — "Add anyway" — is the owner's answer. The
       check itself refuses nothing, so neither does this form. */
    if (quickDuplicates === null && title.trim() !== "") {
      try {
        const { duplicates } = await client.checkDuplicates(candidate);
        if (duplicates.length > 0) {
          setQuickDuplicates(duplicates);
          return;
        }
      } catch {
        /* As above: a check that cannot answer lets the capture through. */
      }
    }
    setQuickDuplicates(null);
    const added = await act(`Added ${title.trim()}.`, () =>
      client.createTask(
        quickOpen
          ? {
              title: quickValues.title,
              notes: quickValues.notes,
              dueDate: quickValues.dueDate === "" ? null : quickValues.dueDate,
              priority: quickValues.priority,
              listId: quickValues.listId,
              responsiblePerson: responsibleFromValue(quickValues.responsible),
            }
          : { title },
      ),
    );
    if (!added) return;
    setQuickTitle("");
    setQuickValues({
      title: "",
      notes: "",
      dueDate: "",
      priority: "none",
      listId: INBOX_TASK_LIST_ID,
      responsible: OWNER_VALUE,
    });
    quickInput.current?.focus();
  }

  /* Open and Completed differ by which Tasks they hold, not by what a Task
     row can do — a completed Task is reopened and edited exactly like an open
     one, so both sections render through here. */
  const renderTask = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      lists={lists}
      profiles={profiles}
      busy={busy}
      onComplete={async () => {
        await act(`Completed ${task.title}.`, () => client.completeTask(task.id));
      }}
      onReopen={async () => {
        await act(`Reopened ${task.title}.`, () => client.reopenTask(task.id));
      }}
      sourceAvailable={!unavailableSources.includes(task.id)}
      onTrash={async (external) => {
        await act(`Moved ${task.title} to Trash.`, () => client.trashTask(task.id, external));
      }}
      onLink={async () => {
        await act(`Sent ${task.title} to ${providerName(task.destination)}.`, () =>
          client.linkTask(task.id),
        );
      }}
      onRetry={async () => {
        await act("Retried the External Task Link.", () => client.retryTask(task.id));
      }}
      onRecover={async (remoteId) => {
        await act("Recovered the existing External Task Link.", () =>
          client.recoverCreation(task.id, remoteId),
        );
      }}
      onRecreate={async () => {
        await act(`Recreated ${task.title} in ${providerName(task.destination)}.`, () =>
          client.recreateTask(task.id),
        );
      }}
      onRemoveLink={async () => {
        await act(`Removed the ${providerName(task.destination)} link from ${task.title}.`, () =>
          client.removeTaskLink(task.id),
        );
      }}
      onResolve={async (kind, keep) => {
        await act(
          keep === "app"
            ? `Kept this Workspace's version of ${task.title}.`
            : `Kept the ${providerName(task.destination)} version of ${task.title}.`,
          () => client.resolveTaskLink(task.id, kind, keep),
        );
      }}
      onSave={async (values) => {
        const saved = await act(`Saved ${values.title.trim()}.`, () =>
          client.updateTask(task.id, {
            title: values.title,
            notes: values.notes,
            dueDate: values.dueDate === "" ? null : values.dueDate,
            priority: values.priority,
            listId: values.listId,
            responsiblePerson: responsibleFromValue(values.responsible),
          }),
        );
        /* Only once the redrawn list has landed: asking for focus before the
           reload would hand it to a row the reload is about to replace. */
        if (saved) setFocusTaskId(task.id);
        return saved;
      }}
    />
  );

  const openGroups = groupTasks(
    tasks.filter((task) => task.status === "open"),
    today,
  );
  const openCount = TASK_GROUPS.reduce((total, group) => total + openGroups[group].length, 0);
  const filtered = Object.values(filters).some((value) => value !== "");
  const completed = tasks.filter((task) => task.status === "completed");

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        Tasks
      </h1>
      <p className="muted">
        Every Task the Workspace owns, however it got here. Nothing on this page needs Google,
        Asana, or any other account.
      </p>

      <div className="toolbar">
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("Refreshed linked Tasks.", () => client.refresh())}
        >
          Refresh Tasks
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("Retried failed links.", () => client.retryFailed())}
        >
          Retry all failed links
        </button>
      </div>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {notice ?? ""}
      </p>

      <form className="card" onSubmit={(event) => void quickAdd(event)}>
        <h2>Quick Add</h2>
        <div className="field-row">
          <label htmlFor="quick-add-title">Task title</label>
          <input
            id="quick-add-title"
            ref={quickInput}
            value={quickOpen ? quickValues.title : quickTitle}
            autoComplete="off"
            onChange={(event) =>
              quickOpen
                ? editQuick({ ...quickValues, title: event.target.value })
                : editQuickTitle(event.target.value)
            }
          />
          <button type="submit" className="action-button primary" aria-disabled={busy}>
            {quickDuplicates ? "Add anyway" : "Add task"}
          </button>
        </div>
        <button
          type="button"
          className="action-button"
          aria-expanded={quickOpen}
          onClick={() => {
            setQuickValues({ ...quickValues, title: quickOpen ? quickValues.title : quickTitle });
            setQuickTitle(quickOpen ? quickValues.title : quickTitle);
            /* The values the form means may change with the layout it is in,
               so the toggle re-arms the duplicate check like any edit. */
            setQuickDuplicates(null);
            setQuickOpen((shown) => !shown);
          }}
        >
          {quickOpen ? "Hide details" : "Add details"}
        </button>
        {quickOpen && (
          <TaskFields
            idPrefix="quick-add"
            values={quickValues}
            lists={lists}
            profiles={profiles}
            onChange={editQuick}
          />
        )}
        {quickDuplicates && <DuplicateWarning duplicates={quickDuplicates} />}
      </form>

      <h2>Open</h2>
      {/* Grouped by due date in the Workspace timezone, which the server
          resolves and serves: a date-only due date belongs to the owner's own
          day rather than to the browser's. */}
      <form className="card" onSubmit={(event) => event.preventDefault()}>
        <div className="field-row">
          <label htmlFor="task-search">Search Tasks</label>
          <input
            id="task-search"
            type="search"
            value={filters.search}
            autoComplete="off"
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="filter-list">Filter by Task List</label>
            <select
              id="filter-list"
              value={filters.listId}
              onChange={(event) => setFilters({ ...filters, listId: event.target.value })}
            >
              <option value="">Every list</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-priority">Filter by priority</label>
            <select
              id="filter-priority"
              value={filters.priority}
              onChange={(event) => setFilters({ ...filters, priority: event.target.value })}
            >
              <option value="">Any priority</option>
              {TASK_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-responsible">Filter by Responsible Person</label>
            <select
              id="filter-responsible"
              value={filters.responsible}
              onChange={(event) => setFilters({ ...filters, responsible: event.target.value })}
            >
              <option value="">Anyone</option>
              <option value="owner">You</option>
              <option value="nobody">Nobody</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fullName ?? profile.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-linked">Filter by External Task Link</label>
            <select
              id="filter-linked"
              value={filters.linked}
              onChange={(event) => setFilters({ ...filters, linked: event.target.value })}
            >
              <option value="">Linked or not</option>
              <option value="linked">Linked</option>
              <option value="unlinked">Not linked</option>
            </select>
          </div>
        </div>
      </form>
      {loading && <p className="muted">Loading…</p>}
      {/* Two empty states, because they mean different things: a Workspace
          with no open work at all, and a filter that happens to exclude all of
          it. Telling someone they have no Tasks while a filter is on would be
          untrue. */}
      {!loading &&
        openCount === 0 &&
        (filtered ? (
          <p className="muted">No open Tasks match those filters.</p>
        ) : (
          <p className="muted">No open Tasks. Quick Add above captures one.</p>
        ))}
      {TASK_GROUPS.map((group) =>
        openGroups[group].length === 0 ? null : (
          <section key={group}>
            <h3>{TASK_GROUP_LABELS[group]}</h3>
            <ul className="card-list">{openGroups[group].map(renderTask)}</ul>
          </section>
        ),
      )}

      <h2 id="action-items">Action Items</h2>
      <p className="muted">
        Commitments a Meeting Debrief proposed. A proposal is not a Task, and nothing here has been
        accepted.
      </p>
      {!loading && pending.length === 0 && <p className="muted">No Action Items are waiting.</p>}
      {lastDismissed && (
        <p className="card" role="status">
          Dismissed {lastDismissed.proposal.title}.{" "}
          <button
            ref={undoRef}
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void restoreItem(lastDismissed)}
          >
            Undo
          </button>
        </p>
      )}
      <ul className="card-list">
        {pending.map((item) => (
          <ActionItemRow
            key={item.id}
            item={item}
            lists={lists}
            profiles={profiles}
            busy={busy}
            checkDuplicates={client.checkDuplicates}
            onPromote={(values, completed) =>
              act(`Created ${values.title.trim()}.`, () =>
                client.promoteActionItem(item.id, {
                  title: values.title,
                  notes: values.notes,
                  dueDate: values.dueDate === "" ? null : values.dueDate,
                  priority: values.priority,
                  listId: values.listId,
                  responsiblePerson: responsibleFromValue(values.responsible),
                  completed,
                }),
              )
            }
            onDismiss={() =>
              act(`Dismissed ${item.proposal.title}.`, () =>
                client.dismissActionItem(item.id),
              ).then((dismissedOk) => {
                if (dismissedOk) setLastDismissed(item);
              })
            }
          />
        ))}
      </ul>
      {dismissed.length > 0 && (
        <section aria-labelledby="dismissed-action-items-heading">
          <h3 id="dismissed-action-items-heading">Dismissed</h3>
          <p className="muted">
            Proposals the owner set aside. Nothing here became a Task, and restoring returns one to
            pending.
          </p>
          <ul className="card-list">
            {dismissed.map((item) => (
              <li key={item.id} className="card">
                <h3>{item.proposal.title}</h3>
                <p className="muted">
                  Dismissed ·{" "}
                  <Link to={`/meeting-debrief/${encodeURIComponent(item.source.debriefRunId)}`}>
                    Open full Debrief
                  </Link>
                </p>
                <div className="toolbar">
                  <button
                    type="button"
                    className="action-button"
                    aria-disabled={busy}
                    onClick={() => void restoreItem(item)}
                  >
                    Restore to pending
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>Trash</h2>
      <p className="muted">
        Nothing here is gone. Restoring returns a Task to the state it was in; deleting one forever
        cannot be undone.
      </p>
      {!loading && trash.length === 0 && <p className="muted">Trash is empty.</p>}
      <ul className="card-list">
        {trash.map((task) => (
          <TrashRow
            key={task.id}
            task={task}
            busy={busy}
            onRestore={async () => {
              await act(`Restored ${task.title}.`, () => client.restoreTask(task.id));
            }}
            onRetry={async () => {
              await act("Retried external deletion.", () => client.retryTask(task.id));
            }}
            onDeleteForever={async () => {
              await act(`Deleted ${task.title} forever.`, () => client.deleteTaskForever(task.id));
            }}
          />
        ))}
      </ul>

      <h2>Completed</h2>
      {!loading && completed.length === 0 && <p className="muted">Nothing completed yet.</p>}
      <ul className="card-list">{completed.map(renderTask)}</ul>

      <h2>Action Item Policy</h2>
      <p className="muted">
        A Meeting Debrief proposes commitments; this decides what happens to them next. Stage all
        waits for you. Automatically create my Tasks accepts only a first extraction's commitments
        that the Debrief confidently resolved to you, that no open Task already looks like — every
        other proposal still waits.
      </p>
      {policy && (
        <div className="card">
          <p className="muted">
            {policy.policy === "auto-create-mine"
              ? "Automatically create my Tasks · my own commitments become Tasks without review"
              : "Stage all Action Items · every proposal waits for your review"}
          </p>
          {policyWarning !== null && <p role="alert">{policyWarning}</p>}
          <div className="toolbar">
            <button
              type="button"
              className="action-button primary"
              aria-disabled={busy}
              onClick={() => {
                const next =
                  policy.policy === "auto-create-mine" ? "stage-all" : "auto-create-mine";
                void act(
                  next === "auto-create-mine"
                    ? "My own commitments now become Tasks automatically."
                    : "Every Action Item now waits for review.",
                  async () => {
                    try {
                      setPolicy(await client.setActionItemPolicy(next, policyWarning !== null));
                      setPolicyWarning(null);
                    } catch (err) {
                      /* The one refusal this card answers itself: the owner
                         has not yet been told what the change would send
                         outward, so tell them and let the same button ask
                         again. */
                      if (policy.externalDestination !== null && policyWarning === null) {
                        setPolicyWarning(
                          `Tasks created automatically would be written to ${policy.externalDestination} ` +
                            "without review. Select this again to confirm.",
                        );
                        return;
                      }
                      throw err;
                    }
                  },
                );
              }}
            >
              {policy.policy === "auto-create-mine"
                ? "Stage all Action Items"
                : "Automatically create my Tasks"}
            </button>
          </div>
        </div>
      )}

      <h2>Task Destination</h2>
      <p className="muted">
        Google Tasks and Asana are optional. Everything above works without them, and a Task you
        send carries only its own title, notes and due date — nothing about you leaves this
        Workspace with it.
      </p>
      {destination && (
        <div className="card">
          <p className="muted">
            {destination.enabled
              ? `Enabled · new Tasks can be created in ${destination.taskListTitle}`
              : "Not enabled · every Task stays in this Workspace"}
          </p>
          <div className="field-row">
            <label htmlFor="google-task-list">Google Task List</label>
            <select
              id="google-task-list"
              value={destination.taskListId}
              onChange={(event) =>
                setDestination({ ...destination, taskListId: event.target.value })
              }
            >
              <option value="">Choose a list</option>
              {googleLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="action-button"
              aria-disabled={busy}
              onClick={() => {
                void act("Read the Google Task Lists.", async () => {
                  setGoogleLists((await client.googleLists()).lists);
                });
              }}
            >
              Load lists from Google
            </button>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="action-button primary"
              aria-disabled={busy}
              onClick={() => {
                void act("Saved the Task Destination.", async () => {
                  setDestination(
                    await client.setGoogleDestination({
                      enabled: !destination.enabled,
                      taskListId: destination.taskListId,
                    }),
                  );
                });
              }}
            >
              {destination.enabled ? "Disable Google Tasks" : "Enable Google Tasks"}
            </button>
          </div>
        </div>
      )}
      {asana?.available && (
        <div className="card">
          <h3>Asana</h3>
          <p className="muted">
            {asana.connected
              ? `Connected · token ${asana.tokenHint}` +
                (asana.enabled
                  ? ` · enabled · new Tasks go to ${asana.projectName}${
                      asana.sectionName ? ` · ${asana.sectionName}` : ""
                    } in ${asana.workspaceName}`
                  : " · not enabled")
              : "Not connected · every Task stays in this Workspace"}
          </p>
          {asanaError && <p role="alert">{asanaError}</p>}
          {asanaNotice && <p role="status">{asanaNotice}</p>}
          {!asana.connected ? (
            <form
              className="field-row"
              onSubmit={(event) => {
                event.preventDefault();
                void asanaAct("Connected Asana.", async () => {
                  setAsanaCheck(await client.asanaConnect(asanaToken));
                  setAsanaToken("");
                  setAsana(await client.asanaDestination());
                  setAsanaProjectList([]);
                  setAsanaSectionList([]);
                });
              }}
            >
              <label htmlFor="asana-token">Asana personal access token</label>
              <input
                id="asana-token"
                type="password"
                value={asanaToken}
                autoComplete="off"
                onChange={(event) => setAsanaToken(event.target.value)}
              />
              <button
                type="submit"
                className="action-button"
                aria-disabled={asanaBusy || asanaToken.trim() === ""}
              >
                Connect Asana
              </button>
            </form>
          ) : (
            <>
              {asanaCheck && (
                <p className="muted">
                  Checked as {asanaCheck.user.name}
                  {asanaCheck.user.email ? ` (${asanaCheck.user.email})` : ""} — workspaces:{" "}
                  {asanaCheck.workspaces.map((workspace) => workspace.name).join(", ")}
                </p>
              )}
              <div className="field-row">
                <label htmlFor="asana-workspace">Workspace</label>
                <select
                  id="asana-workspace"
                  value={asana.workspaceGid}
                  onChange={(event) => {
                    const workspaceGid = event.target.value;
                    setAsana({ ...asana, workspaceGid });
                    void asanaAct("Read the Asana projects.", async () => {
                      setAsanaProjectList((await client.asanaProjects(workspaceGid)).projects);
                      setAsanaSectionList([]);
                    });
                  }}
                >
                  <option value="">Choose a workspace</option>
                  {asanaCheck?.workspaces.map((workspace) => (
                    <option key={workspace.gid} value={workspace.gid}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="asana-project">Project</label>
                <select
                  id="asana-project"
                  value={asana.projectGid}
                  onChange={(event) => {
                    const projectGid = event.target.value;
                    /* A section belongs to its project: switching projects
                       clears the chosen one, so the next enable sends an
                       explicit "no section" rather than a stale gid the new
                       project would refuse. */
                    setAsana({ ...asana, projectGid, sectionGid: null, sectionName: null });
                    void asanaAct("Read the Asana sections.", async () => {
                      setAsanaSectionList((await client.asanaSections(projectGid)).sections);
                    });
                  }}
                >
                  <option value="">Choose a project</option>
                  {asanaProjectList.map((project) => (
                    <option key={project.gid} value={project.gid}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="asana-section">Section (optional)</label>
                <select
                  id="asana-section"
                  value={asana.sectionGid ?? ""}
                  onChange={(event) => {
                    const sectionGid = event.target.value;
                    const section = asanaSectionList.find((one) => one.gid === sectionGid);
                    setAsana({
                      ...asana,
                      sectionGid: sectionGid === "" ? null : sectionGid,
                      sectionName: section?.name ?? null,
                    });
                  }}
                >
                  <option value="">No section</option>
                  {asanaSectionList.map((section) => (
                    <option key={section.gid} value={section.gid}>
                      {section.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="toolbar">
                <button
                  type="button"
                  className="action-button"
                  aria-disabled={asanaBusy}
                  onClick={() => {
                    void asanaAct("Asana connection verified.", async () => {
                      setAsanaCheck(await client.asanaCheck());
                      setAsana(await client.asanaDestination());
                    });
                  }}
                >
                  Check connection
                </button>
                <button
                  type="button"
                  className="action-button primary"
                  aria-disabled={asanaBusy || !asana.connected}
                  onClick={() => {
                    void asanaAct(
                      asana.enabled
                        ? "Disabled the Asana destination."
                        : "Enabled the Asana destination.",
                      async () => {
                        setAsana(
                          await client.setAsanaDestination({
                            enabled: !asana.enabled,
                            workspaceGid:
                              asana.workspaceGid === "" ? undefined : asana.workspaceGid,
                            projectGid: asana.projectGid === "" ? undefined : asana.projectGid,
                            sectionGid: asana.sectionGid ?? null,
                          }),
                        );
                      },
                    );
                  }}
                >
                  {asana.enabled ? "Disable Asana Tasks" : "Enable Asana Tasks"}
                </button>
                <button
                  type="button"
                  className="action-button"
                  aria-disabled={asanaBusy}
                  onClick={() => {
                    void asanaAct(
                      "Disconnected Asana. Saved Tasks here are unaffected.",
                      async () => {
                        await client.asanaDisconnect();
                        setAsanaCheck(null);
                        setAsanaProjectList([]);
                        setAsanaSectionList([]);
                        setAsana(await client.asanaDestination());
                      },
                    );
                  }}
                >
                  Disconnect Asana
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <h2>Task Lists</h2>
      <p className="muted">
        Every Task belongs to exactly one list. Inbox always exists and holds anything you do not
        file elsewhere.
      </p>
      <ul className="card-list">
        {lists.map((list) => (
          <TaskListRow
            key={list.id}
            list={list}
            count={tasks.filter((task) => task.listId === list.id).length}
            busy={busy}
            onRename={(name) =>
              act(`Renamed the list to ${name}.`, () => client.renameTaskList(list.id, name))
            }
            onDelete={() =>
              act(`Deleted the list ${list.name}.`, () => client.deleteTaskList(list.id))
            }
          />
        ))}
      </ul>
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void act(`Created the list ${newListName.trim()}.`, () =>
            client.createTaskList(newListName),
          ).then((created) => {
            if (created) setNewListName("");
          });
        }}
      >
        <div className="field-row">
          <label htmlFor="new-task-list">New Task List</label>
          <input
            id="new-task-list"
            value={newListName}
            autoComplete="off"
            onChange={(event) => setNewListName(event.target.value)}
          />
          <button type="submit" className="action-button" aria-disabled={busy}>
            Create list
          </button>
        </div>
      </form>
    </>
  );
}

/** One Task List, with the two operations Inbox does not have. */
function TaskListRow({
  list,
  count,
  busy,
  onRename,
  onDelete,
}: {
  list: TaskList;
  count: number;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [name, setName] = useState(list.name);
  const permanent = list.id === INBOX_TASK_LIST_ID;
  return (
    <li className="card">
      <h3>{list.name}</h3>
      <p className="muted">
        {count} Task{count === 1 ? "" : "s"} · destination: {list.defaultDestination.provider}
        {permanent ? " · always exists" : ""}
      </p>
      {!permanent && (
        <form
          className="field-row"
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(name);
          }}
        >
          <label htmlFor={`list-${list.id}-name`}>Name</label>
          <input
            id={`list-${list.id}-name`}
            value={name}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="action-button" aria-disabled={busy}>
            Rename
          </button>
          <button
            type="button"
            className="action-button"
            aria-disabled={busy}
            onClick={() => void onDelete()}
          >
            Delete list
          </button>
        </form>
      )}
    </li>
  );
}
