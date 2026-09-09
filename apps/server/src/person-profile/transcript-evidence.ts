import type { PersonEvidence, PersonProfile, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { isTranscriptOriginEvidence } from "@chief-of-staff-demo/shared";
import type { TranscriptConsumerRegistry } from "../transcript-catalog/deletion.js";
import type { PersonProfileStore } from "./store.js";

/**
 * The resolver mirrors canonical evidence into `mentions` and
 * `publications`; identity repair treats all three arrays as evidence
 * locations, so every count and purge below walks all of them.
 */
function transcriptOriginCount(profile: PersonProfile, transcriptId: string): number {
  return (
    profile.evidence.filter((e) => isTranscriptOriginEvidence(e, transcriptId)).length +
    profile.mentions.filter((e) => isTranscriptOriginEvidence(e, transcriptId)).length +
    profile.publications.filter((e) => isTranscriptOriginEvidence(e, transcriptId)).length
  );
}

function withoutTranscriptOrigin(
  profile: PersonProfile,
  transcriptId: string,
): { profile: PersonProfile; removed: number } | null {
  const stripped = (records: PersonEvidence[]): [PersonEvidence[], number] => [
    records.filter((evidence) => !isTranscriptOriginEvidence(evidence, transcriptId)),
    records.filter((evidence) => isTranscriptOriginEvidence(evidence, transcriptId)).length,
  ];
  const [evidence, evidenceRemoved] = stripped(profile.evidence);
  const [mentions, mentionsRemoved] = stripped(profile.mentions);
  const [publications, publicationsRemoved] = stripped(profile.publications);
  const removed = evidenceRemoved + mentionsRemoved + publicationsRemoved;
  if (removed === 0) return null;
  return { profile: { ...profile, evidence, mentions, publications }, removed };
}

/**
 * The Person Profiles consumer registration for transcript deletion (issue
 * #128, mirroring the #122 lifecycle registry). It purges transcript-origin
 * Person Evidence from the current records and from the persisted revision
 * copies, so no transcript text survives on any Profile after deletion.
 * Profile identity — names, emails, handles — is owner-entered or sourced
 * elsewhere and survives, exactly as the spec's independently supported
 * facts do.
 */
export class WorkspacePersonProfileTranscriptEvidence implements TranscriptConsumerRegistry {
  readonly consumer = "person-profiles";
  readonly label = "Transcript-origin Person Evidence held on Person Profiles";

  constructor(private readonly store: PersonProfileStore) {}

  inspect(record: TranscriptRecord): number {
    return this.store
      .list()
      .reduce((total, profile) => total + transcriptOriginCount(profile, record.id), 0);
  }

  purge(transcriptId: string): number {
    let removed = 0;
    for (const profile of this.store.list()) {
      const current = withoutTranscriptOrigin(profile, transcriptId);
      if (current) {
        this.store.saveCurrent(current.profile);
        removed += current.removed;
      }
      /* Sensitive copies in revisions go too: a revision that still holds
         the evidence would keep the deleted transcript's text alive. The
         count stays with the current records; the revision scrub is hygiene. */
      for (const revision of this.store.listRevisions(profile.id)) {
        const scrubbed = withoutTranscriptOrigin(revision, transcriptId);
        if (scrubbed) this.store.replaceRevision(scrubbed.profile);
      }
    }
    return removed;
  }
}
