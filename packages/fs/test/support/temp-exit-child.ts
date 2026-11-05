import '@spinajs/log';
import { tmpdir } from 'node:os';
import { DI, Singleton } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { FsBootsrapper, fsService } from '../../src/index.js';

@Singleton()
class ChildConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      fs: {
        defaultProvider: 'backend',
        providers: [
          { service: 'fsNative', name: 'backend', basePath: tmpdir() },
          { service: 'fsTemp', name: 'fs-temp', provider: 'backend', cleanup: true, cleanupInterval: 60 * 60 * 1000, maxFileAge: 60 },
        ],
      },
    };
  }
}

DI.resolve(FsBootsrapper).bootstrap();
DI.register(ChildConfiguration).as(Configuration);
await DI.resolve(Configuration);
await DI.resolve(fsService);

console.log('resolved');
