/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { Log, ILogEntry, LogTarget, ICommonTargetOptions, Logger } from "@spinajs/log";


import axios, { AxiosInstance } from "axios";
import _ from "lodash";

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

    return this.AxiosInstance.post("/loki/api/v1/push", { streams: [...streams.values()] })
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
        // mark target as errored
        this.HasError = true;
        this.Error = err;

        // log error message to others if applicable eg. console
        this.Log.error(err, `Cannot write log messages to  graphana target`);
        this.Status = TargetStatus.IDLE;

        // keep WriteEntries for retry, but never let the retry buffer grow without
        // bound: cap at maxBufferSize by dropping the oldest entries.
        const cap = this.Options.maxBufferSize;
        if (this.WriteEntries.length > cap) {
          const dropped = this.WriteEntries.length - cap;
          this.WriteEntries = this.WriteEntries.slice(this.WriteEntries.length - cap);
          this.Log.warn(`Graphana loki retry buffer exceeded ${cap} entries, dropped ${dropped} oldest entries.`);
        }
      });
  }
}
