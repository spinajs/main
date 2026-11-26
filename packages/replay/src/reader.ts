import type { ReplayChange } from './change.js';

export interface ChangePage {
  /** Only changes with a `seq` above this one: the last `seq` of the previous page. */
  readonly after?: number;
  /** The most changes the caller takes in one page; a reader may return fewer. */
  readonly limit: number;
}

/**
 * The reads a replay makes on a history stream. Every read must be answered by the primary: a replica that lags
 * shows a stream without its latest writes as complete.
 */
export interface ChangeReader {
  /**
   * Changes of `entity` whose `at` is after the instant, in ascending `seq` above `page.after`, read by one statement.
   * An empty page means none is left.
   */
  afterInstant(entity: string, at: Date, page: ChangePage): Promise<readonly ReplayChange[]>;
  /** For each key of `entity`, its last change at or before `at`; without `at`, its last change. Keys without one are absent. */
  latest(entity: string, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ReplayChange>>;
  /** From when every write of `entity` up to now is in the stream; undefined when never covered. */
  coveredSince(entity: string): Promise<Date | undefined>;
}
