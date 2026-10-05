import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';

import * as barrel from '../../src/index.js';
import * as api from '../../src/api.js';
import { ClientIp } from '../../src/middleware/client-ip.js';
import { AUTHN_PROBE_PATH } from './probe.js';
import { TestConfiguration, req, restoreHttpErrorMap } from '../token-common.js';

const SPOOF = '198.51.100.66';

class ClientIpConfiguration extends TestConfiguration {}

// Same as releaseHttpServer() of packages/http/test/common.ts, which imports http's sources and so cannot be shared.
async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

async function startServer(): Promise<void> {
  await DI.resolve(Controllers);
  await (await DI.resolve(HttpServer)).start();
}

/** Restarts the server so ClientIp reads the given trust settings when the middleware is built. */
async function restartWith(authnTrust: unknown, httpTrust: unknown): Promise<void> {
  await releaseHttpServer();
  const config = DI.get(Configuration)!;
  config.set('authn.http.trustProxy', authnTrust);
  config.set('http.trustProxy', httpTrust);
  await startServer();
}

async function clientIp(xff?: string): Promise<string | null> {
  const r = req().get(AUTHN_PROBE_PATH).set('Accept', 'application/json');
  const res = await (xff === undefined ? r : r.set('X-Forwarded-For', xff));
  expect(res.status, JSON.stringify(res.body)).to.eq(200);
  return res.body.clientIp;
}

function unitClientIp(values: Record<string, unknown>): ClientIp {
  const mw = new ClientIp();
  Object.defineProperty(mw, 'Configuration', { value: { get: (path: string, def?: unknown) => (path in values ? values[path] : def) } });
  return mw;
}

describe('ClientIp (A05, SR-03)', function () {
  this.timeout(30000);

  let socketAddress: string | null;

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(ClientIpConfiguration);
    DI.register(ClientIpConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await startServer();

    socketAddress = await clientIp();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(ClientIpConfiguration);
    DI.uncache(ClientIpConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
  });

  it('the barrel exports the lane ClientIp, registered as a ServerMiddleware, not the api.ts stub', () => {
    expect(barrel.ClientIp).to.eq(ClientIp).and.not.eq(api.ClientIp);
    expect(new ClientIp().Order).to.eq(1);
    expect(DI.getRegisteredTypes(ServerMiddleware)).to.include(ClientIp);
  });

  it('without trust the client is the socket address', () => {
    expect(socketAddress).to.be.oneOf(['127.0.0.1', '::1']);
  });

  it('SR-03 ClientIp ignores a spoofed X-Forwarded-For', async () => {
    await restartWith(null, null);
    expect(await clientIp(SPOOF)).to.eq(socketAddress);
    expect(await clientIp(`${SPOOF}, 10.0.0.1`)).to.eq(socketAddress);
  });

  it('authn.http.trustProxy: 1 gives the last X-Forwarded-For entry', async () => {
    await restartWith(1, null);
    expect(await clientIp(`198.51.100.1, ${SPOOF}`)).to.eq(SPOOF);
  });

  it('a CIDR list walks from the socket while the address is trusted', async () => {
    await restartWith(['127.0.0.0/8', '::1/128', '10.0.0.0/8'], null);
    expect(await clientIp(`198.51.100.1, ${SPOOF}, 10.0.0.7`)).to.eq(SPOOF);
    await restartWith(['loopback'], null);
    expect(await clientIp(`${SPOOF}, 10.0.0.7`)).to.eq('10.0.0.7');
  });

  it('authn.http.trustProxy null falls back to http.trustProxy; 0 does not', async () => {
    await restartWith(null, 1);
    expect(await clientIp(`198.51.100.1, ${SPOOF}`)).to.eq(SPOOF);
    await restartWith(0, 1);
    expect(await clientIp(`198.51.100.1, ${SPOOF}`)).to.eq(socketAddress);
  });

  it('a bad value fails when the middleware is built, naming the key', () => {
    expect(() => unitClientIp({ 'authn.http.trustProxy': 'nope' }).before()).to.throw(InvalidOption, 'authn.http.trustProxy');
    expect(() => unitClientIp({ 'authn.http.trustProxy': null, 'http.trustProxy': -1 }).before()).to.throw(InvalidOption, 'http.trustProxy');
    expect(unitClientIp({}).after()).to.eq(null);
  });
});
