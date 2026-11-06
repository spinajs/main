import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { IdempotencyLeaseLost, MemoryIdempotencyStore as LeasedMemoryStore, OrmIdempotencyStore } from '@spinajs/idempotency';
import type { StoredReply } from '@spinajs/idempotency';
import { FakeClock } from '@spinajs/durable/testing';
import { SocketException } from '@spinajs/http-socket-common';
import { MemoryIdempotencyStore as LegacyMemoryStore, SocketIdempotency, outcomeUnknownAfter } from '../src/idempotency.js';
import { IdempotencyStage } from '../src/stages/idempotency.js';
import type { ISocketCommandContext } from '../src/interfaces.js';
import type { SocketConnection } from '../src/connection.js';

type Claim = { claim: { start(): void; settle(outcome: unknown): Promise<unknown> } };

describe('SocketIdempotency on a leased store', () => {
  let warned: unknown[][];
  let errors: unknown[][];

  // ServiceLease is idempotency.lease: it applies when http.socket.idempotency.lease is not set
  const replica = (store: object, clock: FakeClock, options: Record<string, unknown> = { lease: '30s' }, time: object = clock) =>
    Object.defineProperties(new SocketIdempotency(), {
      Store: { value: store },
      ServiceLease: { value: '10s' },
      Options: { value: { service: 'MemoryIdempotencyStore', ttlMs: 60_000, maxEntries: 10, ...options } },
      Errors: { value: { toWire: (err: unknown) => (err instanceof SocketException ? err : new SocketException('internal', String(err), { retryable: false })).toWire() } },
      Log: { value: { error: (...args: unknown[]) => void errors.push(args), warn: (...args: unknown[]) => void warned.push(args) } },
      Timers: { value: clock },
      Time: { value: time },
    });

  const live = () => new AbortController().signal;
  const refusal = (begun: Promise<unknown>) =>
    begun.then(
      () => null,
      (err: SocketException) => err,
    );

  beforeEach(() => {
    warned = [];
    errors = [];
  });

  it('lets another replica take over a key left claimed by a shutdown abort once its lease ends', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const first = replica(store, clock);
    const second = replica(store, clock);

    const controller = new AbortController();
    const owner = (await first.begin('k', 'idem.commit', controller.signal)) as Claim;
    owner.claim.start();
    controller.abort(outcomeUnknownAfter(new SocketException('unavailable', 'shutting down')));

    expect(await owner.claim.settle({ error: controller.signal.reason })).to.equal(null);
    expect(warned).to.have.length(1);
    // the retry hint is the rest of the lease, not a constant
    expect(await refusal(second.begin('k', 'idem.commit', live()))).to.include({ code: 'unavailable', retryable: true, retryAfterMs: 30_000 });

    await clock.advance(30_001);
    expect(await second.begin('k', 'idem.commit', live())).to.have.property('claim');
  });

  it('takes idempotency.lease when http.socket.idempotency.lease is not set', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const first = replica(store, clock, {});
    const second = replica(store, clock, {});

    const controller = new AbortController();
    const owner = (await first.begin('k', 'idem.commit', controller.signal)) as Claim;
    owner.claim.start();
    controller.abort(outcomeUnknownAfter(new SocketException('unavailable', 'shutting down')));
    await owner.claim.settle({ error: controller.signal.reason });

    await clock.advance(10_000);
    expect(await refusal(second.begin('k', 'idem.commit', live()))).to.include({ code: 'unavailable', retryAfterMs: 1 });
    await clock.advance(1);
    expect(await second.begin('k', 'idem.commit', live())).to.have.property('claim');
  });

  it('keeps the key of a handler that runs past its lease by renewing it', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const first = replica(store, clock);
    const second = replica(store, clock);

    const owner = (await first.begin('k', 'idem.slow', live())) as Claim;
    await clock.advance(90_000);
    expect(await refusal(second.begin('k', 'idem.slow', live()))).to.include({ code: 'unavailable' });

    expect(await owner.claim.settle({ result: 'done' })).to.deep.equal({ ok: true, result: 'done' });
    expect(await second.begin('k', 'idem.slow', live())).to.deep.equal({ reply: { ok: true, result: 'done' } });
    expect(await second.completed('k')).to.equal(true);
  });

  it('replays binary parts of a reply as binary although the store keeps it as JSON', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const first = replica(store, clock);

    const owner = (await first.begin('k', 'idem.bytes', live())) as Claim;
    await owner.claim.settle({ result: { data: Buffer.from([1, 2, 3]), nested: [{ samples: new Float32Array([0.5]) }], raw: new Uint8Array([9]).buffer } });

    const { reply } = (await replica(store, clock).begin('k', 'idem.bytes', live())) as { reply: { result: { data: Uint8Array; nested: Array<{ samples: Float32Array }>; raw: ArrayBuffer } } };
    expect(reply.result.data).to.be.instanceOf(Uint8Array);
    expect([...reply.result.data]).to.deep.equal([1, 2, 3]);
    expect(reply.result.nested[0].samples).to.be.instanceOf(Float32Array);
    expect([...reply.result.nested[0].samples]).to.deep.equal([0.5]);
    expect([...new Uint8Array(reply.result.raw)]).to.deep.equal([9]);
  });

  it('scopes a leased key as the idempotency key of namespace socket and principal plus clientId', () => {
    const idem = replica(new LeasedMemoryStore(), new FakeClock());
    const connection = { principal: { type: 'user', id: '7', authenticated: true, source: 'test', attributes: {} }, clientId: 'c-1' } as unknown as SocketConnection;
    const expected = createHash('sha256').update(JSON.stringify(['socket', JSON.stringify(['user:7', 'c-1']), 'k-1'])).digest('hex');

    expect(idem.scope(connection, 'k-1')).to.equal(expected);
  });

  it('never gives two principals one key when a principal id or clientId contains a colon', () => {
    const idem = replica(new LeasedMemoryStore(), new FakeClock());
    const of = (id: string, clientId: string) => ({ principal: { type: 'user', id, authenticated: true, source: 'test', attributes: {} }, clientId }) as unknown as SocketConnection;

    expect(idem.scope(of('7', 'x:y'), 'k')).to.not.equal(idem.scope(of('7:x', 'y'), 'k'));
  });

  const crash = () => Object.assign(new Error('process died'), { crash: true });

  class RefusingStore extends LeasedMemoryStore {
    public async renew(): Promise<boolean> {
      return false;
    }
  }

  it('neither stores nor releases the key of a handler that crashed; another replica takes it over once the lease ends', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const owner = (await replica(store, clock).begin('k', 'idem.crash', live())) as Claim;
    owner.claim.start();
    const died = crash();

    expect(await refusal(owner.claim.settle({ error: died }))).to.equal(died);
    expect(await store.peek('k', clock.now())).to.include({ state: 'running' });
    expect(errors).to.have.length(0);

    const second = replica(store, clock);
    expect(await refusal(second.begin('k', 'idem.crash', live()))).to.include({ code: 'unavailable' });
    await clock.advance(30_001);
    expect(await second.begin('k', 'idem.crash', live())).to.have.property('claim');
  });

  it('rethrows a store crash while keeping the reply, and releases nothing', async () => {
    class CrashingStore extends LeasedMemoryStore {
      public released = 0;
      public async complete(): Promise<boolean> {
        throw crash();
      }
      public async release(key: string, token: string): Promise<void> {
        this.released++;
        await super.release(key, token);
      }
    }
    const store = new CrashingStore();
    const clock = new FakeClock();
    const owner = (await replica(store, clock).begin('k', 'idem.crash', live())) as Claim;

    expect(await refusal(owner.claim.settle({ result: 'done' }))).to.include({ message: 'process died', crash: true });
    expect(store.released).to.equal(0);
    expect(await store.peek('k', clock.now())).to.include({ state: 'running' });
  });

  it('syncs the database clock again after a failed sync', async () => {
    let syncs = 0;
    const orm = Object.assign(Object.create(OrmIdempotencyStore.prototype) as object, { peek: async () => undefined });
    const time = {
      now: () => 0,
      sync: async () => {
        if (++syncs === 1) throw new Error('db down');
        return 0;
      },
    };
    const idem = replica(orm, new FakeClock(), undefined, time);

    expect(await refusal(idem.completed('k'))).to.include({ message: 'db down' });
    expect(await idem.completed('k')).to.equal(false);
    expect(await idem.completed('k')).to.equal(false);
    expect(syncs).to.equal(2);
  });

  it('exposes the lease of a claim, aborted with IdempotencyLeaseLost when a renewal is refused', async () => {
    const clock = new FakeClock();
    const { claim } = (await replica(new RefusingStore(), clock).begin('k', 'idem.slow', live())) as { claim: { lease: AbortSignal } };

    expect(claim.lease.aborted).to.equal(false);
    await clock.advance(15_000);
    expect(claim.lease.reason).to.be.instanceOf(IdempotencyLeaseLost);
  });

  it('aborts the command once its lease is lost, so the handler stops while another instance runs it', async () => {
    const clock = new FakeClock();
    const stage = Object.defineProperties(new IdempotencyStage(), { Idempotency: { value: replica(new RefusingStore(), clock) } });
    const controller = new AbortController();
    const ctx = {
      request: { id: '1', name: 'idem.slow', idempotencyKey: 'k' },
      handler: { descriptor: { Options: { idempotent: true } } },
      connection: { principal: { type: 'user', id: '7' }, clientId: 'c' },
      signal: controller.signal,
      abort: (reason: SocketException) => controller.abort(reason),
      addOutcomeRecorder: () => undefined,
    } as unknown as ISocketCommandContext;

    const handler = new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason as Error)));
    const running = stage.execute(ctx, () => handler).catch((err: unknown) => err);
    await clock.advance(15_000);

    expect(controller.signal.reason).to.be.instanceOf(SocketException).and.include({ code: 'unavailable', retryable: true });
    expect(await running).to.equal(controller.signal.reason);
  });

  it('replays a Date inside a reply that also holds binary as the live reply sent it', async () => {
    const store = new LeasedMemoryStore();
    const clock = new FakeClock();
    const owner = (await replica(store, clock).begin('k', 'idem.bytes', live())) as Claim;

    const sent = (await owner.claim.settle({ result: { at: new Date(0), data: Buffer.from([1]) } })) as { result: { at: unknown } };
    const { reply } = (await replica(store, clock).begin('k', 'idem.bytes', live())) as { reply: { result: { at: unknown; data: Uint8Array } } };

    // socket.io sends a Date through JSON.stringify
    expect(reply.result.at).to.equal(JSON.parse(JSON.stringify(sent.result.at)));
    expect([...reply.result.data]).to.deep.equal([1]);
  });

  const readCorrupt = async (reply: StoredReply) => {
    const store = new LeasedMemoryStore();
    const claim = await store.claim('k', { leaseMs: 1_000, now: 0 });
    await store.complete('k', (claim as { token: string }).token, reply, 60_000, 0);
    return refusal(replica(store, new FakeClock()).begin('k', 'idem.bytes', live()));
  };

  it('answers a stored reply it cannot read with a final failed_precondition and logs it, never internal', async () => {
    const refused = await readCorrupt({ kind: 'socket-binary', body: { reply: { ok: true, result: {} }, attachments: [{ path: ['result', 'a', 'b'], type: 'Uint8Array', base64: 'AQ==' }] } });

    expect(refused).to.include({ code: 'failed_precondition', retryable: false });
    expect(errors).to.have.length(1);
  });

  it('never follows a stored path through __proto__', async () => {
    const refused = await readCorrupt({ kind: 'socket-binary', body: { reply: { ok: true, result: {} }, attachments: [{ path: ['__proto__', 'polluted'], type: 'Uint8Array', base64: 'AQ==' }] } });

    expect(refused).to.include({ code: 'failed_precondition' });
    expect(({} as { polluted?: unknown }).polluted).to.equal(undefined);
  });

  it('keeps the 3.x key format on a 3.x store', () => {
    const idem = replica(new LegacyMemoryStore(), new FakeClock());
    const connection = { principal: { type: 'user', id: '7:x', authenticated: true, source: 'test', attributes: {} }, clientId: 'c/1' } as unknown as SocketConnection;

    expect(idem.scope(connection, 'k 1')).to.equal('user%3A7%3Ax:c%2F1:k%201');
  });
});
