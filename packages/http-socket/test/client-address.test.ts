import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy, RealIp } from '@spinajs/http';
import type { ClientAddressSource, ProxyTrust } from '@spinajs/http';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { ISocketCallStorage, ISocketHandshake } from '../src/interfaces.js';
import { ISocketPolicyRequest } from '../src/policies.js';
import { ITestServer, TestPrincipalSource, command, open, resultOf, startServer } from './harness.js';

export const cipSeen: { ip: string | null } = { ip: null };

export class CipCapture extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    cipSeen.ip = (req as ISocketPolicyRequest).ip;
  }
}

@SocketController('cip')
export class ClientAddressSocket extends BaseSocketController {
  @Command('where')
  @SocketPolicy(CipCapture)
  public async where() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { policy: cipSeen.ip, realIp: store?.realIp ?? null };
  }
}

/** An app's RealIp trusting one hop in code, with no trust setting. */
class OneHopRealIp extends RealIp {
  protected override proxyTrust(): ProxyTrust {
    return { hops: 1 };
  }
}

/** An app's RealIp reading the address a CDN sends. */
class CdnRealIp extends RealIp {
  public override clientAddress(req: ClientAddressSource): string | undefined {
    const cdn = req.headers['cf-connecting-ip'];
    return typeof cdn === 'string' ? cdn : super.clientAddress(req);
  }
}

describe('the handshake client address behind trusted proxies (G5)', function () {
  this.timeout(15000);

  let t: ITestServer | null = null;
  let sockets: ClientSocket[] = [];

  async function connectThrough(cfg: Record<string, unknown>, forwardedFor?: string): Promise<{ socket: ClientSocket; handshake: ISocketHandshake }> {
    t = await startServer(cfg);
    const socket = await open(t, forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } });
    sockets.push(socket);
    return { socket, handshake: DI.resolve(SocketHub).connection(socket.id!)!.handshake };
  }

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t?.close();
    t = null;
    cipSeen.ip = null;
    for (const sub of [OneHopRealIp, CdnRealIp]) {
      DI.unregister(sub);
      DI.uncache(sub);
    }
  });

  it('SR-03 without a trusted proxy the address is the peer, whatever X-Forwarded-For claims', async () => {
    const { handshake } = await connectThrough({}, '203.0.113.7');

    expect(handshake.address).to.equal('127.0.0.1');
    expect(handshake.peerAddress).to.match(/127\.0\.0\.1$/);
  });

  it('takes the X-Forwarded-For client from a trusted proxy hop ( http.trustProxy ), and principal sources see it', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: 'loopback' } }, '203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
    expect(handshake.peerAddress).to.match(/127\.0\.0\.1$/);
    expect(TestPrincipalSource.lastHandshake?.address).to.equal('203.0.113.7');
  });

  it('stops at the first untrusted hop: an entry the client wrote itself is ignored', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: 'loopback' } }, '198.51.100.9, 203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
  });

  it('follows a RealIp registered by the app: the handshake, policies and the call store see its client', async () => {
    DI.register(OneHopRealIp).as(RealIp);
    const { socket, handshake } = await connectThrough({}, '203.0.113.7');

    expect(handshake.address).to.equal('203.0.113.7');
    expect(resultOf(await command(socket, 'cip.where'))).to.deep.equal({ policy: '203.0.113.7', realIp: '203.0.113.7' });
  });

  it("takes the address from the registered RealIp's clientAddress override", async () => {
    DI.register(CdnRealIp).as(RealIp);
    t = await startServer({});
    const socket = await open(t, { headers: { 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '203.0.113.7' } });
    sockets.push(socket);

    expect(DI.resolve(SocketHub).connection(socket.id!)!.handshake.address).to.equal('198.51.100.20');
  });

  it('ignores authn.http.trustProxy without @spinajs/authn-http: only the registered RealIp counts', async () => {
    const { handshake } = await connectThrough({ authn: { http: { trustProxy: 1 } } }, '203.0.113.7');

    expect(handshake.address).to.equal('127.0.0.1');
  });

  it('policies and the call store see the trusted address', async () => {
    const { socket } = await connectThrough({ http: { trustProxy: 'loopback' } }, '203.0.113.7');

    expect(resultOf(await command(socket, 'cip.where'))).to.deep.equal({ policy: '203.0.113.7', realIp: '203.0.113.7' });
  });

  it('refuses to start with a trust entry that is no address or CIDR', async () => {
    await expect(startServer({ http: { trustProxy: ['not-an-address'] } })).to.be.rejectedWith(/http\.trustProxy entry "not-an-address"/);
  });

  it('a trust list that excludes the peer ignores X-Forwarded-For', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: ['10.0.0.1'] } }, '203.0.113.7');

    expect(handshake.address).to.equal('127.0.0.1');
  });

  it('walks across two trusted hops to the client', async () => {
    const { handshake } = await connectThrough({ http: { trustProxy: ['127.0.0.1', '127.0.0.2'] } }, '203.0.113.7, 127.0.0.2');

    expect(handshake.address).to.equal('203.0.113.7');
  });
});
