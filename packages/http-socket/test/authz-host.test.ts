import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthzService, SYSTEM, principalKey } from '@spinajs/authz';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ITestServer, command, open, resultOf, startServer, waitFor } from './harness.js';

export const hostSeen = new Map<string, string>();

const authz = async (): Promise<AuthzService> => (await DI.resolve(AuthzService)) as AuthzService;

@SocketController('host')
export class HostSocket extends BaseSocketController {
  @Command('me')
  public async me() {
    return principalKey((await authz()).current());
  }

  @Command('system')
  public async system() {
    const service = await authz();
    const inside = await service.runAs(SYSTEM, 'socket-test', async () => principalKey(service.current()));
    return { inside, after: principalKey(service.current()) };
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    hostSeen.set(conn.id, principalKey((await authz()).current()));
  }
}

describe('authz-v3 host in socket handlers', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let anonymous: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'host-alice', token: 'good' } });
    anonymous = await open(t, { auth: { clientId: 'host-anon' } });
  });

  afterEach(async () => {
    alice.close();
    anonymous.close();
    await t.close();
  });

  it('current() is the connection principal in a command', async () => {
    expect(resultOf(await command(alice, 'host.me'))).to.equal('user:1');
  });

  it('current() is UNATTENDED for a connection without credentials (C9 default)', async () => {
    expect(resultOf(await command(anonymous, 'host.me'))).to.equal('unattended:unattended');
  });

  it('runAs(SYSTEM) inside a handler switches the principal for its callback only', async () => {
    expect(resultOf(await command(alice, 'host.system'))).to.deep.equal({ inside: 'system:system', after: 'user:1' });
  });

  it('connect hooks see the connection principal', async () => {
    await waitFor(() => hostSeen.has(alice.id!));
    expect(hostSeen.get(alice.id!)).to.equal('user:1');
  });
});
