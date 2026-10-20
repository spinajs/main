import 'mocha';
import { expect } from 'chai';
import { PROTOCOL_VERSION, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { recordStates, sleep, until, waitForState } from './support/wait.js';

describe('Connection', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('starts offline and goes connecting → online on connect()', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    const states = recordStates(target);
    expect(connection.state).to.equal('offline');

    connection.connect();

    expect(connection.state).to.equal('connecting');
    await waitForState(target, 'online');
    expect(states.map((record) => record.state)).to.deep.equal(['connecting', 'online']);
    expect(connection.connected).to.equal(true);
  });

  it('sends the handshake {protocol, clientId, token} built from the auth callback', async () => {
    const connection = makeConnection(server, { clientId: 'install-42', auth: async () => ({ token: 'secret', locale: 'pl' }) });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes).to.deep.equal([{ token: 'secret', locale: 'pl', protocol: PROTOCOL_VERSION, clientId: 'install-42' }]);
  });

  it('never lets the auth callback override protocol or clientId', async () => {
    const connection = makeConnection(server, { clientId: 'install-42', auth: () => ({ token: 't', protocol: 99, clientId: 'someone-else' }) });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes[0]).to.deep.equal({ token: 't', protocol: PROTOCOL_VERSION, clientId: 'install-42' });
  });

  it('close() is terminal: state closed, socket released, connect() throws', async () => {
    const connection = makeConnection(server);
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    connection.close();

    expect(connection.state).to.equal('closed');
    await until(() => server.connectionCount === 0);
    expect(() => connection.connect()).to.throw('the client is closed');
  });

  it('disconnect() goes offline and stays there until connect()', async () => {
    const connection = makeConnection(server);
    const target = statefulConnection(connection);
    connection.connect();
    await waitForState(target, 'online');
    const before = server.handshakes.length;

    connection.disconnect();

    expect(connection.state).to.equal('offline');
    await sleep(150);
    expect(connection.state).to.equal('offline');
    expect(server.handshakes).to.have.length(before);

    connection.connect();
    await waitForState(target, 'online');
    expect(server.handshakes).to.have.length(before + 1);
  });

  it('send() and listen() carry raw socket.io events; send() refuses while offline', async () => {
    const connection = makeConnection(server);
    expect(connection.send(WIRE_EVENTS.event, { name: 'early', payload: 0 })).to.equal(false);
    const received: unknown[] = [];
    const stopListening = connection.listen(WIRE_EVENTS.event, (frame) => received.push(frame));
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(connection.send(WIRE_EVENTS.event, { name: 'hello', payload: 1 })).to.equal(true);
    await until(() => server.clientEvents.length === 1);
    expect(server.clientEvents).to.deep.equal([{ name: 'hello', payload: 1 }]);

    server.emitEvent('docs.committed', { rev: 2 });
    await until(() => received.length === 1);
    expect(received).to.deep.equal([{ name: 'docs.committed', payload: { rev: 2 } }]);

    stopListening();
    server.emitEvent('docs.committed', { rev: 3 });
    await sleep(50);
    expect(received).to.have.length(1);
  });
});
