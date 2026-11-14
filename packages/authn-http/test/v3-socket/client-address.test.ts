import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { RealIp, ServerMiddleware, parseTrustProxy } from '@spinajs/http';
import type { ProxyTrust } from '@spinajs/http';
import { BaseSocketController, Command, Connection, SocketConnection, SocketController } from '@spinajs/http-socket';

import { AuthnRealIp, ClientIp } from '../../src/middleware/client-ip.js';
import { AUTHN_PROBE_PATH } from '../v3/probe.js';
import { Client, config, releaseHttpServer, startApp, startServer, stopApp, useFakes } from '../v3-app/app.js';
import { closeSockets, command, connected, resultOf, socketTo, startSockets, stopSockets } from './support.js';

const CLIENT = '203.0.113.7';
const LOOPBACK = /^(127\.0\.0\.1|::1)$/;

@SocketController('clientaddr')
export class ClientAddressProbe extends BaseSocketController {
  @Command('where')
  public async where(@Connection() conn: SocketConnection) {
    return conn.handshake.address;
  }
}

/** An app's RealIp: AuthnRealIp trusting the loopback proxy in code, whatever the settings say. */
class AppRealIp extends AuthnRealIp {
  protected override proxyTrust(): ProxyTrust {
    return parseTrustProxy('loopback', 'AppRealIp');
  }
}

/** The instances that parsed the trust once, and the middleware list HttpServer holds them in. */
function forgetRealIp(): void {
  for (const type of [RealIp, AuthnRealIp, AppRealIp, ClientIp] as Class<unknown>[]) DI.uncache(type);
  DI.uncache(ServerMiddleware);
  // Resolving the list records the class RealIp led to under ServerMiddleware; a later override would run beside it.
  DI.RootContainer.Registry.unregister(ServerMiddleware, AuthnRealIp);
}

function setTrust(authnTrust: unknown, httpTrust: unknown): void {
  config().set(['authn', 'http', 'trustProxy'], authnTrust);
  config().set(['http', 'trustProxy'], httpTrust);
}

async function restart(authnTrust: unknown, httpTrust: unknown): Promise<void> {
  closeSockets();
  await stopSockets();
  await releaseHttpServer();
  forgetRealIp();
  setTrust(authnTrust, httpTrust);
  await startServer();
  await startSockets(60000);
}

async function socketAddress(): Promise<string> {
  const socket = socketTo({ headers: { 'x-forwarded-for': CLIENT } });
  await connected(socket);
  return resultOf(await command<string>(socket, 'clientaddr.where'));
}

async function requestAddress(): Promise<string | null> {
  return (await new Client().get(`/${AUTHN_PROBE_PATH}`, { 'X-Forwarded-For': CLIENT })).body.clientIp;
}

describe('@spinajs/authn-http/socket: a socket gets the client address AuthnRealIp gives a request', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
  });

  afterEach(() => {
    DI.unregister(AppRealIp);
  });

  after(async () => {
    closeSockets();
    await stopSockets();
    await releaseHttpServer();
    forgetRealIp();
    setTrust(undefined, undefined);
    await stopApp();
  });

  it('an app RealIp over AuthnRealIp gives the socket and the request one client, whatever the settings say', async () => {
    DI.register(AppRealIp).as(RealIp);
    await restart(0, 0);

    const address = await socketAddress();
    expect(address).to.equal(CLIENT);
    expect(await requestAddress()).to.equal(address);
  });

  it('authn.http.trustProxy wins over http.trustProxy', async () => {
    await restart([], 'loopback');

    const address = await socketAddress();
    expect(address).to.match(LOOPBACK);
    expect(await requestAddress()).to.equal(address);
  });

  it('authn.http.trustProxy: false does not fall back to http.trustProxy', async () => {
    await restart(false, 'loopback');

    const address = await socketAddress();
    expect(address).to.match(LOOPBACK);
    expect(await requestAddress()).to.equal(address);
  });

  it('a null authn.http.trustProxy falls back to http.trustProxy', async () => {
    await restart(null, 1);

    expect(await socketAddress()).to.equal(CLIENT);
    expect(await requestAddress()).to.equal(CLIENT);
  });

  it('refuses to start the socket server with a bad authn.http.trustProxy entry', async () => {
    closeSockets();
    await stopSockets();
    forgetRealIp();
    setTrust(['not-an-address'], undefined);

    const failure = await startSockets(60000).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((failure as Error | undefined)?.message).to.match(/authn\.http\.trustProxy entry "not-an-address"/);
  });
});
