import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Unauthenticated } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';
import { Command, Payload, Signal, SocketController, SocketPolicy } from '../src/decorators.js';
import type { ISocketPolicyRequest } from '../src/policies.js';
import { ELSEWHERE_RETRY_AFTER_MS, IdempotencyRecord, IdempotencyStore, MemoryIdempotencyStore, SocketIdempotency } from '../src/idempotency.js';
import type { IdempotentReply } from '../src/interfaces.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer, waitFor } from './harness.js';

export const idemRuns = new Map<string, number>();
let idemGate: { promise: Promise<void>; open: () => void };

function newIdemGate(): void {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  idemGate = { promise, open };
}

function run(tag: string): number {
  const n = (idemRuns.get(tag) ?? 0) + 1;
  idemRuns.set(tag, n);
  return n;
}

export const idemLogin = { checks: 0 };

/** Sent as its toJSON form, as socket.io encodes it. */
export class IdemMoney {
  constructor(public cents: number) {}

  public toJSON() {
    return { amount: (this.cents / 100).toFixed(2) };
  }
}

/** Refuses an anonymous principal as `@SocketAccess` does, without an AuthzService to ask. */
export class IdemNeedsLogin extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: unknown): Promise<void> {
    idemLogin.checks++;
    if (!(req as ISocketPolicyRequest).storage.Principal.authenticated) {
      throw new Unauthenticated('log in first');
    }
  }
}

@SocketController('idem')
export class IdempotencySocket extends BaseSocketController {
  @Command('count', { idempotent: true })
  public async count(@Payload() p: { tag: string; ms?: number }) {
    const n = run(p.tag);
    if (p.ms) {
      await delay(p.ms);
    }
    return { tag: p.tag, run: n };
  }

  @Command('fail', { idempotent: true })
  public async fail(@Payload() p: { tag: string; code: 'conflict' | 'unavailable' | 'boom' }) {
    run(p.tag);
    if (p.code === 'boom') {
      throw new Error('handler exploded');
    }
    throw new SocketException(p.code, `failed with ${p.code}`);
  }

  @Command('hold', { idempotent: true })
  public async hold(@Payload() p: { tag: string }) {
    const n = run(p.tag);
    await idemGate.promise;
    return { tag: p.tag, run: n };
  }

  @Command('unstorable', { idempotent: true })
  public async unstorable(@Payload() p: { tag: string }) {
    run(p.tag);
    return { tag: p.tag, cannotClone: () => undefined };
  }

  @Command('money', { idempotent: true })
  public async money(@Payload() p: { tag: string }) {
    run(p.tag);
    return { tag: p.tag, price: new IdemMoney(500) };
  }

  @Command('failPriced', { idempotent: true })
  public async failPriced(@Payload() p: { tag: string }) {
    run(p.tag);
    throw new SocketException('conflict', 'price changed', { details: { price: new IdemMoney(500) } });
  }

  @Command('bytes', { idempotent: true })
  public async bytes(@Payload() p: { tag: string }) {
    run(p.tag);
    return { tag: p.tag, data: Buffer.from([1, 2, 3]) };
  }

  @Command('bigint', { idempotent: true })
  public async bigint(@Payload() p: { tag: string }) {
    run(p.tag);
    return { tag: p.tag, n: BigInt(1) };
  }

  @Command('abortable', { idempotent: true })
  public async abortable(@Payload() p: { tag: string; cause?: boolean }, @Signal() signal: AbortSignal) {
    const n = run(p.tag);
    if (n > 1) {
      return { tag: p.tag, run: n };
    }
    // a library that wraps the abort reason instead of rethrowing it
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(p.cause ? new Error('the request was aborted', { cause: signal.reason }) : new DOMException('This operation was aborted', 'AbortError')), { once: true });
    });
  }

  @Command('orderedFail', { idempotent: true, ordered: 'client' })
  public async orderedFail(@Payload() p: { tag: string }) {
    run(p.tag);
    throw new SocketException('unavailable', 'try again');
  }

  @Command('guarded', { idempotent: true })
  @SocketPolicy(IdemNeedsLogin)
  public async guarded(@Payload() p: { tag: string }) {
    return { tag: p.tag, run: run(p.tag) };
  }

  @Command('plain')
  public async plain() {
    return 'plain';
  }
}

/** Counts claims, so a test can see that the configured store class is the one in use. */
@Injectable(IdempotencyStore)
export class IdemCountingStore extends MemoryIdempotencyStore {
  public static claims = 0;

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    IdemCountingStore.claims++;
    return super.claim(key);
  }
}

/** Fails the store writes a test switches on. */
@Injectable(IdempotencyStore)
export class IdemFailingStore extends MemoryIdempotencyStore {
  public static failComplete = false;
  public static failRelease = false;

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    if (IdemFailingStore.failComplete) {
      throw new Error('store unreachable');
    }
    return super.complete(key, reply, ttlMs);
  }

  public async release(key: string): Promise<void> {
    if (IdemFailingStore.failRelease) {
      throw new Error('store unreachable');
    }
    return super.release(key);
  }
}

describe('socket idempotent commands', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connect = async (clientId: string, token?: string) => {
    const socket = await open(t, { auth: { clientId, ...(token ? { token } : {}) } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    idemRuns.clear();
    newIdemGate();
    t = await startServer();
  });

  afterEach(async () => {
    idemGate.open();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('replays the stored reply of a finished key without running the handler again', async () => {
    const s = await connect('idem-replay');
    const first = resultOf(await command(s, 'idem.count', { tag: 'r' }, { idempotencyKey: 'k1' }));
    const second = resultOf(await command(s, 'idem.count', { tag: 'r' }, { idempotencyKey: 'k1' }));

    expect(first).to.deep.equal({ tag: 'r', run: 1 });
    expect(second).to.deep.equal(first);
    expect(idemRuns.get('r')).to.equal(1);
  });

  it('runs the handler once for concurrent requests with one key', async () => {
    const s = await connect('idem-concurrent');
    const replies = await Promise.all([1, 2, 3].map(() => command(s, 'idem.count', { tag: 'c', ms: 100 }, { idempotencyKey: 'k1' })));

    expect(replies.map((r) => resultOf(r))).to.deep.equal([1, 2, 3].map(() => ({ tag: 'c', run: 1 })));
    expect(idemRuns.get('c')).to.equal(1);
  });

  it('runs commands without a key every time', async () => {
    const s = await connect('idem-keyless');
    await command(s, 'idem.count', { tag: 'n' });
    await command(s, 'idem.count', { tag: 'n' });

    expect(idemRuns.get('n')).to.equal(2);
  });

  it('keeps keys apart by principal and by clientId', async () => {
    const alice = await connect('idem-scope', 'good');
    const anonymous = await connect('idem-scope');
    const aliceElsewhere = await connect('idem-scope-2', 'good');

    for (const s of [alice, anonymous, aliceElsewhere]) {
      await command(s, 'idem.count', { tag: 's' }, { idempotencyKey: 'same' });
    }

    expect(idemRuns.get('s')).to.equal(3);
  });

  it('stores a final error and replays it with the same errorId', async () => {
    const s = await connect('idem-final');
    const first = errorOf(await command(s, 'idem.fail', { tag: 'f', code: 'boom' }, { idempotencyKey: 'k1' }));
    const second = errorOf(await command(s, 'idem.fail', { tag: 'f', code: 'boom' }, { idempotencyKey: 'k1' }));
    const conflict = errorOf(await command(s, 'idem.fail', { tag: 'g', code: 'conflict' }, { idempotencyKey: 'k2' }));
    const conflictAgain = errorOf(await command(s, 'idem.fail', { tag: 'g', code: 'conflict' }, { idempotencyKey: 'k2' }));

    expect(first.code).to.equal('internal');
    expect(first.errorId).to.be.a('string');
    expect(second).to.deep.equal(first);
    expect(conflictAgain).to.deep.equal(conflict);
    expect(idemRuns.get('f')).to.equal(1);
    expect(idemRuns.get('g')).to.equal(1);
  });

  it('releases the key after a retryable failure, so a resend runs again', async () => {
    const s = await connect('idem-retry');
    const first = errorOf(await command(s, 'idem.fail', { tag: 'u', code: 'unavailable' }, { idempotencyKey: 'k1' }));
    await command(s, 'idem.fail', { tag: 'u', code: 'unavailable' }, { idempotencyKey: 'k1' });

    expect(first.retryable).to.be.true;
    expect(idemRuns.get('u')).to.equal(2);
  });

  it('releases an unauthenticated refusal, so the same key is checked again rather than replayed', async () => {
    idemLogin.checks = 0;
    const s = await connect('idem-anon');

    for (let i = 0; i < 2; i++) {
      expect(errorOf(await command(s, 'idem.guarded', { tag: 'l' }, { idempotencyKey: 'k1' })).code).to.equal('unauthenticated');
    }

    expect(idemLogin.checks).to.equal(2);
    expect(idemRuns.has('l')).to.be.false;
  });

  it('runs a key refused as unauthenticated once the same clientId comes back logged in', async () => {
    const anonymous = await connect('idem-login');
    expect(errorOf(await command(anonymous, 'idem.guarded', { tag: 'li' }, { idempotencyKey: 'k1' })).code).to.equal('unauthenticated');
    anonymous.close();

    const alice = await connect('idem-login', 'good');
    expect(resultOf(await command(alice, 'idem.guarded', { tag: 'li' }, { idempotencyKey: 'k1' }))).to.deep.equal({ tag: 'li', run: 1 });
  });

  it('refuses a key on a command that is not idempotent', async () => {
    const s = await connect('idem-plain');
    const error = errorOf(await command(s, 'idem.plain', undefined, { idempotencyKey: 'k1' }));

    expect(error.code).to.equal('failed_precondition');
    expect(error.retryable).to.be.false;
  });

  it('refuses after without an idempotencyKey', async () => {
    const s = await connect('idem-after');
    expect(errorOf(await command(s, 'idem.count', { tag: 'a' }, { after: 'k0' })).code).to.equal('invalid_argument');
    expect(idemRuns.has('a')).to.be.false;
  });

  it('keeps a key running after its connection dropped; the resend joins it and gets its result', async () => {
    const first = await connect('idem-drop');
    void command(first, 'idem.hold', { tag: 'h' }, { idempotencyKey: 'k1' }).catch(() => undefined);
    await waitFor(() => idemRuns.get('h') === 1);
    first.close();
    await delay(100);

    const second = await connect('idem-drop');
    const resent = command(second, 'idem.hold', { tag: 'h' }, { idempotencyKey: 'k1' });
    await delay(100);
    idemGate.open();

    expect(resultOf(await resent)).to.deep.equal({ tag: 'h', run: 1 });
    expect(idemRuns.get('h')).to.equal(1);
  });

  it('replays the reply as it was sent: a toJSON class gives the same payload live and replayed', async () => {
    const s = await connect('idem-tojson');
    const live = resultOf(await command(s, 'idem.money', { tag: 'm' }, { idempotencyKey: 'k1' }));
    const replayed = resultOf(await command(s, 'idem.money', { tag: 'm' }, { idempotencyKey: 'k1' }));

    expect(live).to.deep.equal({ tag: 'm', price: { amount: '5.00' } });
    expect(replayed).to.deep.equal(live);
    expect(idemRuns.get('m')).to.equal(1);
  });

  it('drops a function property as the wire does, instead of failing the call', async () => {
    const s = await connect('idem-function');
    const live = await command(s, 'idem.unstorable', { tag: 'x' }, { idempotencyKey: 'k1' });
    const replayed = await command(s, 'idem.unstorable', { tag: 'x' }, { idempotencyKey: 'k1' });

    expect(resultOf(live)).to.deep.equal({ tag: 'x' });
    expect(resultOf(replayed)).to.deep.equal({ tag: 'x' });
    expect(idemRuns.get('x')).to.equal(1);
  });

  it('replays error details as they were sent', async () => {
    const s = await connect('idem-details');
    const live = errorOf(await command(s, 'idem.failPriced', { tag: 'pd' }, { idempotencyKey: 'k1' }));
    const replayed = errorOf(await command(s, 'idem.failPriced', { tag: 'pd' }, { idempotencyKey: 'k1' }));

    expect(live.details).to.deep.equal({ price: { amount: '5.00' } });
    expect(replayed).to.deep.equal(live);
    expect(idemRuns.get('pd')).to.equal(1);
  });

  it('keeps binary data binary in the replay', async () => {
    const s = await connect('idem-bytes');
    const live = resultOf(await command<{ data: Uint8Array }>(s, 'idem.bytes', { tag: 'b' }, { idempotencyKey: 'k1' }));
    const replayed = resultOf(await command<{ data: Uint8Array }>(s, 'idem.bytes', { tag: 'b' }, { idempotencyKey: 'k1' }));

    expect([...new Uint8Array(live.data)]).to.deep.equal([1, 2, 3]);
    expect([...new Uint8Array(replayed.data)]).to.deep.equal([1, 2, 3]);
    expect(idemRuns.get('b')).to.equal(1);
  });

  it('answers internal for a result that cannot be encoded and releases its key, so a resend is not refused for good', async () => {
    const s = await connect('idem-unencodable');
    const first = errorOf(await command(s, 'idem.bigint', { tag: 'z' }, { idempotencyKey: 'k1' }));
    const resent = errorOf(await command(s, 'idem.bigint', { tag: 'z' }, { idempotencyKey: 'k1' }));

    expect(first.code).to.equal('internal');
    expect(resent.code).to.equal('internal');
    expect(idemRuns.get('z')).to.equal(2);
  });

  for (const cause of [false, true]) {
    it(`releases the key of a handler that rejects with ${cause ? 'an error caused by the abort reason' : 'an AbortError'} after a disconnect`, async () => {
      const first = await connect(`idem-abort-${cause}`);
      void command(first, 'idem.abortable', { tag: `ab-${cause}`, cause }, { idempotencyKey: 'k1' }).catch(() => undefined);
      await waitFor(() => idemRuns.get(`ab-${cause}`) === 1);
      first.close();
      await delay(100);

      const second = await connect(`idem-abort-${cause}`);
      expect(resultOf(await command(second, 'idem.abortable', { tag: `ab-${cause}`, cause }, { idempotencyKey: 'k1' }))).to.deep.equal({ tag: `ab-${cause}`, run: 2 });
    });
  }

  describe('with a failing store', () => {
    beforeEach(async () => {
      await t.close();
      t = await startServer({ http: { socket: { idempotency: { service: 'IdemFailingStore' } } } });
    });

    afterEach(() => {
      IdemFailingStore.failComplete = false;
      IdemFailingStore.failRelease = false;
    });

    it('answers the result to the caller and its joiners when the store cannot keep it, and releases the key', async () => {
      IdemFailingStore.failComplete = true;
      const s = await connect('idem-store-down');
      const replies = await Promise.all([1, 2, 3].map(() => command(s, 'idem.count', { tag: 'd', ms: 100 }, { idempotencyKey: 'k1' })));

      expect(replies.map((r) => resultOf(r))).to.deep.equal([1, 2, 3].map(() => ({ tag: 'd', run: 1 })));
      expect(idemRuns.get('d')).to.equal(1);

      // nothing was kept, so a later resend runs again
      IdemFailingStore.failComplete = false;
      expect(resultOf(await command(s, 'idem.count', { tag: 'd' }, { idempotencyKey: 'k1' }))).to.deep.equal({ tag: 'd', run: 2 });
    });

    it('answers the final error to the caller when the store cannot keep it', async () => {
      IdemFailingStore.failComplete = true;
      const s = await connect('idem-store-down-error');

      expect(errorOf(await command(s, 'idem.fail', { tag: 'de', code: 'conflict' }, { idempotencyKey: 'k1' })).code).to.equal('conflict');
    });

    for (const name of ['idem.fail', 'idem.orderedFail']) {
      it(`answers the handler's own error, not the store's, when ${name} cannot release its key`, async () => {
        IdemFailingStore.failRelease = true;
        const s = await connect(`idem-release-down-${name}`);

        expect(errorOf(await command(s, name, { tag: `rd-${name}`, code: 'unavailable' }, { idempotencyKey: 'k1' })).code).to.equal('unavailable');
      });
    }
  });

  it('uses the store class named in http.socket.idempotency.service', async () => {
    await t.close();
    t = await startServer({ http: { socket: { idempotency: { service: 'IdemCountingStore' } } } });
    IdemCountingStore.claims = 0;
    const s = await connect('idem-store');

    await command(s, 'idem.count', { tag: 'st' }, { idempotencyKey: 'k1' });

    expect(IdemCountingStore.claims).to.equal(1);
  });
});

/** Runs `onRelease` inside `release`, after the key is free but before the releasing claim cleans up. */
export class IdemReleaseHookStore extends MemoryIdempotencyStore {
  public onRelease: (() => void) | null = null;

  public async release(key: string): Promise<void> {
    await super.release(key);
    const hook = this.onRelease;
    this.onRelease = null;
    hook?.();
  }
}

describe('SocketIdempotency', () => {
  let logged: unknown[][];

  // the decorated properties are getters, so the collaborators are defined over them
  const idempotency = (store: IdempotencyStore) =>
    Object.defineProperties(new SocketIdempotency(), {
      Store: { value: store },
      Options: { value: { service: 'IdemReleaseHookStore', ttlMs: 60_000, maxEntries: 10 } },
      Errors: { value: { toWire: (err: unknown) => (err instanceof SocketException ? err : new SocketException('internal', String(err), { retryable: false })).toWire() } },
      Log: { value: { error: (...args: unknown[]) => void logged.push(args) } },
    });

  type Claim = { claim: { settle(o: unknown): Promise<unknown> } };
  const live = () => new AbortController().signal;

  beforeEach(() => (logged = []));

  it('keeps a newer claim joinable when an older claim of the key cleans up after it', async () => {
    const store = new IdemReleaseHookStore();
    const idem = idempotency(store);
    const signal = live();

    const first = await idem.begin('k', 'idem.race', signal);
    let second: ReturnType<typeof idem.begin> | undefined;
    store.onRelease = () => (second = idem.begin('k', 'idem.race', signal));

    await (first as Claim).claim.settle({ error: new SocketException('unavailable', 'try again') });
    const claim = ((await second!) as Claim).claim;

    const joined = idem.begin('k', 'idem.race', signal);
    await claim.settle({ result: 'second' });

    expect(await joined).to.deep.equal({ reply: { ok: true, result: 'second' } });
  });

  it('answers a retryable unavailable when another instance runs the key', async () => {
    const store = new IdemClaimCountingStore();
    const idem = idempotency(store);
    await store.claim('k');

    const error = await idem.begin('k', 'idem.elsewhere', live()).then(
      () => null,
      (err: SocketException) => err,
    );

    expect(error).to.include({ code: 'unavailable', retryable: true, retryAfterMs: ELSEWHERE_RETRY_AFTER_MS });
    // the second look rules out a local run that finished while the store answered
    expect(store.claims).to.equal(3);
  });

  it('claims again a key released by its local run while the store still reported it running', async () => {
    const store = new IdemStaleClaimStore();
    const idem = idempotency(store);
    const first = (await idem.begin('k', 'idem.stale', live())) as Claim;

    store.beforeAnswer = () => first.claim.settle({ error: new SocketException('unavailable', 'try again') });
    const second = await idem.begin('k', 'idem.stale', live());

    expect(second).to.have.property('claim');
  });

  it('lets a joiner give up at its own abort while the run goes on', async () => {
    const idem = idempotency(new MemoryIdempotencyStore());
    const owner = (await idem.begin('k', 'idem.join', live())) as Claim;
    const controller = new AbortController();
    const joiner = idem.begin('k', 'idem.join', controller.signal);

    const reason = new SocketException('cancelled', 'gave up');
    controller.abort(reason);
    await expect(joiner).to.be.rejectedWith(reason);

    await owner.claim.settle({ result: 'done' });
    expect(await idem.begin('k', 'idem.join', live())).to.deep.equal({ reply: { ok: true, result: 'done' } });
  });

  it('publishes the reply to joiners when the store cannot keep it, logs it and releases the key', async () => {
    const store = new IdemBrokenCompleteStore();
    const idem = idempotency(store);
    const owner = (await idem.begin('k', 'idem.broken', live())) as Claim;
    const joiner = idem.begin('k', 'idem.broken', live());

    expect(await owner.claim.settle({ result: 'r' })).to.deep.equal({ ok: true, result: 'r' });
    expect(await joiner).to.deep.equal({ reply: { ok: true, result: 'r' } });
    expect(await store.get('k')).to.equal(null);
    expect(logged).to.have.length(1);
  });

  it('releases a stream result, so a joiner claims the key again', async () => {
    const idem = idempotency(new MemoryIdempotencyStore());
    const owner = (await idem.begin('k', 'idem.stream', live())) as Claim;
    const joiner = idem.begin('k', 'idem.stream', live());

    async function* stream() {
      yield 1;
    }

    expect(await owner.claim.settle({ result: stream() })).to.equal(null);
    expect(await joiner).to.have.property('claim');
  });

  async function* aStream() {
    yield 1;
  }

  const releasing: Array<[string, (signal: AbortController) => unknown]> = [
    ['a retryable error', () => ({ error: new SocketException('unavailable', 'try again') })],
    ['the call abort', (c) => (c.abort(new SocketException('cancelled', 'gave up')), { error: c.signal.reason })],
    ['a stream result', () => ({ result: aStream() })],
  ];

  for (const [what, outcome] of releasing) {
    it(`answers no outcome for ${what} and logs it when the store cannot release the key`, async () => {
      const idem = idempotency(new IdemBrokenReleaseStore());
      const controller = new AbortController();
      const owner = (await idem.begin('k', 'idem.norelease', controller.signal)) as Claim;

      expect(await owner.claim.settle(outcome(controller))).to.equal(null);
      expect(logged).to.have.length(1);
    });
  }

  it('answers undefined, as the wire does, for a result JSON cannot represent', async () => {
    const idem = idempotency(new MemoryIdempotencyStore());
    const owner = (await idem.begin('k', 'idem.undefined', live())) as Claim;

    expect(await owner.claim.settle({ result: undefined })).to.deep.equal({ ok: true, result: undefined });
  });

  it('releases the key of a run that failed with an error caused by its abort', async () => {
    const store = new MemoryIdempotencyStore();
    const idem = idempotency(store);
    const controller = new AbortController();
    const owner = (await idem.begin('k', 'idem.cause', controller.signal)) as Claim;

    controller.abort(new SocketException('unavailable', 'connection closed'));

    expect(await owner.claim.settle({ error: new Error('wrapped', { cause: controller.signal.reason }) })).to.equal(null);
    expect(await store.get('k')).to.equal(null);
  });
});

export class IdemClaimCountingStore extends MemoryIdempotencyStore {
  public claims = 0;

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    this.claims++;
    return super.claim(key);
  }
}

/** Answers a claim as it saw it before `beforeAnswer` changed it, as a slow shared store would. */
export class IdemStaleClaimStore extends MemoryIdempotencyStore {
  public beforeAnswer: (() => Promise<unknown>) | null = null;

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const record = await super.claim(key);
    const hook = this.beforeAnswer;
    this.beforeAnswer = null;
    await hook?.();
    return record;
  }
}

export class IdemBrokenReleaseStore extends MemoryIdempotencyStore {
  public async release(): Promise<void> {
    throw new Error('store unreachable');
  }
}

export class IdemBrokenCompleteStore extends MemoryIdempotencyStore {
  public async complete(): Promise<void> {
    throw new Error('store unreachable');
  }
}
