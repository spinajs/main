/** A simulated process death. Production code may catch it; the harness treats the replica as dead anyway. */
export class SimCrash extends Error {
  /** The workflow engine's crash contract: an error with `crash: true` means the replica is dead, not that a step failed. */
  public readonly crash = true;

  constructor(
    public readonly point: string,
    public readonly replica: string,
  ) {
    super(`simulated crash of ${replica} at ${point}`);
    this.name = 'SimCrash';
  }
}
