import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthzContributor, AuthzService, SYSTEM, principalKey } from '@spinajs/authz';
import { SocketAccessContributor } from '../src/access-contributor.js';
import { BaseSocketController } from '../src/controller.js';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { Command, Connection, OnConnect, OnEvent, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ITestServer, command, open, resultOf, startServer, waitFor } from './harness.js';

const hostSeen = new Map<string, string>();
const hostEventSeen = new Map<string, string>();

const gate = { entered: false, release: (): void => undefined, opened: Promise.resolve() };

function closeGate(): void {
  gate.entered = false;
  gate.opened = new Promise<void>((resolve) => (gate.release = resolve));
}

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

  @Command('held')
  public async held() {
    const service = await authz();
    return service.runAs(SYSTEM, 'socket-test', async () => {
      gate.entered = true;
      await gate.opened;
      return principalKey(service.current());
    });
  }

  @OnEvent('probe')
  public async probe(@Connection() conn: SocketConnection) {
    hostEventSeen.set(conn.id, principalKey((await authz()).current()));
  }

  // connect hooks run for every connection of the process; other files' connections would boot their AuthzService here
  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    if (!conn.clientId.startsWith('host-')) {
      return;
    }
    hostSeen.set(conn.id, principalKey((await authz()).current()));
  }
}

describe('authz-v3 host in socket handlers', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let anonymous: ClientSocket;

  // the @SocketAccess permissions of other files' controllers are not registered in this empty root, so B02 would fail its boot
  before(() => {
    DI.unregister(SocketAccessContributor);
  });

  after(() => {
    DI.register(SocketAccessContributor).as(AuthzContributor);
  });

  beforeEach(async () => {
    closeGate();
    t = await startServer();
    alice = await open(t, { auth: { clientId: 'host-alice', token: 'good' } });
    anonymous = await open(t, { auth: { clientId: 'host-anon' } });
  });

  afterEach(async () => {
    gate.release();
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

  it('a runAs held open by one command does not leak into a concurrent command on the same connection', async () => {
    const held = command(alice, 'host.held');
    await waitFor(() => gate.entered);

    expect(resultOf(await command(alice, 'host.me'))).to.equal('user:1');

    gate.release();
    expect(resultOf(await held)).to.equal('system:system');
  });

  it('connect hooks see the connection principal', async () => {
    await waitFor(() => hostSeen.has(alice.id!));
    expect(hostSeen.get(alice.id!)).to.equal('user:1');
  });

  it('leaves the connections of other test files to their own AuthzService: its connect hook asks none for them', async () => {
    const other = await open(t, { auth: { clientId: 'nothost-alice', token: 'good' } });
    try {
      // a command waits for the connection's connect hooks
      await command(other, 'host.me');
      expect(hostSeen.has(other.id!)).to.equal(false);
    } finally {
      other.close();
    }
  });

  it('event handlers see the connection principal', async () => {
    alice.emit(WIRE_EVENTS.event, { name: 'host.probe', payload: null });
    anonymous.emit(WIRE_EVENTS.event, { name: 'host.probe', payload: null });
    await waitFor(() => hostEventSeen.has(alice.id!) && hostEventSeen.has(anonymous.id!));

    expect(hostEventSeen.get(alice.id!)).to.equal('user:1');
    expect(hostEventSeen.get(anonymous.id!)).to.equal('unattended:unattended');
  });
});

describe('authz-v3 host in socket handlers, afterwards', function () {
  it('leaves B02 on for the test files that run after it', () => {
    expect(DI.getRegisteredTypes(AuthzContributor)).to.include(SocketAccessContributor);
  });
});
