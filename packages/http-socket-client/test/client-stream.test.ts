import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { serveStream } from './support/stream-stub.js';
import { rejectionOf } from './support/commands.js';
import { collect } from './support/streams.js';
import { StubServer } from './support/stub-server.js';
import { waitForState } from './support/wait.js';

describe('SocketClient.stream', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('yields the items of a stream reply', async () => {
    serveStream(server, 'n.list', () => [1, 2, 3]);
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    expect(await collect(client.stream<number>('n.list', null, { credits: 2 }))).to.deep.equal([1, 2, 3]);
    expect(server.requests[0].credits).to.equal(2);
  });

  it('takes stream ids from the command id space', async () => {
    serveStream(server, 'n.list', () => [1]);
    server.handlers.set('ping', () => 'pong');
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    await client.command('ping');
    await collect(client.stream('n.list'));
    await client.command('ping');

    expect(new Set(server.requests.map((r) => r.id)).size).to.equal(3);
  });

  it('rejects open streams when the client closes', async () => {
    serveStream(server, 'n.once', async function* () {
      yield 1;
      await new Promise(() => undefined);
    });
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const items = client.stream<number>('n.once');
    await items.next();

    const pending = items.next();
    client.close();

    await pending.then(
      () => expect.fail('expected a rejection'),
      (error: { code: string; retryable: boolean }) => expect(error).to.include({ code: 'unavailable', retryable: false }),
    );
  });

  it('rejects with unavailable on a closed client', async () => {
    const client = makeClient(server, { autoConnect: false });
    client.close();

    expect((await rejectionOf(client.stream('n.list').next())).code).to.equal('unavailable');
  });

  it('rejects with unavailable while offline by default', async () => {
    const client = makeClient(server, { autoConnect: false });

    expect((await rejectionOf(client.stream('n.list').next())).code).to.equal('unavailable');
  });

  it('rejects with cancelled for an aborted signal', async () => {
    serveStream(server, 'n.list', () => [1]);
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');
    const controller = new AbortController();
    controller.abort();

    expect((await rejectionOf(client.stream('n.list', null, { signal: controller.signal }).next())).code).to.equal('cancelled');
  });

  it('rejects stream() against a plain command with failed_precondition', async () => {
    server.handlers.set('ping', () => 'pong');
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    expect((await rejectionOf(client.stream('ping').next())).code).to.equal('failed_precondition');
  });

  it('rejects command() against a stream with failed_precondition', async () => {
    serveStream(server, 'n.list', () => [1]);
    const client = makeClient(server);
    await waitForState(statefulClient(client), 'online');

    expect((await rejectionOf(client.command('n.list'))).code).to.equal('failed_precondition');
  });
});
