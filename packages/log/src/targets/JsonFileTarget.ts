import { Injectable, PerInstanceCheck } from "@spinajs/di";
import { ILogEntry, LogLevelToSeverityNumber, safeStringify } from "@spinajs/log-common";

import { FileTarget } from "./FileTarget.js";

/**
 * Emits newline-delimited JSON ( NDJSON ) to a file through the FileTarget
 * pipeline ( batched append, write-lock, rotation, retention, zip ): one
 * structured JSON object per log entry so log collectors ( Loki, Elastic,
 * Datadog ) can index fields directly rather than regex-parsing a layout.
 *
 * It subclasses the concrete FileTarget and overrides ONLY the per-entry
 * serialization, reusing IFileTargetOptions unchanged. The inherited `layout`
 * option is intentionally IGNORED ( JSON, not a string layout ). `time` is
 * event-time: it is stamped in formatEntry, which runs in write() before the
 * entry is buffered, so it reflects when the event was logged, not when the
 * batch is flushed to disk.
 */
@PerInstanceCheck()
@Injectable("JsonFileTarget")
export class JsonFileTarget extends FileTarget {
  protected formatEntry(data: ILogEntry): string {
    // data.Variables already carries level ( uppercase string ), logger,
    // message, a structured error ( from the serializer registry ) and any
    // merged fields. safeStringify / JSON.stringify naturally omit undefined
    // ( eg. error when absent ).
    return safeStringify({
      time: new Date().toISOString(),
      severityNumber: LogLevelToSeverityNumber[data.Level],
      ...data.Variables,
    });
  }
}
