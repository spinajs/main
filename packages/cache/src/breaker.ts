/**
 * Opens after `failures` failures in a row; once `resetAfterMs` has passed it lets one call through per period until one
 * succeeds. The breaker of the util package is typed by one result per pipeline; a store has calls of five result types.
 */
export class Breaker {
  private inRow = 0;
  private closedAgainAt = 0;

  constructor(
    private readonly failures: number,
    private readonly resetAfterMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public get open(): boolean {
    return this.closedAgainAt !== 0;
  }

  public allows(): boolean {
    if (this.closedAgainAt === 0) return true;
    const now = this.now();
    if (now < this.closedAgainAt) return false;
    this.closedAgainAt = now + this.resetAfterMs;
    return true;
  }

  public succeeded(): void {
    this.inRow = 0;
    this.closedAgainAt = 0;
  }

  /** True when this failure opened the breaker. */
  public failed(): boolean {
    this.inRow += 1;
    if (this.inRow < this.failures) return false;
    const opening = this.closedAgainAt === 0;
    this.closedAgainAt = this.now() + this.resetAfterMs;
    return opening;
  }
}
