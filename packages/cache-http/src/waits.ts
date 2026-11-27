import { SyncService } from '@spinajs/di';

/** How a wait ended: the run settled, the bound passed, or the container disposed the waits. */
export type WaitEnd = 'ran' | 'late' | 'disposed';

/**
 * The waits of every response cache of a container for another request's run of the same key. A Service, so the
 * container's dispose ends them all at once, timers included; one instance per container, no listener.
 */
export class ResponseCacheWaits extends SyncService {
  private readonly pending = new Set<(end: WaitEnd) => void>();

  public until(running: Promise<void>, bound: number): Promise<WaitEnd> {
    return new Promise<WaitEnd>((resolve) => {
      const end = (how: WaitEnd): void => {
        clearTimeout(timer);
        this.pending.delete(end);
        resolve(how);
      };
      const timer = setTimeout(() => end('late'), bound);
      this.pending.add(end);
      void running.then(() => end('ran'));
    });
  }

  public override async dispose(): Promise<void> {
    for (const end of [...this.pending]) end('disposed');
    await super.dispose();
  }
}
