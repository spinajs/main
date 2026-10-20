import "mocha";
import { expect } from "chai";
import { DI, IContainer } from "@spinajs/di";
import { Configuration, ConfigurationSource, FrameworkConfiguration, IConfigLike, InvalidConfiguration } from "@spinajs/configuration";
import CONFIGURATION_SCHEMA from "../src/schemas/log.configuration.js";

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}

const rules = [{ name: "*", level: "trace", target: "t" }];

describe("logger configuration schema", () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function violationsOf(targets: unknown[]): Promise<string[]> {
    const child = DI.child();
    children.push(child);
    child.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");
    child.register(NoSource).as(ConfigurationSource);
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            return { logger: { targets, rules } };
          }
        },
      )
      .as(Configuration);
    try {
      await child.resolve(Configuration);
      return [];
    } catch (e) {
      if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
      throw e;
    }
  }

  it("takes options without a path on a target that is not a file target", async () => {
    expect(await violationsOf([{ name: "t", type: "LokiTarget", options: { host: "http://localhost:3100", interval: 5 } }])).to.deep.equal([]);
  });

  it("still checks the option values it describes", async () => {
    expect(await violationsOf([{ name: "t", type: "FileTarget", options: { path: "a.log", maxSize: 0 } }])).to.deep.equal(["logger.targets.0.options.maxSize"]);
  });
});
