/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { IntlOrm_2022_06_28_01_13_00 } from './migrations/IntlOrm_2022_06_28_01_13_00';
import { IntlResource } from './models/IntlResource';
import { IntlTranslation } from './models/IntlTranslation';

@Injectable(Bootstrapper)
export class OrmIntlBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(IntlResource).asValue('__models__');
    DI.register(IntlTranslation).asValue('__models__');
    DI.register(IntlOrm_2022_06_28_01_13_00).asValue('__migrations__');
    return;
  }
}
