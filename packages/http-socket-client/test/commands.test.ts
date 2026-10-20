import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { CommandDispatcher } from '../src/commands.js';
import { closeAll } from './support/cleanup.js';
import { onlineDispatcher, rejectionOf } from './support/commands.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { sleep, waitForState } from './support/wait.js';

chai.use(chaiAsPromised);

describe('CommandDispatcher replies', () => {
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

  it('resolves with the result and sends {id, name, payload, deadline, traceparent}', async () => {
    server.handlers.set('math.add', (payload: { a: number; b: number }) => payload.a + payload.b);
    const { commands } = await onlineDispatcher(server);

    await expect(commands.execute('math.add', { a: 2, b: 3 }, { traceparent: '00-abc-def-01' })).to.eventually.equal(5);

    const [request] = server.requests;
    expect(request).to.include({ name: 'math.add', traceparent: '00-abc-def-01' });
    expect(request.id).to.be.a('string');
    expect(request.payload).to.deep.equal({ a: 2, b: 3 });
    expect(request.deadline).to.be.within(1, 1000);
    expect(request).to.not.have.property('idempotencyKey');
  });

  it('resolves a void command with the null the server sends, and gives every request its own id', async () => {
    server.handlers.set('docs.touch', () => undefined);
    const { commands } = await onlineDispatcher(server);

    expect(await commands.execute('docs.touch', { id: 1 })).to.equal(null);
    await commands.execute('docs.touch', { id: 2 });

    expect(server.requests[0].id).to.not.equal(server.requests[1].id);
  });

  it('rejects with a SocketException carrying the server SocketError', async () => {
    server.handlers.set('docs.open', () => {
      throw { code: 'not_found', message: 'no such doc', retryable: false, errorId: 'e-9' };
    });
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.open', { id: 'x' }));

    expect(error.message).to.equal('no such doc');
    expect([error.code, error.retryable, error.errorId]).to.deep.equal(['not_found', false, 'e-9']);
    expect(error.toWire()).to.deep.equal({ code: 'not_found', message: 'no such doc', retryable: false, errorId: 'e-9' });
  });

  it('passes unimplemented through for an unknown command', async () => {
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.nope', null));

    expect(error.code).to.equal('unimplemented');
    expect(error.retryable).to.equal(false);
  });

  it('rejects a stream reply with failed_precondition', async () => {
    server.rawReplies.set('docs.snapshot', (request) => ({ id: request.id, ok: true, stream: true }));
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('docs.snapshot', null));

    expect(error.code).to.equal('failed_precondition');
  });

  it('rejects a malformed reply with internal', async () => {
    server.rawReplies.set('bad', () => 'garbage');
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('bad', null));

    expect(error.toWire()).to.deep.equal({ code: 'internal', message: 'malformed reply', retryable: false });
  });

  it('carries binary payloads and results as socket.io attachments', async () => {
    server.handlers.set('echo', (payload: unknown) => payload);
    const { commands } = await onlineDispatcher(server);

    const result = await commands.execute('echo', new Uint8Array([1, 2, 3]));

    expect(Array.from(new Uint8Array(result as ArrayBuffer))).to.deep.equal([1, 2, 3]);
  });

  it("whenOffline 'fail' (the default) rejects at once with retryable unavailable", async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 1000);

    const error = await rejectionOf(commands.execute('ping', null));

    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client is offline', retryable: true });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });

  it("whenOffline 'wait' holds commands until online and sends them in call order", async () => {
    server.handlers.set('a', () => 'A');
    server.handlers.set('b', () => 'B');
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 2000);
    const first = commands.execute('a', null, { whenOffline: 'wait' });
    const second = commands.execute('b', null, { whenOffline: 'wait' });

    connection.connect();
    await waitForState(statefulConnection(connection), 'online');

    expect(await Promise.all([first, second])).to.deep.equal(['A', 'B']);
    expect(server.requests.map((request) => request.name)).to.deep.equal(['a', 'b']);
  });
});
