import '@spinajs/log';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';

export const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

export class UploadTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: SILENT_LOGGER };
  }
}

let booted: Promise<Configuration> | undefined;

/**
 * One root Configuration per mocha process. The bootstrappers run first, so a package schema registered by
 * one applies when the Configuration boots (configuration/src/schemas.ts:28-37).
 */
export function bootConfiguration(): Promise<Configuration> {
  return (booted ??= (async () => {
    DI.setESMModuleSupport();
    DI.register(UploadTestConfiguration).as(Configuration);
    for (const b of await DI.resolve<Bootstrapper>(Array.ofType(Bootstrapper))) await b.bootstrap();
    return DI.resolve(Configuration);
  })());
}
