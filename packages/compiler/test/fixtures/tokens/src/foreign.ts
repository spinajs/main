import { DI, Injectable } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { LOG } from '@spinajs/log-common';

@Injectable()
export class ManifestReader {
  public read(): unknown {
    DI.resolve(MANIFEST_SETTINGS);
    DI.resolve(LOG);
    return DI.resolve(MANIFEST);
  }
}
