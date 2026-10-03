import 'mocha';
import { expect } from 'chai';
import { closeAll } from './support/cleanup.js';
import { makeClient, statefulClient } from './support/client.js';
import { serveStream } from './support/stream-stub.js';
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
});
