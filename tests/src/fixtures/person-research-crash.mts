import { PersonResearchQueue } from "../../../apps/server/src/person-profile/research-queue.js";
import { PersonResearch } from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
const root = process.argv[2];
const people = new WorkspacePersonProfiles({ store: new PersonProfileStore(root), lifecycle: [] });
const person = people.create({ primaryEmail: "crash@example.com" });
const research = new PersonResearch({
  dossiers: new PersonDossierStore(root),
  search: async () => [{ url: "https://example.com/crash", title: "Crash", snippet: "" }],
  fetch: async (url) => ({
    url,
    status: 200,
    contentType: "text/plain",
    etag: null,
    lastModified: null,
    retryAfter: null,
    body: "crash@example.com built Atlas.",
  }),
  complete: async () => {
    process.send?.({ profileId: person.id });
    // Keep the process alive at the model boundary until the parent kills it.
    await new Promise(() => setInterval(() => {}, 1000));
    return {};
  },
});
const queue = new PersonResearchQueue({
  workspaceDir: root,
  people,
  research,
  enabled: () => true,
});
queue.configure({ profileCalls: 4 });
queue.enqueue(person.id, "created");
await queue.tick();
