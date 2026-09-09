import { EventEmitter } from "node:events";
import { resolve } from "node:path";

/* In-process notifications carry only paths. Durable consumers re-read their
   projections and retain their own checkpoints; restart needs no event replay. */
const changes = new EventEmitter();
export function notifyWorkspaceChange(workspaceDir: string): void {
  changes.emit(resolve(workspaceDir));
}
export function observeWorkspaceChanges(workspaceDir: string, changed: () => void): () => void {
  const key = resolve(workspaceDir);
  changes.on(key, changed);
  return () => {
    changes.off(key, changed);
  };
}
