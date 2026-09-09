interface ReadTask {
  host: string;
  operation: string;
  operationLimit: number;
  run: () => Promise<void>;
}

/** Dispatch only runnable work, so a busy host cannot block another host's read. */
export class SourceScheduler {
  private readonly pending: ReadTask[] = [];
  private readonly hosts = new Map<string, { active: number; limit: number }>();
  private readonly operations = new Map<string, number>();
  private active = 0;

  constructor(private readonly capacity = 8) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid source capacity");
  }

  run<T>(
    url: string,
    operation: string,
    operationLimit: number,
    work: () => Promise<T>,
    successful: (value: T) => boolean = () => true,
  ): Promise<T> {
    if (!Number.isInteger(operationLimit) || operationLimit < 1)
      throw new Error("Invalid operation read capacity");
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = url;
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        host,
        operation,
        operationLimit,
        run: async () => {
          const started = Date.now();
          let succeeded = false;
          try {
            const value = await work();
            succeeded = successful(value);
            resolve(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            const state = this.hosts.get(host)!;
            state.active -= 1;
            // Slow reads reduce host occupancy. A thrown/fast failure never raises it.
            if (!succeeded || Date.now() - started > 5000) state.limit = 1;
            else if (Date.now() - started < 2000) state.limit = 2;
            this.active -= 1;
            const remaining = (this.operations.get(operation) ?? 1) - 1;
            if (remaining) this.operations.set(operation, remaining);
            else this.operations.delete(operation);
            this.dispatch();
          }
        },
      });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.capacity) {
      const index = this.pending.findIndex((task) => {
        const state = this.hosts.get(task.host);
        return (
          (!state || state.active < state.limit) &&
          (this.operations.get(task.operation) ?? 0) < task.operationLimit
        );
      });
      if (index < 0) return;
      const task = this.pending.splice(index, 1)[0]!;
      const state = this.hosts.get(task.host) ?? { active: 0, limit: 2 };
      state.active += 1;
      this.hosts.set(task.host, state);
      this.operations.set(task.operation, (this.operations.get(task.operation) ?? 0) + 1);
      this.active += 1;
      void task.run();
    }
  }
}
