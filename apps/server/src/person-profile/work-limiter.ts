/** FIFO capacity shared by operations in one production composition. */
export class WorkLimiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid work capacity");
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.capacity)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
