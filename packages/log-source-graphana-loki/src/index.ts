/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { Log, ILogEntry, LogTarget, ICommonTargetOptions, Logger, BatchQueue } from "@spinajs/log";


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

// we mark per instance check becouse we can have multiple file targes
// for different files/paths/logs but we dont want to create every time writer for same.
@PerInstanceCheck()
@Injectable("GraphanaLogTarget")
export class GraphanaLokiLogTarget extends LogTarget<IGraphanaOptions> implements IInstanceCheck {
  @Logger("LogLokiTarget")
  protected Log: Log;

  /**
   * The single buffered-batch queue that owns accumulation, the flush timer and
   * the maxQueue cap. The actual Loki push happens in `send`, wired as its
   * `onFlush`.
   */
  protected Queue: BatchQueue<ILogEntry>;

  /**
   * Set true when the queue overflows maxBufferSize, so the drop warning is
   * emitted ONCE per overflow episode and reset when a flush succeeds.
   */
  protected Overflowed = false;

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

    // one BatchQueue owns accumulation, the periodic flush timer and the
    // maxQueue cap ( dropping the oldest ). The actual push happens in send().
    this.Queue = new BatchQueue<ILogEntry>({
      maxBatch: this.Options.bufferSize,
      maxQueue: this.Options.maxBufferSize,
      flushIntervalMs: this.Options.interval ?? 3000,
      onFlush: (batch) => this.send(batch),
      onOverflow: (dropped) => {
        // emit the drop warning ONCE per overflow episode; reset on the next
        // successful send() so a later episode warns again.
        if (!this.Overflowed) {
          this.Overflowed = true;
          this.Log.warn(`Graphana loki buffer exceeded ${this.Options.maxBufferSize} entries, dropped ${dropped} oldest entries.`);
        }
      },
    });

    super.resolve();
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    data.Variables["n_timestamp"] = new Date().getTime() * 1000000;

    // fire-and-forget: Loki did not await the buffer write before either. A
    // size-triggered flush ( when the batch fills ) runs in the background.
    void this.Queue.enqueue(data);
  }

  public forceFlush(): Promise<void> {
    return this.Queue ? this.Queue.forceFlush() : Promise.resolve();
  }

  public async dispose() {
    // stop the flush timer and perform a final best-effort flush.
    await this.Queue.shutdown();
  }

  /**
   * Push a single batch to Loki. Wired as the queue's `onFlush`.
   *
   * MUST resolve ( never reject ) so shutdown()/forceFlush() cannot reject: on a
   * retryable-exhausted failure the batch is requeued at the front, on a
   * non-retryable error it is dropped and surfaced via HasError/Error.
   */
  protected async send(batch: ILogEntry[]): Promise<void> {
    const streams: Map<string, Stream> = new Map<string, Stream>();
    const keyFor = (x: ILogEntry) => {
      return [this.Options.labels.app, x.Variables.logger, x.Variables.level, ...Object.values(this.Options.labels)].join("-");
    };
    const valFor = (x: ILogEntry) => [(x.Variables["n_timestamp"] as any).toString(), format(x.Variables, this.Options.layout)];

    batch.forEach((x) => {
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
    // retried inline with backoff; we reach the catch only after retries are
    // exhausted or immediately on a non-retryable error.
    try {
      await this.RetryPipeline.execute(() => this.AxiosInstance.post("/loki/api/v1/push", { streams: [...streams.values()] }).then(() => undefined));

      // successful write -> clear any previous error state
      this.HasError = false;
      this.Error = null;
      // drained successfully - allow the next overflow episode to warn again
      this.Overflowed = false;

      this.Log.trace(`Wrote buffered messages to graphana target at url ${this.Options.host}, ${batch.length} messages.`);
    } catch (err) {
      // reached only after retries are exhausted ( transient ) or immediately
      // for a non-retryable error.
      this.HasError = true;
      this.Error = err as Error;

      if (isRetryableLokiError(err)) {
        // retryable but exhausted: put the batch back at the front so the next
        // flush retries it. The queue enforces the maxQueue cap ( dropping the
        // oldest + onOverflow ) so the retry buffer never grows without bound.
        this.Log.error(err, `Cannot write log messages to graphana target - retries exhausted, retaining entries for next flush.`);
        this.Queue.requeueFront(batch);
        return;
      }

      // permanent error ( eg. 400 malformed, 401 bad auth ): retrying forever
      // would only hide a config problem. Drop the batch and surface it.
      this.Log.error(err, `Cannot write log messages to graphana target - dropping ${batch.length} entries because the error is non-retryable.`);
    }
  }
}
