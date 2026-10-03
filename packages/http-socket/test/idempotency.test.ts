import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { Injectable } from '@spinajs/di';
import { SocketException } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Unauthenticated } from '@spinajs/authz';
import { BasePolicy } from '@spinajs/http';
import { Command, Payload, SocketController, SocketPolicy } from '../src/decorators.js';
import type { ISocketPolicyRequest } from '../src/policies.js';
import { IdempotencyRecord, IdempotencyStore, MemoryIdempotencyStore, SocketIdempotency } from '../src/idempotency.js';
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

  it('releases a key whose outcome the store could not keep, so a resend is not refused for good', async () => {
    const s = await connect('idem-unstorable');
    await command(s, 'idem.unstorable', { tag: 'x' }, { idempotencyKey: 'k1' });
    const resent = await command(s, 'idem.unstorable', { tag: 'x' }, { idempotencyKey: 'k1' });

    expect(resent.ok || resent.error.code).to.not.equal('unavailable');
    expect(idemRuns.get('x')).to.equal(2);
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
  // the decorated properties are getters, so the collaborators are defined over them
  const idempotency = (store: IdempotencyStore) =>
    Object.defineProperties(new SocketIdempotency(), {
      Store: { value: store },
      Options: { value: { service: 'IdemReleaseHookStore', ttlMs: 60_000, maxEntries: 10 } },
      Errors: { value: { toWire: (err: SocketException) => err.toWire() } },
      Log: { value: { error: () => undefined } },
    });

  it('keeps a newer claim joinable when an older claim of the key cleans up after it', async () => {
    const store = new IdemReleaseHookStore();
    const idem = idempotency(store);
    const signal = new AbortController().signal;

    const first = await idem.begin('k', 'idem.race', signal);
    let second: ReturnType<typeof idem.begin> | undefined;
    store.onRelease = () => (second = idem.begin('k', 'idem.race', signal));

    await (first as { claim: { settle(o: unknown): Promise<unknown> } }).claim.settle({ error: new SocketException('unavailable', 'try again') });
    const claim = ((await second!) as { claim: { settle(o: unknown): Promise<unknown> } }).claim;

    const joined = idem.begin('k', 'idem.race', signal);
    await claim.settle({ result: 'second' });

    expect(await joined).to.deep.equal({ reply: { ok: true, result: 'second' } });
  });
});
