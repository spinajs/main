import 'mocha';
import { expect } from 'chai';
import { defineContract, type SocketError } from '@spinajs/http-socket-common';
import { LIFECYCLE_EVENTS } from '../src/client.js';
import type { AckedCommand, FailedCommand, HeldCommand } from '../src/durable.js';
import { MemoryOutboxStore } from '../src/outbox.js';
import { closeAll } from './support/cleanup.js';
import { makeClient } from './support/client.js';
import { rejectionOf } from './support/commands.js';
import { serveDurable } from './support/durable.js';
import { StubServer } from './support/stub-server.js';
import { sleep, until } from './support/wait.js';

type DurableContract = {
  commands: { 'docs.submit': [{ n: number }, { seq: number }] };
  events: Record<string, never>;
};

describe('SocketClient durable commands', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
  });

  it('runs durable commands through a MemoryOutboxStore by default', async () => {
    const stub = serveDurable(server, 'docs.submit', (payload: { n: number }) => ({ seq: payload.n * 10 }));
    const client = makeClient(server);

    expect(await client.durable('docs.submit', { n: 1 })).to.deep.equal({ seq: 10 });
    const key = server.requests[0].idempotencyKey as string;
    expect(key).to.match(/^client-1:./).and.to.have.length.greaterThan('client-1:'.length);
    expect(stub.runs.get(key)).to.equal(1);
  });

  it('resumes the given outbox and reports resumed commands through acked', async () => {
    serveDurable(server, 'docs.submit');
    const outbox = new MemoryOutboxStore();
    await outbox.add({ name: 'docs.submit', payload: { n: 7 } });
    const acked: AckedCommand[] = [];

    const client = makeClient(server, { outbox, autoConnect: false });
    client.on('acked', (event) => acked.push(event));
    client.connect();
    await until(() => acked.length === 1);

    expect(acked[0].entry.seq).to.equal(1);
    expect(acked[0].result).to.deep.equal({ n: 7 });
  });

  it('emits failed with the stored entry for a command refused for good', async () => {
    serveDurable(server, 'docs.submit', () => {
      throw { code: 'invalid_argument', message: 'malformed op', retryable: false } as SocketError;
    });
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });
    const failed: FailedCommand[] = [];
    client.on('failed', (event) => failed.push(event));

    const error = await rejectionOf(client.durable('docs.submit', { n: 1 }));

    expect(error.code).to.equal('invalid_argument');
    expect(failed).to.have.length(1);
    expect(failed[0].entry).to.include({ seq: 1, name: 'docs.submit' });
    expect((await outbox.failed()).map((e) => e.error.code)).to.deep.equal(['invalid_argument']);
  });

  it('takes the window and an app key', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'delay', ms: 150 };
    const client = makeClient(server, { durable: { window: 1 } });

    const both = Promise.all([client.durable('docs.submit', { n: 1 }, { key: 'op-1' }), client.durable('docs.submit', { n: 2 })]);
    await until(() => server.requests.length === 1);
    await sleep(50);
    expect(server.requests).to.have.length(1);
    await both;

    const keys = server.requests.map((r) => r.idempotencyKey as string);
    expect(keys[0]).to.equal('op-1');
    expect(keys[1]).to.match(/^client-1:./).and.to.have.length.greaterThan('client-1:'.length);
  });

  it('rejects waiting durable commands with unavailable on close, keeping them in the outbox', async () => {
    serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });

    const done = client.durable('docs.submit', { n: 1 });
    await until(() => server.requests.length === 1);
    client.close();

    expect((await rejectionOf(done)).code).to.equal('unavailable');
    expect(await outbox.pending()).to.have.length(1);
  });

  it('emits held when the credentials ran out, keeping the command queued', async () => {
    serveDurable(server, 'docs.submit', undefined, { refuse: () => ({ code: 'unauthenticated', message: 'credentials expired', retryable: false }) });
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });
    const held: HeldCommand[] = [];
    client.on('held', (event) => held.push(event));

    void client.durable('docs.submit', { n: 1 }).catch(() => undefined);
    await until(() => held.length === 1);

    expect(held[0].error.code).to.equal('unauthenticated');
    expect(await outbox.pending()).to.have.length(1);
  });

  it('emits held once however many commands the refusal reaches', async () => {
    serveDurable(server, 'docs.submit', undefined, { refuse: () => ({ code: 'unauthenticated', message: 'credentials expired', retryable: false }) });
    const client = makeClient(server);
    const held: HeldCommand[] = [];
    client.on('held', (event) => held.push(event));

    for (let n = 1; n <= 4; n++) void client.durable('docs.submit', { n }).catch(() => undefined);
    await until(() => server.requests.length >= 4);
    await sleep(150);

    expect(held).to.have.length(1);
  });

  it('sends a command queued before connect() once connected', async () => {
    serveDurable(server, 'docs.submit', (payload: { n: number }) => ({ seq: payload.n }));
    const client = makeClient(server, { autoConnect: false });

    const done = client.durable('docs.submit', { n: 3 });
    await sleep(50);
    expect(server.requests).to.have.length(0);
    client.connect();

    expect(await done).to.deep.equal({ seq: 3 });
  });

  it('keeps the entry queued across disconnect() and flushes it on connect()', async () => {
    serveDurable(server, 'docs.submit');
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox, autoConnect: false });
    client.disconnect();

    const done = client.durable('docs.submit', { n: 1 });
    await sleep(50);
    expect(server.requests).to.have.length(0);
    expect(await outbox.pending()).to.have.length(1);
    client.connect();

    expect(await done).to.deep.equal({ n: 1 });
    expect(await outbox.pending()).to.have.length(0);
  });

  it('rejects durable() after close() without writing to the store', async () => {
    const outbox = new MemoryOutboxStore();
    const client = makeClient(server, { outbox });
    client.close();

    expect((await rejectionOf(client.durable('docs.submit', { n: 1 }))).code).to.equal('unavailable');
    expect(await outbox.pending()).to.have.length(0);
  });

  it('rejects an app key that starts with the clientId prefix', async () => {
    const client = makeClient(server, { clientId: 'client-1' });

    const error = await client.durable('docs.submit', {}, { key: 'client-1:7' }).then(() => undefined, (e: unknown) => e);

    expect(error).to.be.instanceOf(RangeError);
  });

  it('requires a clientId when an outbox is given', () => {
    expect(() => makeClient(server, { outbox: new MemoryOutboxStore(), clientId: undefined })).to.throw(RangeError, /clientId/);
  });

  it('resumes a persisted outbox in a recreated client with the same clientId, acking once', async () => {
    const stub = serveDurable(server, 'docs.submit');
    server.ackFault = { kind: 'drop' };
    const outbox = new MemoryOutboxStore();
    const first = makeClient(server, { outbox, clientId: 'reload-1' });
    void first.durable('docs.submit', { n: 1 }).catch(() => undefined);
    await until(() => server.requests.length === 1);
    first.close();
    const key = server.requests[0].idempotencyKey as string;

    server.ackFault = { kind: 'none' };
    const acked: AckedCommand[] = [];
    const second = makeClient(server, { outbox, clientId: 'reload-1', autoConnect: false });
    second.on('acked', (event) => acked.push(event));
    second.connect();
    await until(() => acked.length === 1);
    await sleep(100);

    expect(acked).to.have.length(1);
    expect(stub.runs.get(key)).to.equal(1);
    expect(await outbox.pending()).to.have.length(0);
  });

  it('lists acked and held among the lifecycle events', () => {
    expect([...LIFECYCLE_EVENTS]).to.include.members(['acked', 'failed', 'held']);
  });
});

// Compile-time only: `npm run typecheck` checks the typed durable() signature.
function durableTypeChecks(server: StubServer): void {
  const typed = makeClient(server).typed(defineContract<DurableContract>());
  const result: Promise<{ seq: number }> = typed.durable('docs.submit', { n: 1 }, { key: 'op-1' });
  // @ts-expect-error the payload is checked against the contract
  void typed.durable('docs.submit', { n: 'one' });
  void result;
}
void durableTypeChecks;
