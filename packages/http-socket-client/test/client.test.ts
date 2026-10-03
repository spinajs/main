import 'mocha';
import { expect } from 'chai';
import { SYSTEM_EVENTS, type DisconnectNotice, type SocketError } from '@spinajs/http-socket-common';
import { LIFECYCLE_EVENTS, type LifecycleEventName } from '../src/client.js';
import type { ConnectionState } from '../src/connection.js';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { rejectionOf } from './support/commands.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, until, waitForState } from './support/wait.js';

describe('SocketClient', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('connects on construction and reports state changes with the previous state', async () => {
    const client = makeClient(server);
    const seen: Array<[ConnectionState, ConnectionState]> = [];
    client.on('state', (state, previous) => seen.push([state, previous]));

    await until(() => seen.length === 2);

    expect(seen).to.deep.equal([
      ['connecting', 'offline'],
      ['online', 'connecting'],
    ]);
    expect(await client.command('ping')).to.equal('pong');
  });

  it("with autoConnect: false stays offline; a 'wait' command goes out on connect()", async () => {
    const client = makeClient(server, { autoConnect: false });
    await sleep(50);
    expect(client.state).to.equal('offline');
    const pending = client.command<string>('ping', null, { whenOffline: 'wait' });

    client.connect();

    expect(await pending).to.equal('pong');
  });

  it('applies defaultTimeoutMs as the command budget', async () => {
    const client = makeClient(server, { defaultTimeoutMs: 1234 });
    await waitForState(statefulClient(client), 'online');

    await client.command('ping');

    expect(server.requests[0].deadline).to.be.within(1000, 1234);
  });

  it('delivers server events to on() listeners; unsubscribe, off() and once() stop them', async () => {
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const viaOn: number[] = [];
    const viaOff: number[] = [];
    const viaOnce: number[] = [];
    const unsubscribe = client.on<{ rev: number }>('docs.committed', (event) => viaOn.push(event.rev));
    const offListener = (event: { rev: number }): void => {
      viaOff.push(event.rev);
    };
    client.on('docs.committed', offListener);
    client.once<{ rev: number }>('docs.committed', (event) => viaOnce.push(event.rev));

    server.emitEvent('docs.committed', { rev: 1 });
    await until(() => viaOn.length === 1);
    unsubscribe();
    client.off('docs.committed', offListener);
    server.emitEvent('docs.committed', { rev: 2 });
    await sleep(50);

    expect(viaOn).to.deep.equal([1]);
    expect(viaOff).to.deep.equal([1]);
    expect(viaOnce).to.deep.equal([1]);
  });

  for (const name of LIFECYCLE_EVENTS) {
    it(`never routes a server event named '${name}' to lifecycle listeners`, async () => {
      const client = makeClient(server);
      await waitForState(statefulClient(client), 'online');
      const lifecycleCalls: unknown[][] = [];
      client.on(name as LifecycleEventName, ((...args: unknown[]) => lifecycleCalls.push(args)) as never);
      const sentinel = nextEmit<[unknown]>((listener) => client.on('sentinel', listener));

      server.emitEvent(name, 'hijack');
      server.emitEvent('sentinel', 1);
      await sentinel;

      expect(lifecycleCalls).to.deep.equal([]);
    });
  }

  it('forwards refused from the connection to client listeners', async () => {
    server.refuse = () => ({ code: 'forbidden', message: 'no', retryable: false });
    const client = makeClient(server);
    const refused = nextEmit<[SocketError]>((listener) => client.on('refused', listener));

    const [error] = await refused;

    expect(error.code).to.equal('forbidden');
    expect(client.state).to.equal('offline');
  });

  it('delivers the sys.disconnect notice before a kick, so a listener can stop the reconnect', async () => {
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const notices: DisconnectNotice[] = [];
    client.on<DisconnectNotice>(SYSTEM_EVENTS.disconnect, (notice) => {
      notices.push(notice);
      client.disconnect();
    });

    server.kick('replaced by another session');
    await until(() => notices.length === 1);
    await sleep(150);

    expect(notices).to.deep.equal([{ reason: 'replaced by another session' }]);
    expect(client.state).to.equal('offline');
    expect(server.handshakes).to.have.length(1);
  });

  it('emit() sends an event frame when online and drops it when offline', async () => {
    const client = makeClient(server, { autoConnect: false });
    expect(client.emit('docs.cursor', { x: 0 })).to.equal(false);
    client.connect();
    await waitForState(statefulClient(client), 'online');

    expect(client.emit('docs.cursor', { x: 1 })).to.equal(true);

    await until(() => server.clientEvents.length === 1);
    expect(server.clientEvents).to.deep.equal([{ name: 'docs.cursor', payload: { x: 1 } }]);
  });

  it('reports a throwing listener to onListenerError and still calls the others', async () => {
    const errors: unknown[] = [];
    const client = makeClient(server, { onListenerError: (error) => errors.push(error) });
    await waitForState(statefulClient(client), 'online');
    const seen: number[] = [];
    client.on('tick', () => {
      throw new Error('boom');
    });
    client.on<number>('tick', (n) => seen.push(n));

    server.emitEvent('tick', 1);
    await until(() => seen.length === 1);

    expect(errors).to.have.length(1);
    expect((errors[0] as Error).message).to.equal('boom');
  });

  it('reserves durable(): it rejects with unimplemented', async () => {
    const client = makeClient(server, { autoConnect: false });

    const durableError = await rejectionOf(client.durable('docs.submit', {}));

    expect(durableError.code).to.equal('unimplemented');
  });

  it('generates a clientId when none is given and sends it in the handshake', async () => {
    const client = makeClient(server, { clientId: undefined });
    await waitForState(statefulClient(client), 'online');

    expect(client.clientId).to.be.a('string').and.not.equal('');
    expect(server.handshakes[0].clientId).to.equal(client.clientId);
  });

  it('forwards auth_required and incompatible', async () => {
    server.refuse = (handshake) =>
      handshake.clientId === 'needs-login'
        ? { code: 'unauthenticated', message: 'login', retryable: false }
        : { code: 'version_mismatch', message: 'too old', retryable: false };
    const loggedOut = makeClient(server, { clientId: 'needs-login', autoConnect: false });
    const outdated = makeClient(server, { clientId: 'outdated', autoConnect: false });
    const authRequired = nextEmit<[SocketError]>((listener) => loggedOut.on('auth_required', listener));
    const incompatible = nextEmit<[SocketError]>((listener) => outdated.on('incompatible', listener));

    loggedOut.connect();
    outdated.connect();

    expect((await authRequired)[0].code).to.equal('unauthenticated');
    expect((await incompatible)[0].code).to.equal('version_mismatch');
  });

  it('close() rejects pending commands and makes the client terminal', async () => {
    const client = makeClient(server, { autoConnect: false });
    const pending = rejectionOf(client.command('ping', null, { whenOffline: 'wait' }));

    client.close();

    expect(client.state).to.equal('closed');
    expect((await pending).toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is closed', retryable: false });
    expect(() => client.connect()).to.throw('the client is closed');
  });
});
