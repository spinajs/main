import { fs } from "@spinajs/fs";
import { Log, IFileTargetOptions } from "@spinajs/log-common";

/**
 * Shared context handed to every archive / retention strategy.
 *
 * It exposes the filesystems and paths a strategy needs, plus the two
 * cross-cutting hooks it must go through:
 *
 *  - `rotate()`   - perform a single rotation ( owned by LogArchiveService ),
 *  - `withWriteLock()` - run a critical section under the target write-lock so
 *    a rename never races an in-flight append.
 */
export interface ILogArchiveContext {
  /**
   * Filesystem holding the ACTIVE log file.
   */
  fs: fs;

  /**
   * Filesystem archives ( rotated / zipped files ) are moved to. Defaults to
   * the same provider as `fs`.
   */
  archiveFs: fs;

  /**
   * Path ( relative to `fs` base path ) of the active log file.
   */
  activePath: string;

  /**
   * Directory ( relative to `archiveFs` base path ) archives are stored in.
   */
  archiveDir: string;

  /**
   * Resolved file target options ( maxSize, maxAge, compress, ... ).
   */
  options: IFileTargetOptions["options"];

  /**
   * Target logger, used for diagnostics.
   */
  logger: Log;

  /**
   * Perform a single rotation of the active log file. Implemented by
   * LogArchiveService - strategies call this from their schedule.
   */
  rotate(): Promise<void>;

  /**
   * Run `fn` under the target write-lock so it cannot overlap with an
   * in-flight append / flush.
   */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>;
}
