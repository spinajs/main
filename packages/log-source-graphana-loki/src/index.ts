/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { Log, ILogEntry, LogTarget, ICommonTargetOptions, Logger } from "@spinajs/log";


import axios, { AxiosError, AxiosInstance } from "axios";
import _ from "lodash";
import { BackoffType, ResiliencePipeline, ResiliencePipelineBuilder, TimeSpan } from "@spinajs/util";

/**
 * HTTP status codes worth retrying against Loki: rate limiting and transient
 * upstream / gateway failures.
 */
const RETRYABLE_STATUS = new Set<number>([429, 502, 503, 504]);

/**
 * Decide whether a failed Loki push is worth retrying.
 *
 * Retryable: any error without an HTTP response ( network / timeout / DNS, eg.
 * ECONNREFUSED / ETIMEDOUT / ECONNRESET / EAI_AGAIN ), or an HTTP response with
 * status 429 / 502 / 503 / 504. Everything else ( 4xx client errors like 400 /
 * 401 / 403 / 404, and any other status ) is treated as a permanent error that
 * must surface rather than loop forever.
 */
export function isRetryableLokiError(error: unknown): boolean {
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
 * Read a `Retry-After` header from a Loki error response and return the delay in
 * milliseconds. Supports both the numeric ( delta-seconds ) and HTTP-date forms.
 * Returns `undefined` when there is no usable header.
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

export interface IGraphanaOptions extends ICommonTargetOptions {

  interval: number;
  bufferSize: number;
  /**
   * Hard cap on the number of entries retained for retry. When a flush fails and the
   * retained + newly buffered entries exceed this, the oldest are dropped.
   */
  maxBufferSize: number;
  timeout: number;
  host: string;
  auth: {
    username: string;
    password: string;
  };
  labels: {
    app: string;
  };
}

interface Stream {
  stream: {
    app: string;
    level: string;
    logger: string;
  };
  values: unknown[];
}

enum TargetStatus {
  WRITTING,
  PENDING,
  IDLE,
}

// we mark per instance check becouse we can have multiple file targes
// for different files/paths/logs but we dont want to create every time writer for same.
@PerInstanceCheck()
@Injectable("GraphanaLogTarget")
export class GraphanaLokiLogTarget extends LogTarget<IGraphanaOptions> implements IInstanceCheck {
  @Logger("LogLokiTarget")
  protected Log: Log;

  protected Entries: ILogEntry[] = [];
  protected WriteEntries: ILogEntry[] = [];

  /**
   * Set true when the primary Entries buffer overflows maxBufferSize, so the
   * drop warning is emitted ONCE per overflow episode and reset when a flush
   * succeeds and clears the buffers.
   */
  protected Overflowed = false;

  protected Status: TargetStatus = TargetStatus.IDLE;

  protected FlushTimer: NodeJS.Timeout;
  protected AxiosInstance: AxiosInstance;

  /**
   * Reusable resilience pipeline guarding the Loki push with exponential
   * backoff + jitter, honoring `Retry-After` and only retrying transient errors.
   */
  protected RetryPipeline: ResiliencePipeline<void>;

  constructor(options: IGraphanaOptions) {
    super(options);

    this.Options = Object.assign(
      {
        interval: 3000,
        bufferSize: 10,
        maxBufferSize: 1000,
        timeout: 1000,
      },
      this.Options
    );
  }

  __checkInstance__(creationOptions: IGraphanaOptions[]): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  public resolve(): void {
    this.AxiosInstance = axios.create({
      baseURL: this.Options.host,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${this.Options.auth.username}:${this.Options.auth.password}`).toString("base64")}`,
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
        ShouldHandle: (o) => o.Error !== undefined && isRetryableLokiError(o.Error),
        DelayGenerator: ({ Outcome }) => {
          const ms = retryAfterMs(Outcome.Error);
          return ms !== undefined ? TimeSpan.fromMilliseconds(ms) : undefined;
        },
      })
      .build();

    this.FlushTimer = setInterval(() => {
      // do not flush, if we already writting to file
      if (this.Status !== TargetStatus.IDLE) {
        return;
      }

      this.WriteEntries = [...this.WriteEntries, ...this.Entries];
      this.Entries = [];

      setImmediate(() => {
        this.flush();
      });
    }, this.Options.interval ?? 3000);
    // a pending flush must never keep the process alive; the final flush still runs on dispose()
    this.FlushTimer.unref?.();

    super.resolve();
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    data.Variables["n_timestamp"] = new Date().getTime() * 1000000;
    this.Entries.push(data);

    // never let the primary buffer grow without bound: if the network is down
    // and flushes never drain, cap at maxBufferSize by dropping the oldest.
    if (this.Entries.length > this.Options.maxBufferSize) {
      const dropped = this.Entries.length - this.Options.maxBufferSize;
      this.Entries.splice(0, dropped);

      if (!this.Overflowed) {
        this.Overflowed = true;
        this.Log.warn(`Graphana loki buffer exceeded ${this.Options.maxBufferSize} entries, dropped ${dropped} oldest entries.`);
      }
    }

    // if we already writting, skip buffer check & write to file
    // wait until write is finished
    if (this.Status !== TargetStatus.IDLE) {
      return;
    }

    if (this.Entries.length >= this.Options.bufferSize) {
      this.Status = TargetStatus.PENDING;

      this.WriteEntries = [...this.WriteEntries, ...this.Entries];
      this.Entries = [];

      // write at end of nodejs event loop all buffered messages at once
      setImmediate(() => {
        this.flush();
      });
    }
  }

  public async dispose() {
    // stop flush timer
    clearInterval(this.FlushTimer);

    this.WriteEntries = [...this.WriteEntries, ...this.Entries];
    this.Entries = [];

    // write all messages from buffer
    await this.flush();
  }

  protected flush(): Promise<unknown> {
    if (this.WriteEntries.length === 0) {
      this.Status = TargetStatus.IDLE;
      return Promise.resolve();
    }

    const streams: Map<string, Stream> = new Map<string, Stream>();
    const keyFor = (x: ILogEntry) => {
      return [this.Options.labels.app, x.Variables.logger, x.Variables.level, ...Object.values(this.Options.labels)].join("-");
    };
    const valFor = (x: ILogEntry) => [(x.Variables["n_timestamp"] as any).toString(), format(x.Variables, this.Options.layout)];

    this.Status = TargetStatus.WRITTING;

    this.WriteEntries.forEach((x) => {
      const key = keyFor(x);
      const stream = streams.get(key);

      if (!stream) {
        streams.set(key, {
          stream: {
            logger: x.Variables.logger,
            level: x.Variables.level,
            ...this.Options.labels,
          },
          values: [valFor(x)],
        });

        return;
      }

      stream.values.push(valFor(x));
    });

    // wrap ONLY the push in the resilience pipeline: transient failures are
    // retried inline with backoff ( Status stays WRITTING so the interval timer
    // skips overlapping flushes ); we reach .then / .catch only after retries
    // are exhausted or on a non-retryable error.
    return this.RetryPipeline.execute(() => this.AxiosInstance.post("/loki/api/v1/push", { streams: [...streams.values()] }).then(() => undefined))
      .then(() => {
        this.Status = TargetStatus.IDLE;
        this.Log.trace(`Wrote buffered messages to graphana target at url ${this.Options.host}, ${this.WriteEntries.length} messages.`);

        // successful write -> clear any previous error state
        this.HasError = false;
        this.Error = null;

        this.WriteEntries = [];
        // buffers drained successfully - allow the next overflow episode to warn again
        this.Overflowed = false;
      })
      .catch((err: Error) => {
        // reached only after retries are exhausted ( transient ) or immediately
        // for a non-retryable error.
        this.HasError = true;
        this.Error = err;
        this.Status = TargetStatus.IDLE;

        if (!isRetryableLokiError(err)) {
          // permanent error ( eg. 400 malformed, 401 bad auth ): retrying forever
          // would only hide a config problem. Drop the batch and surface it.
          const dropped = this.WriteEntries.length;
          this.WriteEntries = [];
          this.Log.error(err, `Cannot write log messages to graphana target - dropping ${dropped} entries because the error is non-retryable.`);
          return;
        }

        // retryable but exhausted: keep WriteEntries for the next tick, but never
        // let the retry buffer grow without bound: cap at maxBufferSize by
        // dropping the oldest entries.
        this.Log.error(err, `Cannot write log messages to graphana target - retries exhausted, retaining entries for next flush.`);

        const cap = this.Options.maxBufferSize;
        if (this.WriteEntries.length > cap) {
          const dropped = this.WriteEntries.length - cap;
          this.WriteEntries = this.WriteEntries.slice(this.WriteEntries.length - cap);
          this.Log.warn(`Graphana loki retry buffer exceeded ${cap} entries, dropped ${dropped} oldest entries.`);
        }
      });
  }
}
