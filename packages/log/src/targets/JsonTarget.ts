import { ICommonTargetOptions, ILogEntry, LogTarget, safeStringify } from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";

/**
 * Emits NDJSON ( newline-delimited JSON ) to stdout for machine ingestion:
 * one structured JSON object per log entry instead of a formatted string, so
 * log collectors ( Loki, Elastic, Datadog, container stdout ) can index fields
 * directly rather than regex-parsing a layout.
 *
 * The inherited `layout` option is intentionally IGNORED - JSON is not a string
 * layout. `time` is stamped at write; because this target is synchronous /
 * unbuffered that is ~event time. An event-time-stamped, file-backed variant
 * will come with the batching base in a later phase.
 */

/**
 * Options for {@link JsonTarget}.
 */
export interface IJsonTargetOptions extends ICommonTargetOptions {
  /**
   * Which stream to write to. A single stream is the 12-factor norm for machine
   * logs. Default is "stdout".
   */
  stream?: "stdout" | "stderr";
}

@Singleton()
@Injectable("JsonTarget")
export class JsonTarget extends LogTarget<IJsonTargetOptions> {
  constructor(options: IJsonTargetOptions) {
    super(options);

    this.Options = Object.assign({ stream: "stdout" }, this.Options);
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    // data.Variables already carries level ( uppercase string ), logger,
    // message, a structured error ( from the serializer registry ), and any
    // merged fields. safeStringify / JSON.stringify naturally omit undefined
    // ( eg. error when absent ).
    const record = { time: new Date().toISOString(), ...data.Variables };
    const line = safeStringify(record) + "\n";

    if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {
      const out = this.Options.stream === "stderr" && process.stderr ? process.stderr : process.stdout;
      out.write(line);
    } else {
      // browser fallback
      console.log(line.replace(/\n$/, ""));
    }
  }
}
