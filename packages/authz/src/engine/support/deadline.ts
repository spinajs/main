import { swallow } from '../run.js';

export const THREW: unique symbol = Symbol('threw');
export const EXPIRED: unique symbol = Symbol('expired');

/** One time limit for a whole summary() or covers() call; clear() it when the call ends. */
export class Deadline {
  expired = false;
  private readonly reached: Promise<typeof EXPIRED>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly ms: number) {
    this.reached = new Promise((resolve) => {
      this.timer = setTimeout(() => {
        this.expired = true;
        resolve(EXPIRED);
      }, ms);
    });
  }

  /** EXPIRED when the limit comes first; `work` is left running. */
  race<T>(work: Promise<T>): Promise<T | typeof EXPIRED> {
    if (!this.expired) return Promise.race([work, this.reached]);
    swallow(work);
    return Promise.resolve(EXPIRED);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}
