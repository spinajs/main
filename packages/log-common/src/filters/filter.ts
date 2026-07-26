// type-only import - erased at compile time so there is no runtime import cycle
// back to ../index.js. Filters operate on the shape of an entry, never on the
// LogLevel enum VALUES, so a type import is sufficient here.
import type { ILogEntry } from "../index.js";

/**
 * Common shape of a configured filter entry. `type` is the DI string name the
 * filter is registered under ( eg. "LevelFilter" ); all other keys are the
 * filter's own free-form options and are read by the concrete filter.
 */
export interface ILogFilterOptions {
  type: string;
  [k: string]: unknown;
}

/**
 * Base class for a composable log filter. Filters are DI-registered by string
 * name ( just like log targets ) via `@Injectable("<Name>")` and resolved per
 * logger from `logger.filters` config. They run IN ORDER inside the logger's
 * `write()`: each filter may pass the entry through ( optionally mutating it ),
 * or return `null` to DROP it entirely.
 *
 * Kept a plain, dependency-light abstract class ( no SyncService etc. ) so the
 * contract stays browser-safe and cheap to instantiate.
 */
export abstract class LogFilter {
  constructor(protected options?: ILogFilterOptions) {}

  /** Return the ( possibly modified ) entry to keep, or null to DROP it. */
  public abstract apply(entry: ILogEntry): ILogEntry | null;
}
