import { DI, Injectable, Bootstrapper } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';

export class ElseA {}
export class TernA {}
export class TernB {}
export class AndA {}
export class NestedCfg {}
export class NegA {}

export class FeatureFlags { public enabled: boolean }

@Injectable(Bootstrapper)
export class ExtraBootstrapper extends Bootstrapper {
  @Config('basic.featureB') protected flag: boolean;
  @Config('feature') protected cfg: FeatureFlags;
  public bootstrap(): void {
    const config = DI.get(Configuration)!;
    if (config.get('basic.x')) { void 0; } else DI.register(ElseA).asSelf();
    this.flag ? DI.register(TernA).asSelf() : DI.register(TernB).asSelf();
    this.flag && DI.register(AndA).asSelf();
    if (this.cfg.enabled) DI.register(NestedCfg).asSelf();
    if (!this.flag) DI.register(NegA).asSelf();
    console.log('plain');
  }
}
