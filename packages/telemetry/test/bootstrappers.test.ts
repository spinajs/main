import 'mocha';
import { expect } from 'chai';
import _ from 'lodash';
import { Configuration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import { Metrics, TELEMETRY_CONFIGURATION_SCHEMA, TelemetryBootstrapper, TelemetryServiceTokenBootstrapper } from '../src/index.js';

/** Fills its data in `resolve()` only, like the real Configuration, which boots after the bootstrappers ran. */
class LateConfiguration extends Configuration {
  public data: Record<string, unknown> = {};

  public get RootConfig(): IConfigLike {
    return this.data as unknown as IConfigLike;
  }
  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.data, path, defaultValue) as T;
  }
  public set(path: string[] | string, value: unknown): void {
    _.set(this.data, path, value);
  }
  public merge(): void {}
  public async mergeSource(): Promise<void> {}
  public async load(): Promise<void> {}
  protected onLoad(): unknown {
    return undefined;
  }

  public async resolve(): Promise<void> {
    this.data = { telemetry: { collectDefaultMetrics: true, auth: { token: 'secret' } } };
    await super.resolve();
  }
}

describe('telemetry bootstrappers with a Configuration that is not resolved yet', () => {
  beforeEach(() => {
    DI.clearCache();
    DI.register(LateConfiguration).as(Configuration);
  });

  afterEach(() => {
    DI.unregister(LateConfiguration);
    DI.clearCache();
  });

  it('TelemetryBootstrapper collects the default metrics', async () => {
    await new TelemetryBootstrapper().bootstrap();
    const text = await DI.get(Metrics)!.render();
    expect(text).to.contain('process_cpu_user_seconds_total');
  });

  it('TelemetryBootstrapper registers the telemetry configuration schema', async () => {
    await new TelemetryBootstrapper().bootstrap();
    expect(DI.RootContainer.Cache.get('__configurationSchema__', false) ?? []).to.include(TELEMETRY_CONFIGURATION_SCHEMA);
  });

  it('TelemetryServiceTokenBootstrapper bridges the token into authz.http.services', async () => {
    await new TelemetryServiceTokenBootstrapper().bootstrap();
    const cfg = DI.get(Configuration)!;
    expect(cfg.get<unknown[]>(['authz', 'http', 'services'])).to.have.length(2);
  });
});
