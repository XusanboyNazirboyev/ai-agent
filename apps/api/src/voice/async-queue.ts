/** Unbounded single-consumer async queue. */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((item: T) => void) | undefined;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }
}
