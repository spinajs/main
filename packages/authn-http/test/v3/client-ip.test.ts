import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { BaseController, Controllers, HttpServer, RealIp, ServerMiddleware, ThrottleMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import * as barrel from '../../src/index.js';
import { AuthnRealIp, ClientIp } from '../../src/middleware/client-ip.js';
import { mounted } from '../support/server-hooks.js';
import { AUTHN_PROBE_PATH } from './probe.js';
import { TestConfiguration, req, restoreHttpErrorMap, startHttpServer } from '../token-common.js';
import { fakeContainer } from '@spinajs/testing';

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
  await startHttpServer();
}

/** Restarts the server with new address middlewares, which read the given settings when they are resolved. */
async function restartWith(authnTrust: unknown, httpTrust: unknown, throttle: unknown = { enabled: false }): Promise<void> {
  await releaseHttpServer();
  for (const type of [ClientIp, RealIp, AuthnRealIp, ThrottleMiddleware] as Class<unknown>[]) DI.uncache(type);
  DI.uncache(ServerMiddleware);
  const config = DI.get(Configuration)!;
  config.set('authn.http.trustProxy', authnTrust);
  config.set('http.trustProxy', httpTrust);
  config.set('http.throttle', throttle);
  await startServer();
}

async function status(xff: string): Promise<number> {
  return (await req().get(AUTHN_PROBE_PATH).set('Accept', 'application/json').set('X-Forwarded-For', xff)).status;
}

async function clientIp(xff?: string): Promise<string | null> {
  const r = req().get(AUTHN_PROBE_PATH).set('Accept', 'application/json');
  const res = await (xff === undefined ? r : r.set('X-Forwarded-For', xff));
  expect(res.status, JSON.stringify(res.body)).to.eq(200);
  return res.body.clientIp;
}

const BASE = { 'authn.http.trustProxy': null, 'http.trustProxy': null };

function unitRealIp(values: Record<string, unknown>): AuthnRealIp {
  const mw = new AuthnRealIp();
  Object.defineProperty(mw, CONFIGURATION_CONTAINER_KEY, { value: fakeContainer({ ...BASE, ...values }) });
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

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await (await DI.resolve(Orm)).Migrator.ready();
    await startServer();

    socketAddress = await clientIp();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(ClientIpConfiguration);
    DI.uncache(ClientIpConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
    DI.uncache(OrmMigrator);
  });

  it('the barrel exports the lane ClientIp, registered as a ServerMiddleware, and AuthnRealIp', () => {
    expect(barrel.ClientIp).to.eq(ClientIp);
    expect(barrel.AuthnRealIp).to.eq(AuthnRealIp);
    expect(new ClientIp().Order).to.eq(1);
    expect(DI.getRegisteredTypes(ServerMiddleware)).to.include(ClientIp);
  });

  it('the running server mounts one RealIp, an AuthnRealIp, before ClientIp', () => {
    const list = (DI.get(HttpServer) as unknown as { Middlewares: ServerMiddleware[] }).Middlewares;
    const realIps = list.filter((m) => m instanceof RealIp);
    expect(realIps).to.have.length(1);
    expect(realIps[0]).to.be.instanceOf(AuthnRealIp);
    expect(list.indexOf(realIps[0])).to.be.lessThan(list.findIndex((m) => m instanceof ClientIp));
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

  it('report §3.2: with only authn.http.trustProxy, http.throttle counts each client behind the proxy', async () => {
    await restartWith(1, null, { enabled: true, rules: [{ path: `/${AUTHN_PROBE_PATH}`, methods: ['GET'], limit: 1, windowSeconds: 60 }] });
    try {
      expect([await status('203.0.113.31'), await status('203.0.113.32'), await status('203.0.113.31')]).to.deep.eq([200, 200, 429]);
    } finally {
      await restartWith(null, null);
    }
  });

  it('a link-local socket peer is the client, without the zone id Node appends, and matches linklocal', () => {
    const run = (values: Record<string, unknown>) => {
      const storage: Record<string, unknown> = {};
      const req = { headers: { 'x-forwarded-for': SPOOF }, socket: { remoteAddress: 'fe80::1%eth0' }, storage };
      mounted(unitRealIp(values))!(req, {}, () => undefined);
      mounted(new ClientIp())!(req, {}, () => undefined);
      return storage.ClientIp;
    };
    expect(run({})).to.eq('fe80::1');
    expect(run({ 'authn.http.trustProxy': 'linklocal' })).to.eq(SPOOF);
  });

  it('a bad value fails when the middleware is resolved, naming the key', async () => {
    await expect(unitRealIp({ 'authn.http.trustProxy': 'nope' }).resolve()).to.be.rejectedWith(InvalidOption, 'authn.http.trustProxy');
    await expect(unitRealIp({ 'authn.http.trustProxy': null, 'http.trustProxy': -1 }).resolve()).to.be.rejectedWith(InvalidOption, 'http.trustProxy');
  });
});
