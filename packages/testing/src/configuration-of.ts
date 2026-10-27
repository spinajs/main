import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';

/**
 * A FrameworkConfiguration whose only source is `values`: no config files are read, every registered
 * schema validates `values`, and `env` stands in for APP_ENV.
 */
export function configurationOf(values: Record<string, unknown>, env = 'test'): Class<Configuration> {
  const json = JSON.stringify(values);
  return class TestAppConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}
