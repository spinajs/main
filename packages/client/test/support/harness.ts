import { tmpdir } from 'node:os';
import { BasePolicy } from '@spinajs/http';
import { FrameworkConfiguration } from '@spinajs/configuration';
import shipped from '../../../http/lib/config/http.js';

// The fixture guards two routes with @Access; authorization is not what this suite checks. Importing the fixture
// also registers authz-http's PrincipalMiddleware, which stops the server when no authz domain boots.
export class AllowAccess extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

export class E2eConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      intl: { locales: ['en'], defaultLocale: 'en' },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0, middlewares: shipped.http.middlewares, AcceptHeaders: 1 | 2 },
    };
  }
}
