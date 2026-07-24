import { ILogEntry, ILogFilterOptions, LogFilter } from "@spinajs/log-common";
import { Injectable, NewInstance } from "@spinajs/di";

/**
 * Options for {@link MatchFilter}.
 */
export interface IMatchFilterOptions extends ILogFilterOptions {
  /** Regex source tested against the chosen field. Required. */
  pattern: string;
  /** Variable field to test. Default "message". */
  field?: string;
  /** "keep" ( default ) keeps on match, drops otherwise; "drop" drops on match. */
  mode?: "keep" | "drop";
  /** RegExp flags ( eg. "i" ). */
  flags?: string;
}

/**
 * Regex keep/drop filter. Builds a RegExp from `pattern`/`flags` and tests it
 * against `String(entry.Variables[field])` ( field defaults to "message" ).
 * In "keep" mode the entry is kept only on a match; in "drop" mode it is
 * dropped on a match. An invalid pattern degrades to a no-op ( pass-through )
 * and warns ONCE so a bad config never silently swallows or drops everything.
 */
@Injectable("MatchFilter")
@NewInstance()
export class MatchFilter extends LogFilter {
  protected regex: RegExp | null = null;
  protected field: string;
  protected mode: "keep" | "drop";
  protected warned = false;

  constructor(options?: IMatchFilterOptions) {
    super(options);
    this.field = options?.field ?? "message";
    this.mode = options?.mode ?? "keep";

    try {
      if (options?.pattern === undefined) {
        throw new Error("MatchFilter requires a `pattern` option");
      }
      // eslint-disable-next-line security/detect-non-literal-regexp
      this.regex = new RegExp(options.pattern, options.flags);
    } catch (err) {
      this.regex = null;
      // no-op on bad config; warn once to the raw console ( never re-enter the
      // logger pipeline ) so a broken filter is visible but harmless.
      // eslint-disable-next-line no-console
      console.warn(`MatchFilter: invalid pattern "${options?.pattern}" - filter disabled ( no-op ). ${(err as Error).message}`);
      this.warned = true;
    }
  }

  public apply(entry: ILogEntry): ILogEntry | null {
    // invalid / missing pattern => no-op pass-through
    if (!this.regex) {
      return entry;
    }

    const value = String(entry.Variables[this.field]);
    const matched = this.regex.test(value);

    if (this.mode === "drop") {
      return matched ? null : entry;
    }
    // keep mode
    return matched ? entry : null;
  }
}
