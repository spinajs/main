import 'mocha';
import * as chai from 'chai';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { CommandDispatcher } from '../src/commands.js';
import { closeAll } from './support/cleanup.js';
import { onlineDispatcher, rejectionOf } from './support/commands.js';
import { makeConnection, statefulConnection } from './support/connection.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until, waitForState } from './support/wait.js';

chai.use(chaiAsPromised);

describe('CommandDispatcher failures', () => {
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

  it('rejects with retryable deadline_exceeded when the reply is late, and ignores the late reply', async () => {
    server.ackFault = { kind: 'delay', ms: 300 };
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('ping', null, { timeoutMs: 100 }));

    expect(error.toWire()).to.deep.equal({ code: 'deadline_exceeded', message: 'no reply before the timeout', retryable: true });
    await sleep(300);
  });

  it('rejects with deadline_exceeded when the ack never comes', async () => {
    server.ackFault = { kind: 'drop' };
    const { commands } = await onlineDispatcher(server);

    const error = await rejectionOf(commands.execute('ping', null, { timeoutMs: 100 }));

    expect(error.code).to.equal('deadline_exceeded');
  });

  it("rejects a 'wait' command that stays offline until its timeout with retryable unavailable", async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 1000);

    const error = await rejectionOf(commands.execute('ping', null, { whenOffline: 'wait', timeoutMs: 100 }));

    expect(error.toWire()).to.deep.equal({ code: 'unavailable', message: 'the client stayed offline until the timeout', retryable: true });
  });

  it('rejects at once with cancelled when the signal is already aborted', async () => {
    const { commands } = await onlineDispatcher(server);
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(commands.execute('ping', null, { signal: controller.signal }));

    expect(error.toWire()).to.deep.equal({ code: 'cancelled', message: 'the command was cancelled', retryable: false });
    await sleep(30);
    expect(server.requests).to.have.length(0);
  });

  it('cancels a waiting command so it is never sent', async () => {
    const connection = makeConnection(server);
    const commands = new CommandDispatcher(connection, 2000);
    const controller = new AbortController();
    const pending = rejectionOf(commands.execute('ping', null, { whenOffline: 'wait', signal: controller.signal }));

    controller.abort();
    expect((await pending).code).to.equal('cancelled');
    connection.connect();
    await waitForState(statefulConnection(connection), 'online');
    await sleep(50);

    expect(server.requests).to.have.length(0);
  });

  it('cancels a command in flight and tells the server', async () => {
    server.ackFault = { kind: 'drop' };
    const { commands } = await onlineDispatcher(server, 2000);
    const controller = new AbortController();
    const pending = rejectionOf(commands.execute('ping', null, { signal: controller.signal }));
    await until(() => server.requests.length === 1);

    controller.abort();

    expect((await pending).code).to.equal('cancelled');
    await until(() => server.cancels.length === 1);
    expect(server.cancels).to.deep.equal([server.requests[0].id]);
  });

  it('rejects with retryable unavailable on a drop mid-command and never re-sends it', async () => {
    server.ackFault = { kind: 'drop' };
    const { connection, commands } = await onlineDispatcher(server, 2000);
    const target = statefulConnection(connection);
    const lost = rejectionOf(commands.execute('ping', null));
    await until(() => server.requests.length === 1);

    server.killConnections();

    expect((await lost).toWire()).to.deep.equal({ code: 'unavailable', message: 'the connection dropped before the reply', retryable: true });
    server.ackFault = { kind: 'none' };
    await waitForState(target, 'online');
    await expect(commands.execute('ping', null)).to.eventually.equal('pong');
    expect(server.requests.map((request) => request.name)).to.deep.equal(['ping', 'ping']);
  });

  it('close() rejects waiting and in-flight commands, and every later one, as closed', async () => {
    server.ackFault = { kind: 'drop' };
    const { connection, commands } = await onlineDispatcher(server, 2000);
    const inFlight = rejectionOf(commands.execute('ping', null));
    await until(() => server.requests.length === 1);
    connection.disconnect();
    const waiting = rejectionOf(commands.execute('ping', null, { whenOffline: 'wait' }));

    connection.close();

    const closed = { code: 'unavailable', message: 'the client is closed', retryable: false };
    expect((await waiting).toWire()).to.deep.equal(closed);
    expect((await inFlight).code).to.equal('unavailable');
    expect((await rejectionOf(commands.execute('ping', null))).toWire()).to.deep.equal(closed);
  });
});
