import 'mocha';
import { expect } from 'chai';
import { MAX_ID_LENGTH, type SocketError } from '@spinajs/http-socket-common';
import { closeAll } from './support/cleanup.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { nextEmit, sleep, waitForState } from './support/wait.js';

const UNAUTHENTICATED: SocketError = { code: 'unauthenticated', message: 'token expired', retryable: false };

describe('Connection handshake errors', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('stops retrying and emits auth_required when the handshake is unauthenticated', async () => {
    server.refuse = () => UNAUTHENTICATED;
    const connection = makeConnection(server);
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));

    connection.connect();
    const [error] = await authRequired;

    expect(error).to.deep.include({ code: 'unauthenticated', message: 'token expired' });
    expect(connection.state).to.equal('offline');
    await sleep(200);
    expect(server.handshakes).to.have.length(1);
    expect(connection.state).to.equal('offline');
  });

  it('connect() after auth_required tries again and asks auth for a fresh token', async () => {
    let token = 'old';
    server.refuse = (handshake) => (handshake.token === 'old' ? UNAUTHENTICATED : undefined);
    const connection = makeConnection(server, { auth: () => ({ token }) });
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));
    connection.connect();
    await authRequired;

    token = 'new';
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(server.handshakes.map((handshake) => handshake.token)).to.deep.equal(['old', 'new']);
  });

  it('stops retrying and emits incompatible on version_mismatch', async () => {
    server.refuse = () => ({ code: 'version_mismatch', message: 'server speaks protocol 2', retryable: false });
    const connection = makeConnection(server);
    const incompatible = nextEmit<[SocketError]>((listener) => connection.events.on('incompatible', listener));

    connection.connect();
    const [error] = await incompatible;

    expect(error.code).to.equal('version_mismatch');
    expect(connection.state).to.equal('offline');
    await sleep(200);
    expect(server.handshakes).to.have.length(1);
  });

  it('throws at construction for a clientId the server would refuse with invalid_argument', () => {
    expect(() => makeConnection(server, { clientId: '' })).to.throw(RangeError);
    expect(() => makeConnection(server, { clientId: 'x'.repeat(MAX_ID_LENGTH + 1) })).to.throw(RangeError);
    expect(() => makeConnection(server, { clientId: 'x'.repeat(MAX_ID_LENGTH) })).to.not.throw();
    expect(server.handshakes).to.have.length(0);
  });

  it('treats a throwing auth callback as auth_required without sending a handshake', async () => {
    const connection = makeConnection(server, {
      auth: () => {
        throw new Error('refresh failed');
      },
    });
    const authRequired = nextEmit<[SocketError]>((listener) => connection.events.on('auth_required', listener));

    connection.connect();
    const [error] = await authRequired;

    expect(error.code).to.equal('unauthenticated');
    expect(error.message).to.contain('refresh failed');
    expect(server.handshakes).to.have.length(0);
    expect(connection.state).to.equal('offline');
  });
});
