import { DI, Bootstrapper } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

export class Multi {}

export class MultiBoot extends Bootstrapper {
  @Config('basic.a') protected a: boolean;
  public bootstrap(): void {
    if (this.a) DI.register(Multi).asSelf();
    else DI.register(Multi).as('MultiAlt');
  }
}
