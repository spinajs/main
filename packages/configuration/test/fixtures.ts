import { ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';

export function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

export class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
}
