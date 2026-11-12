import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, RealIp, ServerMiddleware } from '@spinajs/http';
import type { IMiddlewareContext } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthnRealIp, ClientIp } from '../../src/middleware/client-ip.js';
import { AUTHN_PROBE_PATH } from './probe.js';
import { TestConfiguration, req, restoreHttpErrorMap, startHttpServer } from '../token-common.js';

const SPOOF = '198.51.100.66';

class RealIpSubclassConfiguration extends TestConfiguration {}

// The shape of the docs/http/17 samples: an app's own RealIp, registered over RealIp, at RealIp's Order (1).
class CdnRealIp extends RealIp {
  public onBefore(ctx: IMiddlewareContext): void {
    super.onBefore(ctx);
  }
}

async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type);
  DI.uncache(BaseController);
  for (const type of [ClientIp, RealIp, AuthnRealIp, CdnRealIp] as Class<unknown>[]) DI.uncache(type);
  DI.uncache(ServerMiddleware);
}

async function startWith(authnTrust: unknown, httpTrust: unknown): Promise<void> {
  await releaseHttpServer();
  const config = DI.get(Configuration)!;
  config.set('authn.http.trustProxy', authnTrust);
  config.set('http.trustProxy', httpTrust);
  await DI.resolve(Controllers);
  await startHttpServer();
}

describe('ClientIp behind an app RealIp subclass (RL-2 I-1, I-2)', function () {
  this.timeout(30000);

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();
    DI.unregister(RealIpSubclassConfiguration);
    DI.register(RealIpSubclassConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(CdnRealIp).as(RealIp);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await (await DI.resolve(Orm)).Migrator.ready();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(CdnRealIp);
    DI.unregister(RealIpSubclassConfiguration);
    DI.uncache(RealIpSubclassConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
    DI.uncache(OrmMigrator);
  });

  it('ClientIp runs after the subclass and copies the client it resolved through http.trustProxy', async () => {
    await startWith(null, 1);
    const list = (DI.get(HttpServer) as unknown as { Middlewares: ServerMiddleware[] }).Middlewares;
    expect(list.findIndex((m) => m instanceof CdnRealIp)).to.be.lessThan(list.findIndex((m) => m instanceof ClientIp));
    const res = await req().get(AUTHN_PROBE_PATH).set('Accept', 'application/json').set('X-Forwarded-For', `198.51.100.1, ${SPOOF}`);
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect((res.body as { clientIp?: string }).clientIp).to.eq(SPOOF);
  });

  it('with authn.http.trustProxy set, the boot fails: the subclass would ignore it', async () => {
    const failure = await startWith(1, null).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).to.be.instanceOf(InvalidOption);
    expect((failure as Error).message).to.contain('authn.http.trustProxy').and.contain('CdnRealIp').and.contain('AuthnRealIp');
  });
});
