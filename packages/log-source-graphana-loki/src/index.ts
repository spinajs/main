/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { Log, ILogEntry, LogTarget, ICommonTargetOptions, Logger } from "@spinajs/log";


import axios, { Axios } from "axios";
import _ from "lodash";

export interface IGraphanaOptions extends ICommonTargetOptions {
  options: {
    interval: number;
    bufferSize: number;
    timeout: number;
    host: string;
    auth: {
      username: string;
      password: string;
    };
    labels: {
      app: string;
    };
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

  protected Status: TargetStatus = TargetStatus.IDLE;

  protected FlushTimer: NodeJS.Timer;
  protected AxiosInstance: Axios;

  constructor(options: IGraphanaOptions) {
    super(options);

    this.Options.options = Object.assign(
      {
        interval: 3000,
        bufferSize: 10,
        timeout: 1000,
      },
      this.Options.options
    );
  }

  __checkInstance__(creationOptions: IGraphanaOptions[]): boolean {
    return this.Options.name === creationOptions[0].name;
  }

  public resolve(): void {
    this.AxiosInstance = axios.create({
      baseURL: this.Options.options.host,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${this.Options.options.auth.username}:${this.Options.options.auth.password}`).toString("base64")}`,
      },
      timeout: this.Options.options.timeout,
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
    }, this.Options.options.interval ?? 3000);
  }

  public write(data: ILogEntry): void {
    if (!this.Options.enabled) {
      return;
    }

    data.Variables["n_timestamp"] = new Date().getTime() * 1000000;
    this.Entries.push(data);

    // if we already writting, skip buffer check & write to file
    // wait until write is finished
    if (this.Status !== TargetStatus.IDLE) {
      return;
    }

    if (this.Entries.length >= this.Options.options.bufferSize) {
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
    this.flush();
  }

  protected flush() {
    if (this.WriteEntries.length === 0) {
      this.Status = TargetStatus.IDLE;
      return;
    }

    const streams: Map<string, Stream> = new Map<string, Stream>();
    const keyFor = (x: ILogEntry) => {
      return [this.Options.options.labels.app, x.Variables.logger, x.Variables.level, ...Object.values(this.Options.options.labels)].join("-");
    };
    const valFor = (x: ILogEntry) => [x.Variables["n_timestamp"].toString(), format(x.Variables, this.Options.layout)];

    this.Status = TargetStatus.WRITTING;

    this.WriteEntries.forEach((x) => {
      const key = keyFor(x);
      const stream = streams.get(key);

      if (!stream) {
        streams.set(key, {
          stream: {
            logger: x.Variables.logger,
            level: x.Variables.level,
            app: this.Options.options.labels.app,
            ...this.Options.options.labels,
          },
          values: [valFor(x)],
        });

        return;
      }

      stream.values.push(valFor(x));
    });

    this.AxiosInstance.post("/loki/api/v1/push", { streams: [...streams.values()] })
      .then(() => {
        this.Status = TargetStatus.IDLE;
        this.Log.trace(`Wrote buffered messages to graphana target at url ${this.Options.options.host}, ${this.WriteEntries.length} messages.`);
        this.WriteEntries = [];
      })
      .catch((err) => {
        // log error message to others if applicable eg. console
        this.Log.error(err, `Cannot write log messages to  graphana target`);
        this.Status = TargetStatus.IDLE;
      });
  }
}
