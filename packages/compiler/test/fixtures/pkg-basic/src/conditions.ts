import { DI, Injectable, Bootstrapper } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';

export class FeatureA {}
export class FeatureB {}
export class FeatureC {}
export class FeatureD {}

@Injectable(Bootstrapper)
export class ConditionalBootstrapper extends Bootstrapper {
  @Config('basic.featureB') protected featureB: boolean;
  public bootstrap(): void {
    DI.register(FeatureA).asSelf();
    if (this.featureB) DI.register(FeatureB).asSelf();
    const cfg = DI.get(Configuration)!;
    if (cfg.get('basic.featureC')) DI.register(FeatureC).asSelf();
    for (let i = 0; i < 1; i++) DI.register(FeatureD).asSelf();
  }
}
