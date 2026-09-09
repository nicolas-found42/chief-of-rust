import type { AsanaUser } from "../asana/client.js";
import { TaskValidationError } from "./tasks.js";

/**
 * Asana as a Task Destination (issue #189, ADR-0056).
 *
 * The owner connects with a personal access token; Check connection proves it
 * against Asana before it is stored, and a destination — workspace, project,
 * optional section — is validated against the account before it is enabled.
 * A destination that does not exist would turn every later creation into the
 * same failure, discovered one Task at a time.
 *
 * The token is stored once, through the config store — the credential
 * boundary — and is never returned by anything here: status answers carry a
 * hint only, and failures are the sanitized sentences the client raises.
 * Nothing in this module reads or writes a single Asana Task; listing
 * projects and sections is listing containers, not importing work.
 */

export interface AsanaDestinationSettings {
  token: string;
  lastVerifiedAt: string | null;
  enabled: boolean;
  workspaceGid: string;
  workspaceName: string;
  projectGid: string;
  projectName: string;
  sectionGid: string | null;
  sectionName: string | null;
}

/** What the Tasks page reads. No token field, by construction. */
export interface AsanaDestinationStatus {
  connected: boolean;
  /** The last four characters of the stored token; "" when none is stored. */
  tokenHint: string;
  lastVerifiedAt: string | null;
  enabled: boolean;
  workspaceGid: string;
  workspaceName: string;
  projectGid: string;
  projectName: string;
  sectionGid: string | null;
  sectionName: string | null;
}

export interface AsanaLinkingDeps {
  /** The stored Asana settings, read live. */
  settings: () => AsanaDestinationSettings;
  save: (settings: AsanaDestinationSettings) => void;
  /** The authenticated user and their workspaces, as Asana answers right now. */
  me: (token: string) => Promise<AsanaUser>;
  /** One workspace's projects — containers only. */
  projects: (token: string, workspaceGid: string) => Promise<{ gid: string; name: string }[]>;
  /** One project's sections — containers only. */
  sections: (token: string, projectGid: string) => Promise<{ gid: string; name: string }[]>;
}

/** The answer Check connection gives: who this token is, and what it reaches. */
export interface AsanaCheckConnection {
  user: { gid: string; name: string; email: string | null };
  workspaces: { gid: string; name: string }[];
}

function tokenHint(token: string): string {
  return token === "" ? "" : `…${token.slice(-4)}`;
}

export class AsanaLinking {
  constructor(private readonly deps: AsanaLinkingDeps) {}

  status(): AsanaDestinationStatus {
    const settings = this.deps.settings();
    return {
      connected: settings.token !== "",
      tokenHint: tokenHint(settings.token),
      lastVerifiedAt: settings.lastVerifiedAt,
      enabled: settings.enabled,
      workspaceGid: settings.workspaceGid,
      workspaceName: settings.workspaceName,
      projectGid: settings.projectGid,
      projectName: settings.projectName,
      sectionGid: settings.sectionGid,
      sectionName: settings.sectionName,
    };
  }

  /**
   * Verify a personal access token against Asana and store it only if Asana
   * accepts it. The full token goes in with the request and never comes back
   * out: the answer names the user it belongs to, and the hint is all this
   * Workspace can say about the token afterwards.
   */
  async connect(token: string): Promise<AsanaCheckConnection & { tokenHint: string }> {
    const candidate = token.trim();
    if (candidate === "") {
      throw new TaskValidationError("invalid-token", "An Asana personal access token is required.");
    }
    let me: AsanaUser;
    try {
      me = await this.deps.me(candidate);
    } catch (error) {
      throw new TaskValidationError("invalid-token", asanaRefusal(error));
    }
    this.deps.save({
      ...this.deps.settings(),
      token: candidate,
      lastVerifiedAt: new Date().toISOString(),
    });
    return {
      user: { gid: me.gid, name: me.name, email: me.email },
      workspaces: me.workspaces,
      tokenHint: tokenHint(candidate),
    };
  }

  /**
   * Forget the token and disable the destination. The remembered destination
   * gids are kept — like Google Tasks' remembered list, they make reconnecting
   * a two-click affair — and every local Task goes on working; disabling an
   * outward destination has never been a way to lose accepted work.
   */
  disconnect(): AsanaDestinationStatus {
    this.deps.save({
      ...this.deps.settings(),
      token: "",
      lastVerifiedAt: null,
      enabled: false,
    });
    return this.status();
  }

  /**
   * Check connection on demand: prove the stored token still works and
   * answer with the user it identifies and the workspaces it reaches. A
   * stale token is an actionable refusal, not a silent state change.
   */
  async checkConnection(): Promise<AsanaCheckConnection> {
    const settings = this.deps.settings();
    if (settings.token === "") {
      throw new TaskValidationError(
        "invalid-token",
        "No Asana token is stored. Connect Asana first.",
      );
    }
    let me: AsanaUser;
    try {
      me = await this.deps.me(settings.token);
    } catch (error) {
      throw new TaskValidationError("invalid-token", asanaRefusal(error));
    }
    this.deps.save({ ...settings, lastVerifiedAt: new Date().toISOString() });
    return {
      user: { gid: me.gid, name: me.name, email: me.email },
      workspaces: me.workspaces,
    };
  }

  /** The projects of one workspace — the list a destination is chosen from. */
  async availableProjects(workspaceGid: string): Promise<{ gid: string; name: string }[]> {
    const token = this.requireToken();
    try {
      return await this.deps.projects(token, workspaceGid);
    } catch (error) {
      throw new TaskValidationError("invalid-destination", asanaRefusal(error));
    }
  }

  /** The sections of one project, scoped to it — never the project's Tasks. */
  async availableSections(projectGid: string): Promise<{ gid: string; name: string }[]> {
    const token = this.requireToken();
    try {
      return await this.deps.sections(token, projectGid);
    } catch (error) {
      throw new TaskValidationError("invalid-destination", asanaRefusal(error));
    }
  }

  /**
   * Enable or disable the destination, and choose where Tasks go. Enabling
   * validates the whole chain live — the project belongs to the workspace,
   * the section to the project — because an inaccessible destination is the
   * same failure whether it was never reachable or has since slipped away.
   *
   * Disabling keeps the remembered destination and touches nothing else:
   * every local Task, and any link already on one, is unaffected.
   */
  async select(input: {
    enabled: boolean;
    workspaceGid?: string;
    projectGid?: string;
    sectionGid?: string | null;
  }): Promise<AsanaDestinationStatus> {
    const current = this.deps.settings();
    if (current.token === "") {
      throw new TaskValidationError(
        "invalid-destination",
        "Connect Asana before choosing a destination.",
      );
    }
    if (!input.enabled) {
      this.deps.save({ ...current, enabled: false });
      return this.status();
    }
    const workspaceGid = input.workspaceGid ?? current.workspaceGid;
    const projectGid = input.projectGid ?? current.projectGid;
    if (workspaceGid === "" || projectGid === "") {
      throw new TaskValidationError(
        "invalid-destination",
        "Choose which Asana workspace and project new Tasks are created in.",
      );
    }
    const workspaceName = current.workspaceGid === workspaceGid ? current.workspaceName : null;
    let projects: { gid: string; name: string }[];
    try {
      projects = await this.deps.projects(current.token, workspaceGid);
    } catch (error) {
      throw new TaskValidationError("invalid-destination", asanaRefusal(error));
    }
    const project = projects.find((candidate) => candidate.gid === projectGid);
    if (!project) {
      throw new TaskValidationError(
        "invalid-destination",
        "Asana does not have that project in the chosen workspace. Choose one of the projects it offers.",
      );
    }
    /* An explicit null clears a stored section ("No section" in the UI); an
       absent field keeps the current one. Treating null as absent would make
       a stored section impossible to remove and pin a project switch to a
       section the new project does not hold. */
    const sectionGid = "sectionGid" in input ? (input.sectionGid ?? null) : current.sectionGid;
    let section: { gid: string; name: string } | null = null;
    if (sectionGid !== null && sectionGid !== "") {
      let sections: { gid: string; name: string }[];
      try {
        sections = await this.deps.sections(current.token, projectGid);
      } catch (error) {
        throw new TaskValidationError("invalid-destination", asanaRefusal(error));
      }
      section = sections.find((candidate) => candidate.gid === sectionGid) ?? null;
      if (section === null) {
        throw new TaskValidationError(
          "invalid-destination",
          "Asana does not have that section in the chosen project. Choose one of the sections it offers.",
        );
      }
    }
    let savedWorkspaceName = workspaceName;
    if (savedWorkspaceName === null) {
      try {
        savedWorkspaceName = await this.workspaceName(current.token, workspaceGid);
      } catch (error) {
        /* The name is a convenience read like the project list above it: a
           failure during it is a destination refusal, not a server crash. */
        throw new TaskValidationError("invalid-destination", asanaRefusal(error));
      }
    }
    this.deps.save({
      ...current,
      enabled: true,
      workspaceGid,
      workspaceName: savedWorkspaceName,
      projectGid: project.gid,
      projectName: project.name,
      sectionGid: section?.gid ?? null,
      sectionName: section?.name ?? null,
    });
    return this.status();
  }

  private requireToken(): string {
    const token = this.deps.settings().token;
    if (token === "") {
      throw new TaskValidationError(
        "invalid-token",
        "No Asana token is stored. Connect Asana first.",
      );
    }
    return token;
  }

  /** The workspace's current name from Asana — one small read, once, on save. */
  private async workspaceName(token: string, workspaceGid: string): Promise<string> {
    const me = await this.deps.me(token);
    return me.workspaces.find((workspace) => workspace.gid === workspaceGid)?.name ?? workspaceGid;
  }
}

/**
 * The sentence an Asana refusal carries. The client's messages are already
 * sanitized — no token, no request dump — so this only sorts the actionable
 * from the transient: a person can fix a refused token, and the rest says
 * the Task is unaffected either way.
 */
function asanaRefusal(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw === "") {
    return "Asana could not be reached; nothing here changed.";
  }
  return raw;
}
