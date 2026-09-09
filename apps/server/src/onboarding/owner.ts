import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ConfirmedOwnerReference,
  GoogleConnectionState,
  OwnerOnboardingProposal,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";

/**
 * Owner onboarding (issue #123): the connected Google identity proposes the
 * Workspace owner's canonical Person Profile, and only an explicit owner
 * action confirms it. The confirmed reference pins both the Profile ID and
 * the exact revision (spec #117 Implementation Decisions 5), and it is held
 * for one Google identity — a changed or disconnected connection voids it
 * (ADR-0036: the identity is read once and held until the connection changes).
 *
 * Durability: the reference survives restarts in a small JSON state file
 * under `<workspaceDir>/onboarding/`. No credential material is ever stored
 * — the file carries the profile reference and the identity email only.
 */
export class OwnerOnboarding {
  private readonly people: WorkspacePersonProfiles;
  private readonly stateFile: string;
  private readonly now: () => Date;
  private connectedEmail: string | null = null;

  constructor(deps: { people: WorkspacePersonProfiles; workspaceDir: string; now?: () => Date }) {
    this.people = deps.people;
    this.stateFile = join(deps.workspaceDir, "onboarding", "owner-confirmation.json");
    this.now = deps.now ?? (() => new Date());
    this.connectedEmail = this.read()?.confirmedForGoogleEmail ?? null;
  }

  /**
   * Refresh production's held Google identity without treating an
   * indeterminate provider response as a disconnect. A connected state with
   * no email, or a failed status read, preserves the last confirmed identity;
   * only determinate configuration loss, disconnect/expiry, or a different
   * observed email can invalidate it.
   */
  async refreshConnectedIdentity(
    readStatus: () => Promise<{ state: GoogleConnectionState; email: string | null }>,
  ): Promise<void> {
    let status: { state: GoogleConnectionState; email: string | null };
    try {
      status = await readStatus();
    } catch {
      return;
    }
    if (status.state === "connected") {
      if (status.email) this.setConnectedIdentity(status.email);
      return;
    }
    this.setConnectedIdentity(null);
  }

  /**
   * Shell-called: the connected Google account changed, so hold the new one.
   * A changed or dropped identity voids any confirmation that was pinned for
   * the previous identity.
   */
  setConnectedIdentity(email: string | null): void {
    const next = email?.trim().toLowerCase() ?? null;
    this.connectedEmail = next;
    const stored = this.read();
    if (stored && stored.confirmedForGoogleEmail !== next) {
      this.write(null);
    }
  }

  /**
   * What onboarding shows the owner: the connected identity and the one
   * Profile whose exact email already matches. A null match is the
   * create-and-confirm path, not an error.
   */
  proposal(): OwnerOnboardingProposal | null {
    if (!this.connectedEmail) return null;
    const matched = this.people
      .search({ query: this.connectedEmail })
      .find((profile) => profile.emails.includes(this.connectedEmail!));
    return {
      googleEmail: this.connectedEmail,
      matchedProfileId: matched?.id ?? null,
      matchedProfileRevision: matched?.revision ?? null,
    };
  }

  confirmed(): ConfirmedOwnerReference | null {
    const stored = this.read();
    if (!stored) return null;
    if (stored.confirmedForGoogleEmail !== this.connectedEmail) return null;
    return stored;
  }

  outwardOwnerEmail(): string | null {
    return this.confirmed() ? this.connectedEmail : null;
  }

  confirm(profileId: string): ConfirmedOwnerReference {
    if (!this.connectedEmail) {
      throw new OwnerOnboardingError(
        "no-connected-identity",
        "Connect a Google identity before confirming the owner Profile.",
      );
    }
    const profile = this.people.get(profileId);
    if (!profile) {
      throw new OwnerOnboardingError(
        "unknown-profile",
        `No Person Profile exists with id ${profileId}.`,
      );
    }
    const reference: ConfirmedOwnerReference = {
      profileId: profile.id,
      profileRevision: profile.revision,
      confirmedAt: this.now().toISOString(),
      confirmedForGoogleEmail: this.connectedEmail,
    };
    this.write(reference);
    return reference;
  }

  private read(): ConfirmedOwnerReference | null {
    if (!existsSync(this.stateFile)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as ConfirmedOwnerReference;
      if (
        typeof parsed.profileId === "string" &&
        typeof parsed.profileRevision === "number" &&
        typeof parsed.confirmedAt === "string" &&
        typeof parsed.confirmedForGoogleEmail === "string"
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private write(reference: ConfirmedOwnerReference | null): void {
    if (!reference) {
      if (existsSync(this.stateFile)) rmSync(this.stateFile);
      return;
    }
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, `${JSON.stringify(reference, null, 2)}\n`);
  }
}

export class OwnerOnboardingError extends Error {
  constructor(
    public readonly code: "no-connected-identity" | "unknown-profile",
    message: string,
  ) {
    super(message);
  }
}
