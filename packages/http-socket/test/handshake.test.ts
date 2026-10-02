import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { UNATTENDED } from '@spinajs/authz';
import { MAX_ID_LENGTH, PROTOCOL_VERSION } from '@spinajs/http-socket-common';
import { SocketHub } from '../src/hub.js';
import { ALICE, ALICE_PRINCIPAL, IConnectOptions, ITestServer, TestPrincipalSource, connect, open, refusalOf, startServer, waitFor } from './harness.js';

describe('socket handshake', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  const refusal = (options: IConnectOptions) => refusalOf(track(connect(t, options)));

  beforeEach(async () => {
    t = await startServer();
  });

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('accepts a client speaking the current protocol and runs it as UNATTENDED without credentials', async () => {
    const socket = track(await open(t, { auth: { clientId: 'c-accept' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect(connection.clientId).to.equal('c-accept');
    expect(connection.principal).to.equal(UNATTENDED);
    expect(connection.authenticated).to.be.false;
    expect(connection.user).to.be.undefined;
  });

  it('refuses another protocol version with version_mismatch', async () => {
    const error = await refusal({ auth: { protocol: 999 } });
    expect(error).to.include({ code: 'version_mismatch', retryable: false });
    expect(error.details).to.deep.equal({ server: PROTOCOL_VERSION });
  });

  it('refuses a handshake without a protocol version', async () => {
    const error = await refusal({ auth: { protocol: undefined } });
    expect(error.code).to.equal('version_mismatch');
  });

  it('refuses a handshake without a clientId', async () => {
    const error = await refusal({ auth: { clientId: '' } });
    expect(error).to.deep.equal({ code: 'invalid_argument', message: 'handshake auth.clientId must be a non-empty string', retryable: false });
    expect((await refusal({ auth: { clientId: 42 } })).message).to.equal('handshake auth.clientId must be a non-empty string');
  });

  it('refuses an overlong clientId and says so', async () => {
    const error = await refusal({ auth: { clientId: 'x'.repeat(MAX_ID_LENGTH + 1) } });
    expect(error).to.deep.equal({ code: 'invalid_argument', message: `handshake auth.clientId is longer than ${MAX_ID_LENGTH} characters`, retryable: false });
    expect(track(await open(t, { auth: { clientId: 'x'.repeat(MAX_ID_LENGTH) } })).connected).to.be.true;
  });

  it('refuses with internal when a principal source throws an unmapped error', async () => {
    const error = await refusal({ auth: { token: 'crash' } });
    expect(error).to.include({ code: 'internal', retryable: false });
    expect(error.errorId).to.be.a('string');
  });

  it('builds the handshake view once: the connection keeps the one the principal sources saw', async () => {
    const socket = track(await open(t, { auth: { token: 'good' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect(TestPrincipalSource.lastHandshake).to.equal(connection.handshake);
  });

  it('refuses when a principal source throws', async () => {
    const error = await refusal({ auth: { token: 'bad' } });
    expect(error).to.deep.equal({ code: 'unauthenticated', message: 'invalid token', retryable: false });
  });

  it('keeps the principal a source returns, with its identity as the user', async () => {
    const socket = track(await open(t, { auth: { token: 'good' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect(connection.principal).to.equal(ALICE_PRINCIPAL);
    expect(connection.authenticated).to.be.true;
    expect(connection.auth.source).to.equal('test');
    expect(connection.user).to.deep.equal(ALICE);
  });

  it('exposes handshake headers and cookies', async () => {
    const socket = track(await open(t, { headers: { cookie: 'sid=abc%20def; theme="dark"', 'x-app': 'editor' } }));
    const connection = DI.resolve(SocketHub).connection(socket.id!)!;

    expect({ ...connection.handshake.cookies }).to.deep.equal({ sid: 'abc def', theme: 'dark' });
    expect(connection.handshake.headers['x-app']).to.equal('editor');
  });

  it('drops the connection from the hub on disconnect', async () => {
    const socket = track(await open(t));
    const id = socket.id!;
    const hub = DI.resolve(SocketHub);

    expect(hub.connection(id)).to.exist;
    socket.disconnect();
    await waitFor(() => hub.connection(id) === undefined);
  });
});

describe('socket handshake: origin and required authentication', function () {
  this.timeout(15000);

  let t: ITestServer | undefined;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t?.close();
    t = undefined;
  });

  it('refuses a handshake without credentials when http.socket.auth.required is set, and accepts one with', async () => {
    t = await startServer({ http: { socket: { auth: { required: true } } } });

    expect(await refusalOf(track(connect(t)))).to.deep.equal({ code: 'unauthenticated', message: 'authentication required', retryable: false });
    expect(track(await open(t, { auth: { token: 'good' } })).connected).to.be.true;
  });

  it('SR-12 refuses a cross-origin handshake before any principal source runs (empty origin list)', async () => {
    t = await startServer();

    const error = await refusalOf(track(connect(t, { auth: { token: 'bad' }, headers: { origin: 'https://evil.example' } })));
    expect(error).to.deep.equal({ code: 'forbidden', message: 'origin not allowed', retryable: false });
  });

  it('hides the message of an unmapped principal source error in production', async () => {
    t = await startServer({ configuration: { isProduction: true } });

    const error = await refusalOf(track(connect(t, { auth: { token: 'crash' } })));
    expect(error.errorId).to.be.a('string');
    expect(error).to.deep.equal({ code: 'internal', message: 'Internal server error', retryable: false, errorId: error.errorId });
  });

  it('SR-12 refuses Origin: null, even when listed', async () => {
    t = await startServer({ http: { socket: { cors: { origins: ['null'] } } } });

    expect(await refusalOf(track(connect(t, { headers: { origin: 'null' } })))).to.deep.equal({ code: 'forbidden', message: 'origin not allowed', retryable: false });
  });

  it('SR-12 same-origin means the same scheme, host and port', async () => {
    t = await startServer();

    expect((await refusalOf(track(connect(t, { headers: { origin: t.url.replace('http:', 'https:') } })))).code).to.equal('forbidden');
    expect((await refusalOf(track(connect(t, { headers: { origin: t.url.replace(/:\d+$/, ':1') } })))).code).to.equal('forbidden');
  });

  it('SR-12 accepts same-origin and exactly listed origins only; no wildcard', async () => {
    t = await startServer({ http: { socket: { cors: { origins: ['https://app.example', '*'] } } } });

    expect(track(await open(t, { headers: { origin: t.url } })).connected).to.be.true;
    expect(track(await open(t, { headers: { origin: 'https://app.example' } })).connected).to.be.true;
    expect((await refusalOf(track(connect(t, { headers: { origin: 'https://other.example' } })))).code).to.equal('forbidden');
  });
});
