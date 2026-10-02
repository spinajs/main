import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { recordStates, retryGaps, sleep, until, waitForState } from './support/wait.js';

function expectGaps(actual: number[], expected: number[]): void {
  expect(actual).to.have.length(expected.length);
  actual.forEach((gap, i) => expect(gap, `gap ${i}`).to.be.within(expected[i] - 5, expected[i] + 60));
}

describe('Connection resilience', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('reconnects after the engine connection is killed and asks auth again', async () => {
    let calls = 0;
    const connection = makeConnection(server, { auth: () => ({ token: `t${++calls}` }) });
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(server.handshakes.map((handshake) => handshake.token)).to.deep.equal(['t1', 't2']);
  });

  it('backs off exponentially between refused attempts and starts over after success', async () => {
    let refusing = true;
    server.refuse = () => (refusing ? { code: 'unavailable', message: 'busy', retryable: true } : undefined);
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const states = recordStates(target);

    connection.connect();
    await until(() => server.handshakes.length >= 5);
    refusing = false;
    await waitForState(target, 'online');
    expectGaps(retryGaps(states).slice(0, 4), [20, 40, 80, 100]);

    states.length = 0;
    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');
    expectGaps(retryGaps(states), [20]);
  });

  it('waits retryAfterMs announced by sys.shutdown before the next attempt', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    server.announceShutdown(300);
    await sleep(50);
    const droppedAt = Date.now();
    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(Date.now() - droppedAt).to.be.at.least(290);
  });

  it('reconnects after a server-side disconnect (a SocketHub kick)', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    server.kick('maintenance');
    await waitForState(target, 'offline');
    await waitForState(target, 'online');

    expect(server.handshakes).to.have.length(2);
  });

  it('honours retryAfterMs of a retryable handshake refusal', async () => {
    let refusals = 1;
    server.refuse = () => (refusals-- > 0 ? { code: 'unavailable', message: 'draining', retryable: true, retryAfterMs: 250 } : undefined);
    const connection = makeConnection(server);
    const startedAt = Date.now();

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(Date.now() - startedAt).to.be.at.least(240);
    expect(server.handshakes).to.have.length(2);
  });

  it('reconnects to a server restarted on the same port', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');

    await server.stop();
    await waitForState(target, 'offline');
    await sleep(300);
    await server.start(server.port);

    await waitForState(target, 'online', 8000);
  });

  it('abandons a handshake unanswered within connectTimeoutMs and retries', async () => {
    server.holdHandshakes = true;
    const connection = makeConnection(server, { connectTimeoutMs: 150 });
    const target = statefulConnection(connection);
    const states = recordStates(target);

    connection.connect();
    await until(() => server.handshakes.length >= 2, 3000);

    expect(states.slice(0, 3).map((record) => record.state)).to.deep.equal(['connecting', 'offline', 'connecting']);
    expect(states[1].at - states[0].at).to.be.at.least(140);
    server.holdHandshakes = false;
    await waitForState(target, 'online', 3000);
  });

  it('never lets socket.io re-send packets it buffered before a drop', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');
    // Reaches into the private socket: a packet socket.io buffered while the transport was dying.
    const socket = (connection as unknown as { socket: { sendBuffer: unknown[] } }).socket;
    socket.sendBuffer.push({ type: 2, data: ['cmd', { id: 'ghost', name: 'ghost', payload: null }], options: { compress: true } });

    server.killConnections();
    await waitForState(target, 'offline');
    await waitForState(target, 'online');
    await sleep(100);

    expect(server.requests.map((request) => request.name)).to.not.include('ghost');
  });
});
