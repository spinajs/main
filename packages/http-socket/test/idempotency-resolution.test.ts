import 'mocha';
import { expect } from 'chai';
import { DI, Injectable } from '@spinajs/di';
import { IdempotencyService, MemoryIdempotencyStore as LeasedMemoryStore } from '@spinajs/idempotency';
import { IdempotencyStore, MemoryIdempotencyStore, SocketIdempotency, assertIdempotencyConfig } from '../src/idempotency.js';
import type { ISocketIdempotencyConfig } from '../src/interfaces.js';
import { ITestServer, startServer } from './harness.js';

@Injectable(IdempotencyStore)
export class ResolutionLegacyStore extends MemoryIdempotencyStore {}

describe('http.socket.idempotency.service', () => {
  let t: ITestServer | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const storeOf = async (): Promise<unknown> => ((await DI.resolve(SocketIdempotency)) as unknown as { Store: unknown }).Store;

  it('names the leased MemoryIdempotencyStore of @spinajs/idempotency by default, built from http.socket.idempotency', async () => {
    t = await startServer({ http: { socket: { idempotency: { maxEntries: 3 } } } });
    const store = await storeOf();

    expect(store).to.be.instanceOf(LeasedMemoryStore);
    expect((store as { maxEntries: number }).maxEntries).to.equal(3);
  });

  it('binds sockets to the store of IdempotencyService (idempotency.store) when service is null', async () => {
    t = await startServer({ idempotency: { store: 'MemoryIdempotencyStore' }, http: { socket: { idempotency: { service: null } } } });
    const store = await storeOf();

    expect(store).to.be.instanceOf(LeasedMemoryStore);
    expect(store).to.equal((await DI.resolve(IdempotencyService)).Store);
  });

  it('still resolves a 3.x store by its class name', async () => {
    t = await startServer({ http: { socket: { idempotency: { service: 'ResolutionLegacyStore' } } } });

    expect(await storeOf()).to.be.instanceOf(ResolutionLegacyStore);
  });

  it('refuses a name that no store is registered under', async () => {
    const started = startServer({ http: { socket: { idempotency: { service: 'NoSuchStore' } } } }).then((server) => (t = server));

    await expect(started.then(() => DI.resolve(SocketIdempotency))).to.be.rejectedWith('no IdempotencyStore is registered under that name');
  });
});

describe('http.socket.idempotency.lease', () => {
  const withLease = (lease: unknown) => () => assertIdempotencyConfig({ service: 'MemoryIdempotencyStore', ttlMs: 1_000, maxEntries: 1, lease } as ISocketIdempotencyConfig);

  for (const lease of ['0s', -1, 'abc', null]) {
    it(`refuses ${JSON.stringify(lease)} with a RangeError`, () => {
      expect(withLease(lease)).to.throw(RangeError, 'http.socket.idempotency.lease');
    });
  }

  it('takes a duration or milliseconds above 0', () => {
    expect(withLease('30s')).to.not.throw();
    expect(withLease(1)).to.not.throw();
  });
});
