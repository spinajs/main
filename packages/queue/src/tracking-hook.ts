/**
 * Wraps the queue's own reads and writes of its job rows (and the retention purge), so that an
 * authorization layer can run them under an identity that may touch the table whatever the job's principal is.
 */
export abstract class QueueTrackingHook {
  abstract aroundTracking<T>(next: () => Promise<T>): Promise<T>;
}
