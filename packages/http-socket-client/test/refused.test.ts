import 'mocha';
import { expect } from 'chai';
import { SYSTEM_EVENTS, WIRE_EVENTS, type EventFrame, type SocketError } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { FAST_RECONNECT, makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, until, waitForState } from './support/wait.js';

describe('Connection refusals that retrying cannot fix', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  for (const code of ['forbidden', 'invalid_argument'] as const) {
    it(`stops after one attempt and emits refused for a non-retryable ${code} refusal`, async () => {
      server.refuse = () => ({ code, message: 'nope', retryable: false });
      const connection = makeConnection(server);
      const refused = nextEmit<[SocketError]>((listener) => connection.events.on('refused', listener));
      const authRequired: unknown[] = [];
      const incompatible: unknown[] = [];
      connection.events.on('auth_required', (error) => authRequired.push(error));
      connection.events.on('incompatible', (error) => incompatible.push(error));

      connection.connect();
      const [error] = await refused;
      await sleep(FAST_RECONNECT.maxMs * 1.5);

      expect(error).to.deep.include({ code, message: 'nope', retryable: false });
      expect(connection.state).to.equal('offline');
      expect(server.handshakes).to.have.length(1);
      expect(authRequired).to.deep.equal([]);
      expect(incompatible).to.deep.equal([]);
    });
  }

  it('does not emit refused for unauthenticated', async () => {
    server.refuse = () => ({ code: 'unauthenticated', message: 'expired', retryable: false });
    const connection = makeConnection(server);
    const refused: unknown[] = [];
    connection.events.on('refused', (error) => refused.push(error));
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));

    connection.connect();
    await authRequired;
    await sleep(50);

    expect(refused).to.deep.equal([]);
  });

  it('keeps retrying a retryable refusal', async () => {
    server.refuse = () => ({ code: 'forbidden', message: 'busy', retryable: true });
    const connection = makeConnection(server);
    const refused: unknown[] = [];
    connection.events.on('refused', (error) => refused.push(error));

    connection.connect();
    await until(() => server.handshakes.length >= 3);

    expect(refused).to.deep.equal([]);
  });

  it('stops and emits refused when kicked with a non-retryable code', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const refused: SocketError[] = [];
    connection.events.on('refused', (error) => refused.push(error));
    connection.connect();
    await waitForState(target, 'online');

    server.kick('forbidden');
    await waitForState(target, 'offline');
    await sleep(FAST_RECONNECT.maxMs * 1.5);

    expect(refused).to.have.length(1);
    expect(refused[0]).to.deep.include({ code: 'forbidden', retryable: false });
    expect(server.handshakes).to.have.length(1);
    expect(connection.state).to.equal('offline');
  });

  it('keeps reconnecting after a kick with a retryable code or free-text reason', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const refused: unknown[] = [];
    connection.events.on('refused', (error) => refused.push(error));
    connection.connect();
    await waitForState(target, 'online');

    server.kick('unavailable');
    await waitForState(target, 'offline');
    await waitForState(target, 'online');
    server.kick('maintenance');
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(refused).to.deep.equal([]);
  });

  it('does not emit refused for a non-retryable kick when a listener already called disconnect()', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const refused: unknown[] = [];
    connection.events.on('refused', (error) => refused.push(error));
    connection.listen(WIRE_EVENTS.event, (frame: EventFrame) => {
      if (frame.name === SYSTEM_EVENTS.disconnect) connection.disconnect();
    });
    connection.connect();
    await waitForState(target, 'online');

    server.kick('forbidden');
    await sleep(200);

    expect(refused).to.deep.equal([]);
    expect(connection.state).to.equal('offline');
  });

  it('honours a pending shutdown hint when connect() is called while online', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');
    server.announceShutdown(300);
    await sleep(50);

    connection.connect();
    const droppedAt = Date.now();
    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(Date.now() - droppedAt).to.be.at.least(290);
  });
});
