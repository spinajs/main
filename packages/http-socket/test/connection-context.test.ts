import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, SocketController } from '../src/decorators.js';
import { SocketHub } from '../src/hub.js';
import { ISocketCallStorage, ISocketHandshake, SocketConnectionContext } from '../src/interfaces.js';
import { ITestServer, command, connect, open, refusalOf, resultOf, startServer } from './harness.js';

interface StoreProbe {
  keys: string[];
  shard: unknown;
  principalType: string | null;
}

@SocketController('ctxprobe')
export class ContextProbeSocket extends BaseSocketController {
  @Command('store')
  public async store(): Promise<StoreProbe> {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { keys: Object.keys(store ?? {}).sort(), shard: store?.Shard ?? null, principalType: store?.Principal.type ?? null };
  }
}

class ShardContext extends SocketConnectionContext {
  public static calls = 0;

  public establish(handshake: ISocketHandshake, principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    ShardContext.calls += 1;
    if (handshake.auth.shard === 'closed') return Promise.reject(new SocketException('forbidden', 'shard closed'));
    return Promise.resolve({ Shard: handshake.auth.shard ?? 'eu', Principal: 'forged', PrincipalSeen: principal.type });
  }
}

const FIXED_KEYS = ['AuthnPrincipal', 'Principal', 'clientId', 'connectionId', 'realIp', 'requestId', 'socketCall', 'spanId', 'traceId'];

describe('socket connection context', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  const probe = async (auth: Record<string, unknown> = {}): Promise<StoreProbe> => resultOf(await command<StoreProbe>(track(await open(t, { auth })), 'ctxprobe.store'));

  beforeEach(async () => {
    t = await startServer();
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('leaves the call store as it was when nothing is registered', async () => {
    const seen = await probe();

    expect(seen.keys).to.deep.equal(FIXED_KEYS);
    expect(seen.shard).to.equal(null);
  });

  describe('with a registered contributor', () => {
    before(() => {
      DI.register(ShardContext).as(SocketConnectionContext);
    });

    after(() => {
      DI.unregister(ShardContext);
    });

    beforeEach(() => {
      ShardContext.calls = 0;
    });

    it('asks it once per handshake and puts its keys into the store of every call', async () => {
      const socket = track(await open(t, { auth: { shard: 'us' } }));

      const first = resultOf(await command<StoreProbe>(socket, 'ctxprobe.store'));
      const second = resultOf(await command<StoreProbe>(socket, 'ctxprobe.store'));

      expect(first.shard).to.equal('us');
      expect(second.shard).to.equal('us');
      expect(first.keys).to.deep.equal([...FIXED_KEYS, 'PrincipalSeen', 'Shard'].sort());
      expect(ShardContext.calls).to.equal(1);
      expect(DI.resolve(SocketHub).connection(socket.id!)!.context).to.include({ Shard: 'us', PrincipalSeen: 'unattended' });
    });

    it('keeps the keys of one connection out of the calls of another', async () => {
      const us = track(await open(t, { auth: { shard: 'us' } }));
      const eu = track(await open(t, { auth: { clientId: 'client-2' } }));

      const [fromUs, fromEu] = await Promise.all([command<StoreProbe>(us, 'ctxprobe.store'), command<StoreProbe>(eu, 'ctxprobe.store')]);

      expect([resultOf(fromUs).shard, resultOf(fromEu).shard]).to.deep.equal(['us', 'eu']);
    });

    it('never lets it replace a fixed key of the store', async () => {
      expect((await probe()).principalType).to.equal('unattended');
    });

    it('refuses the handshake when it throws', async () => {
      const error = await refusalOf(track(connect(t, { auth: { shard: 'closed' } })));

      expect(error).to.include({ code: 'forbidden', message: 'shard closed' });
    });
  });
});
