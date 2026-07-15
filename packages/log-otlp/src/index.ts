/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { Log, ILogEntry, LogTarget, ICommonTargetOptions, Logger, BatchQueue, LogLevelToSeverityNumber, safeStringify } from "@spinajs/log";

import axios, { AxiosError, AxiosInstance } from "axios";
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder, TimeSpan } from "@spinajs/util";

/**
 * HTTP status codes worth retrying against an OTLP endpoint: rate limiting and
 * transient upstream / gateway failures.
 */
const RETRYABLE_STATUS = new Set<number>([429, 502, 503, 504]);

/**
 * Decide whether a failed OTLP export is worth retrying.
 *
 * Retryable: any error without an HTTP response ( network / timeout / DNS, eg.
 * ECONNREFUSED / ETIMEDOUT / ECONNRESET / EAI_AGAIN ), or an HTTP response with
 * status 429 / 502 / 503 / 504. Everything else ( 4xx client errors like 400 /
 * 401 / 403 / 404, and any other status ) is treated as a permanent error that
 * must surface rather than loop forever.
 */
export function isRetryableOtlpError(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status;

  // No HTTP response -> network / timeout / DNS failure ( axios reports these
  // without a `.response`, carrying codes like ECONNREFUSED / ETIMEDOUT /
  // ECONNRESET / EAI_AGAIN ) -> retryable.
  if (status === undefined) {
    return true;
  }

  return RETRYABLE_STATUS.has(status);
}

/**
 * Read a `Retry-After` header from an OTLP error response and return the delay
 * in milliseconds. Supports both the numeric ( delta-seconds ) and HTTP-date
 * forms. Returns `undefined` when there is no usable header.
 */
export function retryAfterMs(error: unknown): number | undefined {
  const err = error as AxiosError | undefined;
  const headers = err?.response?.headers as Record<string, unknown> | undefined;
  const raw = headers?.["retry-after"];

  if (raw === undefined || raw === null) {
    return undefined;
  }

  const value = Array.isArray(raw) ? raw[0] : raw;

  // numeric delta-seconds ( either a real number or a numeric string )
  const asNumber = typeof value === "number" ? value : Number(value);
  if (typeof value !== "boolean" && !Number.isNaN(asNumber) && `${value}`.trim() !== "") {
    return Math.max(0, asNumber * 1000);
  }

  // HTTP-date form
  const asDate = Date.parse(String(value));
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

export interface IOtlpTargetOptions extends ICommonTargetOptions {
  /**
   * Base URL of the OTLP/HTTP receiver, eg. `http://localhost:4318`. The target
   * POSTs the encoded logs to `${endpoint}/v1/logs`.
   */
  endpoint: string;

  /**
   * Extra HTTP headers sent with every export ( eg. auth tokens / API keys ).
   */
  headers?: Record<string, string>;

  /**
   * Resource attributes describing the emitting service ( eg.
   * `{ "service.name": "my-service" }` ). Emitted on `resourceLogs[].resource`.
   */
  resource?: Record<string, string | number | boolean>;

  /**
   * Instrumentation scope name reported on each `scopeLogs[].scope`. Default
   * `@spinajs/log`.
   */
  scopeName?: string;

  /** Periodic flush tick in ms. Default 3000. */
  interval: number;

  /** Flush automatically once this many records are buffered ( maxBatch ). Default 10. */
  bufferSize: number;

  /**
   * Hard cap on the number of records retained for retry ( maxQueue ). When a
   * flush fails and retained + newly buffered records exceed this, the oldest
   * are dropped. Default 1000.
   */
  maxBufferSize: number;

  /** Per-request HTTP timeout in ms. Default 5000. */
  timeout: number;
}

/**
 * Internal buffered record: the log entry plus the wall-clock event time
 * captured at `write()` time, as an OTLP nanosecond string.
 */
export interface IOtlpRecord {
  entry: ILogEntry;
  timeUnixNano: string;
}

/**
 * An OTLP `AnyValue`. Only one field is set at a time.
 */
interface IOtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

interface IOtlpKeyValue {
  key: string;
  value: IOtlpAnyValue;
}

/**
 * Encode a single scalar / structured value as an OTLP `AnyValue`. Never throws:
 * objects / arrays fall back to a JSON string via `safeStringify`.
 *
 * - string  -> `{ stringValue }`
 * - boolean -> `{ boolValue }`
 * - integer number -> `{ intValue: String(v) }`
 * - non-integer number -> `{ doubleValue: v }`
 * - anything else ( object / array / bigint / etc. ) -> `{ stringValue: safeStringify(v) }`
 */
export function anyValue(v: unknown): IOtlpAnyValue {
  if (typeof v === "string") {
    return { stringValue: v };
  }

  if (typeof v === "boolean") {
    return { boolValue: v };
  }

  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }

  return { stringValue: safeStringify(v) };
}

/**
 * Encode a plain record as an array of OTLP `KeyValue`s. Missing / empty input
 * yields an empty array.
 */
export function kv(obj?: Record<string, unknown>): IOtlpKeyValue[] {
  if (!obj) {
    return [];
  }

  return Object.keys(obj).map((key) => ({ key, value: anyValue(obj[key]) }));
}

/**
 * Variable keys that get dedicated OTLP mapping ( body / severity / trace ) and
 * must therefore be excluded from the generic attribute set.
 */
const RESERVED_VARIABLE_KEYS = new Set<string>(["message", "level", "traceId", "spanId"]);

/**
 * Map one buffered record to an OTLP `LogRecord`.
 */
export function toLogRecord(record: IOtlpRecord): Record<string, unknown> {
  const { entry, timeUnixNano } = record;
  const vars = entry.Variables ?? {};

  const attributes: IOtlpKeyValue[] = [];

  for (const key of Object.keys(vars)) {
    if (RESERVED_VARIABLE_KEYS.has(key)) {
      continue;
    }

    const value = vars[key];

    // The serializer registry turns a logged `Error` into a plain
    // `{ name, message, stack, ... }` record. Emit the OTel exception.* semantic
    // convention attributes instead of a raw serialized object.
    if (key === "error" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const err = value as Record<string, unknown>;
      if (err.name !== undefined) {
        attributes.push({ key: "exception.type", value: anyValue(err.name) });
      }
      if (err.message !== undefined) {
        attributes.push({ key: "exception.message", value: anyValue(err.message) });
      }
      if (err.stack !== undefined) {
        attributes.push({ key: "exception.stacktrace", value: anyValue(err.stack) });
      }
      continue;
    }

    attributes.push({ key, value: anyValue(value) });
  }

  const logRecord: Record<string, unknown> = {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: LogLevelToSeverityNumber[entry.Level],
    severityText: vars.level,
    body: { stringValue: String(vars.message ?? "") },
    attributes,
  };

  // traceId / spanId ( hex strings from the http traceparent feature ) become
  // top-level fields on the record, NOT attributes.
  if (vars.traceId !== undefined && vars.traceId !== null) {
    logRecord.traceId = String(vars.traceId);
  }
  if (vars.spanId !== undefined && vars.spanId !== null) {
    logRecord.spanId = String(vars.spanId);
  }

  return logRecord;
}

/**
 * Build the full OTLP Logs JSON payload for a batch of records.
 */
export function toOtlp(batch: IOtlpRecord[], resource?: Record<string, string | number | boolean>, scopeName = "@spinajs/log"): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: kv(resource) },
        scopeLogs: [
          {
            scope: { name: scopeName },
            logRecords: batch.map(toLogRecord),
          },
        ],
      },
    ],
  };
}

// we mark per instance check because we can have multiple otlp targets for
// different endpoints/logs but we dont want to create the writer twice for the
// same one.
@PerInstanceCheck()
@Injectable("OtlpLogTarget")
export class OtlpLogTarget extends LogTarget<IOtlpTargetOptions> implements IInstanceCheck {
  @Logger("LogOtlpTarget")
  protected Log: Log;

  /**
   * The single buffered-batch queue that owns accumulation, the flush timer and
   * the maxQueue cap. The actual OTLP export happens in `send`, wired as its
   * `onFlush`.
   */
  protected Queue: BatchQueue<IOtlpRecord>;

  /**
   * Set true when the queue overflows maxBufferSize, so the drop warning is
   * emitted ONCE per overflow episode and reset when a flush succeeds.
   */
  protected Overflowed = false;

  protected AxiosInstance: AxiosInstance;

  /**
   * Reusable resilience pipeline guarding the OTLP export with exponential
   * backoff + jitter, honoring `Retry-After` and only retrying transient errors.
   */
  protected RetryPipeline: ResiliencePipeline<void>;

  constructor(options: IOtlpTargetOptions) {
    super(options);

    // Config-driven targets ( resolved through the logger config ) nest their
    // settings under an `options` sub-object ( like FileTarget ), while direct
    // construction passes them flat. Hoist any nested options onto this.Options
    // at highest precedence so both forms resolve the same flat reads below.
    const nested = ((options as any)?.options ?? {}) as Partial<IOtlpTargetOptions>;
    this.Options = Object.assign(
      {
        interval: 3000,
        bufferSize: 10,
        maxBufferSize: 1000,
        timeout: 5000,
        scopeName: "@spinajs/log",
      },
      this.Options,
      nested
    );
  }

  __checkInstance__(creationOptions: IOtlpTargetOptions[]): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  public resolve(): void {
    this.AxiosInstance = axios.create({
      baseURL: this.Options.endpoint,
      headers: {
        "Content-Type": "application/json",
        ...this.Options.headers,
      },
      timeout: this.Options.timeout,
    });

    // one reusable pipeline: exponential backoff + jitter, 5 attempts, 1s..5s,
    // honoring Retry-After and retrying only transient errors ( network + 429 /
    // 502 / 503 / 504 ). Non-retryable errors fall straight through to .catch.
    this.RetryPipeline = new ResiliencePipelineBuilder<void>()
      .addRetry({
        MaxRetryAttempts: 5,
        Delay: TimeSpan.fromSeconds(1),
        MaxDelay: TimeSpan.fromSeconds(5),
        BackoffType: BackoffType.Exponential,
        UseJitter: true,
        ShouldHandle: (o) => o.Error !== undefined && isRetryableOtlpError(o.Error),
        DelayGenerator: ({ Outcome }) => {
          const ms = retryAfterMs(Outcome.Error);
          return ms !== undefined ? TimeSpan.fromMilliseconds(ms) : undefined;
        },
      })
      .build();

    // one BatchQueue owns accumulation, the periodic flush timer and the
    // maxQueue cap ( dropping the oldest ). The actual export happens in send().
    this.Queue = new BatchQueue<IOtlpRecord>({
      maxBatch: this.Options.bufferSize,
      maxQueue: this.Options.maxBufferSize,
      flushIntervalMs: this.Options.interval ?? 3000,
      onFlush: (batch) => this.send(batch),
      onOverflow: (dropped) => {
        // emit the drop warning ONCE per overflow episode; reset on the next
        // successful send() so a later episode warns again.
        if (!this.Overflowed) {
          this.Overflowed = true;
          this.Log.warn(`OTLP buffer exceeded ${this.Options.maxBufferSize} records, dropped ${dropped} oldest records.`);
        }
      },
    });

    super.resolve();
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    // capture the event time now ( wall-clock ms -> OTLP nanosecond string )
    const record: IOtlpRecord = {
      entry: data,
      timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
    };

    // fire-and-forget: a size-triggered flush ( when the batch fills ) runs in
    // the background.
    void this.Queue.enqueue(record);
  }

  public forceFlush(): Promise<void> {
    return this.Queue ? this.Queue.forceFlush() : Promise.resolve();
  }

  public async dispose() {
    // stop the flush timer and perform a final best-effort flush.
    await this.Queue.shutdown();
  }

  /**
   * Export a single batch to the OTLP endpoint. Wired as the queue's `onFlush`.
   *
   * MUST resolve ( never reject ) so shutdown()/forceFlush() cannot reject: on a
   * retryable-exhausted failure the batch is requeued at the front, on a
   * non-retryable error it is dropped and surfaced via HasError/Error.
   */
  protected async send(batch: IOtlpRecord[]): Promise<void> {
    const payload = toOtlp(batch, this.Options.resource, this.Options.scopeName);

    // wrap ONLY the push in the resilience pipeline: transient failures are
    // retried inline with backoff; we reach the catch only after retries are
    // exhausted or immediately on a non-retryable error.
    try {
      await this.RetryPipeline.execute(() => this.AxiosInstance.post("/v1/logs", payload).then(() => undefined));

      // successful export -> clear any previous error state
      this.HasError = false;
      this.Error = null;
      // drained successfully - allow the next overflow episode to warn again
      this.Overflowed = false;

      this.Log.trace(`Wrote buffered messages to OTLP target at ${this.Options.endpoint}, ${batch.length} records.`);
    } catch (err) {
      // reached only after retries are exhausted ( transient ) or immediately
      // for a non-retryable error.
      this.HasError = true;
      this.Error = err as Error;

      if (isRetryableOtlpError(err)) {
        // retryable but exhausted: put the batch back at the front so the next
        // flush retries it. The queue enforces the maxQueue cap ( dropping the
        // oldest + onOverflow ) so the retry buffer never grows without bound.
        this.Log.error(err, `Cannot export log records to OTLP target - retries exhausted, retaining records for next flush.`);
        this.Queue.requeueFront(batch);
        return;
      }

      // permanent error ( eg. 400 malformed, 401 bad auth ): retrying forever
      // would only hide a config problem. Drop the batch and surface it.
      this.Log.error(err, `Cannot export log records to OTLP target - dropping ${batch.length} records because the error is non-retryable.`);
    }
  }
}
