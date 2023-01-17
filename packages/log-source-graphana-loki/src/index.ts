/* eslint-disable promise/always-return */
/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import {
  ILog,
  ILogEntry,
  LogTarget,
  ICommonTargetOptions,
} from "@spinajs/log-common";
import { Logger } from "@spinajs/log";

import axios from "axios";
import _ from "lodash";

export interface IGraphanaOptions extends ICommonTargetOptions {
  options: {
    interval: number;
    bufferSize: number;
    timeout: number;
    host: string;
    labels: {
      app: string;
    };
  };
}

interface Stream {
  labels: {
    app: string;
    level: string;
    logger: string;
    [label: string]: unknown;
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
export class GraphanaLokiLogTarget
  extends LogTarget<IGraphanaOptions>
  implements IInstanceCheck
{
  @Logger("LogLokiTarget")
  protected Log: ILog;

  protected Entries: ILogEntry[] = [];

  protected Status: TargetStatus = TargetStatus.IDLE;

  protected FlushTimer: NodeJS.Timer;

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

  __checkInstance__(creationOptions: IGraphanaOptions): boolean {
    return this.Options.name === creationOptions.name;
  }

  public resolve(): void {
    this.FlushTimer = setInterval(() => {
      // do not flush, if we already writting to file
      if (this.Status !== TargetStatus.IDLE) {
        return;
      }

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

      // write at end of nodejs event loop all buffered messages at once
      setImmediate(() => {
        this.flush();
      });
    }
  }

  public async dispose() {
    // stop flush timer
    clearInterval(this.FlushTimer);

    // write all messages from buffer
    this.flush();
  }

  protected flush() {
    const batch: Stream[] = [];

    if (this.Entries.length === 0) {
      this.Status = TargetStatus.IDLE;
      return;
    }

    this.Status = TargetStatus.WRITTING;

    this.Entries.forEach((entry) => {
      let stream = batch.find((b) =>
        _.isEqual(b.labels, {
          app: this.Options.options.labels.app,
          logger: entry.Variables.logger,
          level: entry.Variables.level,
          ...this.Options.options.labels,
        })
      );

      if (!stream) {
        stream = {
          labels: {
            app: this.Options.options.labels.app,
            logger: entry.Variables.logger,
            level: entry.Variables.level,
            ...this.Options.options.labels,
          },
          values: [],
        };

        batch.push(stream);
      }
      stream.values.push([
        entry.Variables["n_timestamp"],
        JSON.stringify(format(entry.Variables, this.Options.layout)),
      ]);
    });

    axios
      .post(this.Options.options.host + "/loki/api/v1/push", {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: this.Options.options.timeout,
        data: batch,
      })
      .then(() => {
        this.Entries = [];
        this.Status = TargetStatus.IDLE;

        this.Log.trace(
          `Wrote buffered messages to graphana target at url ${this.Options.options.host}`
        );
      })
      .catch((err) => {
        // log error message to others if applicable eg. console
        this.Log.error(err, `Cannot write log messages to  graphana target`);
        this.Status = TargetStatus.IDLE;
      });
  }
}
