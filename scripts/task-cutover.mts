import { TaskCutover } from "../apps/server/src/tasks/cutover.js";

/** Operator boundary: preview is read-only; execution names the exact reviewed snapshot.
 * This command never contacts providers or starts Workspace schedulers.
 */
const [workspaceDir, operation, fingerprint, typedConfirmation] = process.argv.slice(2);
if (!workspaceDir || ![undefined, "preview", "execute"].includes(operation)) {
  throw new Error(
    'Usage: task-cutover.mts <workspace> [preview | execute <fingerprint> "MIGRATE TASKS"]',
  );
}
const cutover = new TaskCutover({ workspaceDir });
const preview = await cutover.preview();
if (operation === "execute") {
  if (!fingerprint || typedConfirmation !== "MIGRATE TASKS")
    throw new Error("Exact reviewed fingerprint and MIGRATE TASKS required");
  const receipt = await cutover.execute({
    workspace: preview.workspace,
    fingerprint,
    typedConfirmation,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
