/* eslint-disable security/detect-object-injection */
import { format } from "@spinajs/configuration-common";
import { IInstanceCheck, Injectable, PerInstanceCheck } from "@spinajs/di";
import { ILog, ILogEntry, LogTarget, ICommonTargetOptions } from "@spinajs/log-common";
import { Logger } from "@spinajs/log";

import * as http from "http";
import * as https from "https";
import _ from "lodash";

export interface IGraphanaOptions extends ICommonTargetOptions {
  options: {
    batchInterval: number;
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

// we mark per instance check becouse we can have multiple file targes
// for different files/paths/logs but we dont want to create every time writer for same.
@PerInstanceCheck()
@Injectable("GraphanaLogTarget")
export class GraphanaLokiLogTarget extends LogTarget<IGraphanaOptions> implements IInstanceCheck {
  @Logger("LogLokiTarget")
  protected Log: ILog;

  protected LokiUrl: URL;

  protected Batch: ILogEntry[] = [];

  constructor(options: IGraphanaOptions) {
    super(options);

    this.LokiUrl = new URL(`${options.options.host}/loki/api/v1/push`);
  }

  __checkInstance__(creationOptions: IGraphanaOptions): boolean {
    return this.Options.name === creationOptions.name;
  }

  public resolve(): void {
    setInterval(() => {
      const batch: Stream[] = [];

      if (this.Batch.length === 0) {
        return;
      }

      this.Batch.forEach((entry) => {
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
        stream.values.push([entry.Variables["n_timestamp"], JSON.stringify(format(entry.Variables, this.Options.layout))]);
      });

      void this.post(JSON.stringify(batch))
        .catch((err) => {
          this.Log.error(err, `Cannot send graphana loki logs`);
        })
        // eslint-disable-next-line promise/always-return
        .then(() => {
          this.Batch = [];
        });
    }, this.Options.options.batchInterval ?? 3000);
  }

  public write(data: ILogEntry): void {
    data.Variables["n_timestamp"] = new Date().getTime() * 1000000;
    this.Batch.push(data);
  }

  protected async post(data: string) {
    // Construct a buffer from the data string to have deterministic data size
    const dataBuffer = Buffer.from(data, "utf8");
    const lib = this.LokiUrl.protocol === "https:" ? https : http;

    // Construct the headers
    const defaultHeaders = {
      "Content-Type": "application/json",
      "Content-Length": dataBuffer.length,
    };

    const options = {
      hostname: this.LokiUrl.hostname,
      port: this.LokiUrl.port !== "" ? this.LokiUrl.port : this.LokiUrl.protocol === "https:" ? 443 : 80,
      path: this.LokiUrl.pathname,
      method: "POST",
      headers: Object.assign(defaultHeaders),
      timeout: this.Options.options.timeout,
    };

    return new Promise((resolve, reject) => {
      const request = lib.request(options, (message) => {
        let resData = "";
        message.on("data", (data) => (resData += data));
        message.on("end", () => resolve(resData));
      });

      request.on("error", (error) => reject(error));

      request.write(dataBuffer);
      request.end();
    });
  }
}
