import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { appEnvOf } from '@spinajs/authn-session';
// The 2.x login reads users rows; the 3.0 login task swaps how the account is made.
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';

import { TestConfiguration, req, restoreHttpErrorMap, seedUser } from '../token-common.js';

const STRONG_COOKIE_SECRET = 'sr16-pin-' + 'q7Vb2xK9'.repeat(8);

/** The shared http config with the shipped `authn.session.cookie` (its test override dropped) and a strong secret. */
class Sr16PinConfiguration extends TestConfiguration {
  protected onLoad(): unknown {
    const values = super.onLoad() as { http: { cookie: unknown }; authn: { session: Record<string, unknown> } };
    delete values.authn.session.cookie;
    values.http.cookie = { secret: STRONG_COOKIE_SECRET };
    return values;
  }
}

// Same as releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared.
async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

const ENV_KEYS = ['NODE_ENV', 'APP_ENV'] as const;

describe('session cookie without any app env (SR-16)', function () {
  this.timeout(25000);

  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const registered = DI.get<NodeJS.ProcessEnv>('process.env');
    if (registered?.APP_ENV) throw new Error(`a DI-registered process.env names APP_ENV=${registered.APP_ENV}; this suite needs none`);

    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(Sr16PinConfiguration);
    DI.register(Sr16PinConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);
    await (await DI.resolve(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(Sr16PinConfiguration);
    DI.uncache(Sr16PinConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('SR-16 login without any app env issues __Host-ssid, Secure, Path=/, no Domain', async () => {
    const config = DI.get(Configuration)!;
    expect(config.get('process.env.APP_ENV'), 'the configuration must have fallen back on its own').to.eq('development');
    expect(appEnvOf(config), 'a fallback env is no env').to.eq(undefined);

    await seedUser('sr16-pin@spinajs.com', 'sr16-pin', 'password123');

    const res = await req().post('auth/login').send({ Email: 'sr16-pin@spinajs.com', Password: 'password123' });
    expect(res.status, JSON.stringify(res.body)).to.eq(200);

    const setCookie = ([] as string[]).concat(res.header['set-cookie'] ?? []);
    const session = setCookie.filter((c) => /^(__Host-)?ssid=/.test(c));
    expect(session, setCookie.join(' | ')).to.have.length(1);

    const [pair, ...attrs] = session[0].split(';').map((p) => p.trim());
    const names = attrs.map((a) => a.split('=')[0].toLowerCase());
    expect(pair.startsWith('__Host-ssid='), session[0]).to.eq(true);
    expect(names, session[0]).to.include('secure');
    expect(names, session[0]).to.include('httponly');
    expect(attrs, session[0]).to.include('Path=/');
    expect(names, session[0]).to.not.include('domain');
  });
});
