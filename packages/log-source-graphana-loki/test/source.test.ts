/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import "mocha";
import { DI } from "@spinajs/di";
import * as sinon from "sinon";
import { expect } from "chai";
import { Log } from "@spinajs/log";
import * as _ from "lodash";

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return target.concat(source);
  }
}

import "./../src/index";
import { Configuration, FrameworkConfiguration } from "@spinajs/configuration";

function logger(name?: string) {
  return DI.resolve(Log, [name ?? "TestLogger"]);
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: "Graphana",
              type: "GraphanaLogTarget",
              options: {
                batchInterval: 10,
                timeout: 1000,
                host: "",
                labels: {
                  app: "spinajs-test",
                },
              },
            },
          ],

          rules: [{ name: "*", level: "trace", target: "Graphana" }],
        },
      },
      mergeArrays
    );
  }
}

async function wait(amount: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, amount || 1000);
  });
}

describe("logger tests", function () {
  this.timeout(15000);

  before(async () => {
    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    sinon.restore();
  });

  after(() => {
    process.exit();
  });

  it("Should send with custom labels", () => {});

  it("Should send single log entry", () => {});

  it("Should send multiple log entries", () => {});

  it("Should add same item in same stream", () => {});

  it("Should add different items in different stream", () => {});

  it("Should not clear buffer after send failed", () => {});
});
