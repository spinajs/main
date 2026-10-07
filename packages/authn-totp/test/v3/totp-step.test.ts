import 'mocha';
import assert from 'node:assert/strict';
import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { IdentityStore, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef, IdentityStatus } from '@spinajs/authn/contracts';
import { base32Decode, FakeClock, parseOtpauth, totp, totpFromProvisioning } from '@spinajs/authn-testing';
import { mfaKeyFrom } from '@spinajs/authn-orm';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { DbMfaSecretStore } from '../../src/db.js';
import { MemoryMfaSecretStore, MfaSecretStore } from '../../src/store/index.js';
import type { MfaRecord } from '../../src/store/index.js';
import { TotpAlreadyEnrolled, TotpEnrolmentChanged, TotpInvalidCode, TotpNotBegun, TotpMfaStep } from '../../src/step/index.js';
import type { TotpOptions } from '../../src/step/index.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { boot, disposeBooted, readingFrom } from '../support/config-boot.js';
import { TOTP_DEFAULTS, totpOpts } from './support/totp-defaults.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ALICE: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SECOND = 1000;
const START = new Date('2026-10-04T10:00:00Z');

class Identities extends IdentityStore {
  constructor(private readonly shown: { email?: string; name?: string }) {
    super();
  }
  async findByLogin(): Promise<IdentityRef | null> {
    return null;
  }
  async status(): Promise<IdentityStatus> {
    return { exists: true, active: true, banned: false, deleted: false };
  }
  async display(): Promise<{ email?: string; name?: string }> {
    return this.shown;
  }
}

class CountingStore extends MemoryMfaSecretStore {
  calls = 0;
  async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    this.calls++;
    return super.get(id, step);
  }
  async acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    this.calls++;
    return super.acceptStep(id, step, timeStep);
  }
}

/** Runs `hook` once, inside the next call of `method`, before the store does its work. */
class InterleavingStore extends MemoryMfaSecretStore {
  private armed: { method: 'acceptStep' | 'confirm'; hook: () => Promise<unknown> } | null = null;

  arm(method: 'acceptStep' | 'confirm', hook: () => Promise<unknown>): void {
    this.armed = { method, hook };
  }

  private async fire(method: 'acceptStep' | 'confirm'): Promise<void> {
    const armed = this.armed;
    if (armed?.method === method) {
      this.armed = null;
      await armed.hook();
    }
  }

  async acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    await this.fire('acceptStep');
    return super.acceptStep(id, step, timeStep);
  }

  async confirm(id: IdentityRef, step: string, at?: Date, expectedSecretEnc?: string): Promise<boolean> {
    await this.fire('confirm');
    return super.confirm(id, step, at, expectedSecretEnc);
  }

  private held: { entered: () => void; released: Promise<void> } | null = null;

  /** Stops the next put until `release`; `entered` resolves once that put is waiting. */
  holdPut(): { entered: Promise<void>; release: () => void } {
    let release = () => {};
    let entered = () => {};
    const enteredP = new Promise<void>((r) => (entered = r));
    const released = new Promise<void>((r) => (release = r));
    this.held = { entered, released };
    return { entered: enteredP, release };
  }

  async put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean> {
    const held = this.held;
    if (held) {
      this.held = null;
      held.entered();
      await held.released;
    }
    return super.put(id, step, secretEnc, keyId);
  }
}

class StubConfiguration extends Configuration {
  static data: Record<string, unknown> = {};

  get RootConfig(): IConfigLike {
    return StubConfiguration.data as IConfigLike;
  }

  get<T>(path: string[] | string, defaultValue?: T): T {
    let cur: unknown = StubConfiguration.data;
    for (const seg of Array.isArray(path) ? path : path.split('.')) {
      cur = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
    }
    return (cur === undefined ? defaultValue : cur) as T;
  }

  set(): void {}
  merge(): void {}
  async mergeSource(_source: Class<ConfigurationSource>): Promise<void> {}
  async load(): Promise<void> {}
  protected onLoad(): unknown {
    return undefined;
  }
}

describe('v3 step: TotpMfaStep', () => {
  let clock: FakeClock;
  let store: MemoryMfaSecretStore;

  const make = (over: { totp?: Partial<TotpOptions>; identities?: IdentityStore; store?: MemoryMfaSecretStore } = {}) => new TotpMfaStep({ store: over.store ?? store, keys: mfaKeyRingFrom({ secret: KEY }), options: totpOpts(over.totp), identities: over.identities ?? null });

  /** Begins and confirms, returning the provisioning URI; leaves the clock at START. */
  async function enrol(step: TotpMfaStep): Promise<string> {
    const { provisioning } = await step.beginEnrolment(ALICE);
    await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    return provisioning;
  }

  beforeEach(() => {
    clock = new FakeClock(START);
    clock.install();
    store = new MemoryMfaSecretStore();
  });

  afterEach(() => {
    clock.uninstall();
  });

  it("is the MfaStep 'totp' and stores secrets", () => {
    const step = make();
    assert.ok(step instanceof MfaStep);
    assert.strictEqual(step.name, 'totp');
    assert.strictEqual(step.storesSecrets, true);
  });

  it('SR-09 TOTP secret encrypted at rest', async () => {
    const step = make();
    const keyId = mfaKeyFrom(KEY).keyId;
    const check = (row: MfaRecord | null, secret: string, when: string) => {
      assert.ok(row, when);
      const raw = base32Decode(secret);
      assert.strictEqual(raw.length, 20, 'a 160-bit secret');
      assert.ok(!row.secretEnc.toUpperCase().includes(secret.toUpperCase()), `${when}: no base32 secret`);
      assert.ok(!row.secretEnc.toLowerCase().includes(raw.toString('hex')), `${when}: no hex secret`);
      assert.ok(!row.secretEnc.includes(raw.toString('base64')), `${when}: no base64 secret`);
      assert.ok(!row.secretEnc.includes(raw.toString('base64url')), `${when}: no base64url secret`);
      assert.strictEqual(row.keyId, keyId, `${when}: the configured key id`);
    };
    const { provisioning } = await step.beginEnrolment(ALICE);
    const { secret } = parseOtpauth(provisioning);
    check(await store.get(ALICE, 'totp'), secret, 'after begin');
    await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    check(await store.get(ALICE, 'totp'), secret, 'after confirm');
  });

  it('SR-15 a code is accepted once', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    assert.strictEqual(await step.verify(ALICE, code), true);
    assert.strictEqual(await step.verify(ALICE, code), false, 'the same code a second time');
  });

  it('SR-15 a code from an older time step is refused after a newer one', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(60 * SECOND);
    const now = clock.now();
    const cNew = totpFromProvisioning(provisioning, now);
    const cOld = totpFromProvisioning(provisioning, new Date(now.getTime() - 30 * SECOND));
    assert.notStrictEqual(cNew, cOld);
    assert.strictEqual(await step.verify(ALICE, cNew), true);
    assert.strictEqual(await step.verify(ALICE, cOld), false, 'a code of an earlier time step');
  });

  it('accepts a code of the previous step inside the window, a code outside it never', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(90 * SECOND);
    const now = clock.now().getTime();
    assert.strictEqual(await step.verify(ALICE, totpFromProvisioning(provisioning, new Date(now - 60 * SECOND))), false, 'two steps back');
    assert.strictEqual(await step.verify(ALICE, totpFromProvisioning(provisioning, new Date(now - 30 * SECOND))), true, 'one step back');
    assert.strictEqual(await step.verify(ALICE, totpFromProvisioning(provisioning, new Date(now))), true, 'the current step');
  });

  it('strips whitespace from a code', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    assert.strictEqual(await step.verify(ALICE, ` ${code.slice(0, 3)} ${code.slice(3)}\n`), true);
  });

  it('enrolled is false before confirmation and true after', async () => {
    const step = make();
    assert.strictEqual(await step.enrolled(ALICE), false);
    const { provisioning } = await step.beginEnrolment(ALICE);
    assert.strictEqual(await step.enrolled(ALICE), false);
    await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    assert.strictEqual(await step.enrolled(ALICE), true);
  });

  it('begin refuses when enrolled', async () => {
    const step = make();
    await enrol(step);
    const before = await store.get(ALICE, 'totp');
    await assert.rejects(step.beginEnrolment(ALICE), InvalidOperation);
    assert.deepStrictEqual(await store.get(ALICE, 'totp'), before);
  });

  it('begin replaces a pending secret', async () => {
    const step = make();
    const first = await step.beginEnrolment(ALICE);
    const second = await step.beginEnrolment(ALICE);
    assert.notStrictEqual(parseOtpauth(first.provisioning).secret, parseOtpauth(second.provisioning).secret);
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(first.provisioning, clock.now())), InvalidArgument, 'the replaced secret');
    await step.confirmEnrolment(ALICE, totpFromProvisioning(second.provisioning, clock.now()));
    assert.strictEqual(await step.enrolled(ALICE), true);
  });

  it('confirm with a wrong code throws InvalidArgument and stays pending', async () => {
    const step = make();
    const { provisioning } = await step.beginEnrolment(ALICE);
    const right = totpFromProvisioning(provisioning, clock.now());
    const wrong = right === '000000' ? '111111' : '000000';
    for (const bad of [wrong, 'abcdef', '', '12345']) {
      await assert.rejects(step.confirmEnrolment(ALICE, bad), InvalidArgument, bad);
    }
    const row = await store.get(ALICE, 'totp');
    assert.strictEqual(row?.confirmedAt, null);
    assert.strictEqual(row?.lastStep, null);
    await step.confirmEnrolment(ALICE, right);
    assert.strictEqual(await step.enrolled(ALICE), true);
  });

  it('confirm without begin or after confirmation throws InvalidOperation', async () => {
    const step = make();
    await assert.rejects(step.confirmEnrolment(ALICE, '123456'), InvalidOperation);
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now())), InvalidOperation);
  });

  it('confirm consumes its time step', async () => {
    const step = make();
    const { provisioning } = await step.beginEnrolment(ALICE);
    const code = totpFromProvisioning(provisioning, clock.now());
    await step.confirmEnrolment(ALICE, code);
    assert.strictEqual(await step.verify(ALICE, code), false);
  });

  it('verify refuses a begun but unconfirmed enrolment and does not spend the code', async () => {
    const step = make();
    const { provisioning } = await step.beginEnrolment(ALICE);
    const code = totpFromProvisioning(provisioning, clock.now());
    assert.strictEqual(await step.verify(ALICE, code), false);
    assert.strictEqual((await store.get(ALICE, 'totp'))?.lastStep, null);
    await step.confirmEnrolment(ALICE, code);
  });

  it('verify is false without an enrolment', async () => {
    assert.strictEqual(await make().verify(ALICE, '123456'), false);
  });

  it('verify refuses non-digit or wrong-length input without touching the store', async () => {
    const counting = new CountingStore();
    const step = make({ store: counting });
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    counting.calls = 0;
    for (const bad of ['', '   ', code.slice(1), code + '0', 'abcdef', '12a456', '１２３４５６', 'AAAA-BBBB-CCCC-DDDD', null as unknown as string]) {
      assert.strictEqual(await step.verify(ALICE, bad), false, String(bad));
    }
    assert.strictEqual(counting.calls, 0);
    assert.strictEqual(await step.verify(ALICE, code), true, 'the code was not spent');
  });

  it('disable removes the enrolment', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    await step.disable(ALICE);
    assert.strictEqual(await store.get(ALICE, 'totp'), null);
    assert.strictEqual(await step.enrolled(ALICE), false);
    assert.strictEqual(await step.verify(ALICE, code), false);
    await step.disable(ALICE);
  });

  it('the provisioning URI carries issuer, label, algorithm, digits and period', async () => {
    const step = make({ totp: { issuer: 'Acme', algorithm: 'SHA256', digits: 8, period: 60 }, identities: new Identities({ email: 'alice@example.com', name: 'Alice' }) });
    const { provisioning } = await step.beginEnrolment(ALICE);
    const url = new URL(provisioning);
    assert.strictEqual(url.protocol, 'otpauth:');
    assert.strictEqual(url.host, 'totp');
    assert.strictEqual(decodeURIComponent(url.pathname), '/Acme:alice@example.com');
    assert.strictEqual(url.searchParams.get('issuer'), 'Acme');
    const p = parseOtpauth(provisioning);
    assert.deepStrictEqual({ algorithm: p.algorithm, digits: p.digits, period: p.period }, { algorithm: 'SHA256', digits: 8, period: 60 });
    const code = totp(p.secret, clock.now(), p);
    assert.strictEqual(code.length, 8);
    await step.confirmEnrolment(ALICE, code);
    assert.strictEqual(await step.enrolled(ALICE), true);
  });

  it('labels with the name without an email, and with the id without an identity store', async () => {
    const named = await make({ identities: new Identities({ name: 'Alice' }) }).beginEnrolment(ALICE);
    assert.strictEqual(decodeURIComponent(new URL(named.provisioning).pathname), '/SpinaJS:Alice');
    const bare = await make({ store: new MemoryMfaSecretStore() }).beginEnrolment(ALICE);
    assert.strictEqual(decodeURIComponent(new URL(bare.provisioning).pathname), `/SpinaJS:${ALICE.id}`);
  });

  it('a row that does not decrypt is a server fault, not a wrong code', async () => {
    const step = make();
    const provisioning = await enrol(step);
    const row = (await store.get(ALICE, 'totp'))!;
    const parts = row.secretEnc.split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 1;
    const damaged = [...parts.slice(0, 3), ct.toString('base64url')].join('.');
    await store.remove(ALICE, 'totp');
    await store.put(ALICE, 'totp', damaged, row.keyId);
    await store.confirm(ALICE, 'totp');
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    const { secret } = parseOtpauth(provisioning);
    const serverFault = (e: Error) => e instanceof UnexpectedServerError && !e.message.includes(secret);
    await assert.rejects(step.verify(ALICE, code), serverFault);

    await store.remove(ALICE, 'totp');
    await store.put(ALICE, 'totp', damaged, row.keyId);
    await assert.rejects(step.confirmEnrolment(ALICE, code), serverFault);
    await store.put(ALICE, 'totp', row.secretEnc, 'unknown-key-id');
    await assert.rejects(step.confirmEnrolment(ALICE, code), serverFault);
  });

  it('SR-15 two parallel verifies of one code give one success', async () => {
    const step = make();
    const provisioning = await enrol(step);
    clock.tick(30 * SECOND);
    const code = totpFromProvisioning(provisioning, clock.now());
    const results = await Promise.all([step.verify(ALICE, code), step.verify(ALICE, code), step.verify(ALICE, code)]);
    assert.strictEqual(results.filter(Boolean).length, 1);
  });

  it('confirm fails closed when a begin replaces the secret before its time step is spent', async () => {
    const racing = new InterleavingStore();
    const step = make({ store: racing });
    const { provisioning } = await step.beginEnrolment(ALICE);
    const s1 = (await racing.get(ALICE, 'totp'))!.secretEnc;
    racing.arm('acceptStep', () => step.beginEnrolment(ALICE));
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now())), InvalidOperation);
    assert.strictEqual(await step.enrolled(ALICE), false);
    const row = await racing.get(ALICE, 'totp');
    assert.ok(row && row.secretEnc !== s1, "the begin's pending row stays");
    assert.strictEqual(await racing.countRecoveryCodes(ALICE), 0);
  });

  it('confirm fails closed when a begin replaces the secret before it is confirmed', async () => {
    const racing = new InterleavingStore();
    const step = make({ store: racing });
    const { provisioning } = await step.beginEnrolment(ALICE);
    const s1 = (await racing.get(ALICE, 'totp'))!.secretEnc;
    racing.arm('confirm', () => step.beginEnrolment(ALICE));
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now())), InvalidOperation);
    assert.strictEqual(await step.enrolled(ALICE), false);
    const row = await racing.get(ALICE, 'totp');
    assert.ok(row && row.secretEnc !== s1 && row.confirmedAt === null, "the begin's pending row stays");
    assert.strictEqual(await racing.countRecoveryCodes(ALICE), 0);
  });

  it('a stalled confirm never removes an enrolment another confirm completed', async () => {
    const racing = new InterleavingStore();
    const step = make({ store: racing });
    const first = await step.beginEnrolment(ALICE);
    clock.tick(30 * SECOND);
    let second: { recoveryCodes?: readonly string[] } = {};
    let s2 = '';
    racing.arm('acceptStep', async () => {
      const { provisioning } = await step.beginEnrolment(ALICE);
      s2 = (await racing.get(ALICE, 'totp'))!.secretEnc;
      second = await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, new Date(clock.now().getTime() - 30 * SECOND)));
    });
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(first.provisioning, clock.now())), InvalidOperation);
    const row = await racing.get(ALICE, 'totp');
    assert.ok(row?.confirmedAt);
    assert.strictEqual(row.secretEnc, s2);
    assert.strictEqual(await step.enrolled(ALICE), true);
    assert.strictEqual(second.recoveryCodes?.length, 10);
    assert.strictEqual(await step.verifyRecovery(ALICE, second.recoveryCodes![0]), true, 'the codes the winner showed are live');
  });

  it('a double confirm with codes of two time steps succeeds once and issues one set', async () => {
    const step = make();
    const { provisioning } = await step.beginEnrolment(ALICE);
    clock.tick(30 * SECOND);
    const now = clock.now().getTime();
    const older = totpFromProvisioning(provisioning, new Date(now - 30 * SECOND));
    const newer = totpFromProvisioning(provisioning, new Date(now));
    const results = await Promise.allSettled([step.confirmEnrolment(ALICE, older), step.confirmEnrolment(ALICE, newer)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(won.length, 1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof TotpAlreadyEnrolled || lost.reason instanceof TotpInvalidCode, String(lost.reason));
    const codes = (won[0] as PromiseFulfilledResult<{ recoveryCodes?: readonly string[] }>).value.recoveryCodes!;
    assert.strictEqual(codes.length, 10);
    assert.strictEqual(await store.countRecoveryCodes(ALICE), 10);
    for (const code of codes) {
      assert.strictEqual(await step.verifyRecovery(ALICE, code), true);
    }
  });

  it('a begin whose put lands after a confirmation leaves the enrolment intact', async () => {
    const racing = new InterleavingStore();
    const step = make({ store: racing });
    const { provisioning } = await step.beginEnrolment(ALICE);
    const hold = racing.holdPut();
    const late = step.beginEnrolment(ALICE);
    await hold.entered;
    await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    const confirmed = await racing.get(ALICE, 'totp');
    hold.release();
    await assert.rejects(late, InvalidOperation);
    assert.deepStrictEqual(await racing.get(ALICE, 'totp'), confirmed);
    assert.strictEqual(await step.enrolled(ALICE), true);
  });

  it('a confirm that loses to one of the same secret says the enrolment is confirmed', async () => {
    const racing = new InterleavingStore();
    const step = make({ store: racing });
    const { provisioning } = await step.beginEnrolment(ALICE);
    clock.tick(30 * SECOND);
    const now = clock.now().getTime();
    let winner: { recoveryCodes?: readonly string[] } = {};
    racing.arm('confirm', async () => {
      winner = await step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, new Date(now)));
    });
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, new Date(now - 30 * SECOND))), (e: Error) => e instanceof TotpAlreadyEnrolled && /regenerate the recovery codes/.test(e.message));
    assert.strictEqual(winner.recoveryCodes?.length, 10);
    assert.strictEqual(await step.verifyRecovery(ALICE, winner.recoveryCodes![0]), true);
  });

  it('names its refusals with distinct errors', async () => {
    const step = make();
    await assert.rejects(step.confirmEnrolment(ALICE, '123456'), TotpNotBegun);
    const { provisioning } = await step.beginEnrolment(ALICE);
    const right = totpFromProvisioning(provisioning, clock.now());
    await assert.rejects(step.confirmEnrolment(ALICE, right === '000000' ? '111111' : '000000'), TotpInvalidCode);
    await step.confirmEnrolment(ALICE, right);
    await assert.rejects(step.beginEnrolment(ALICE), TotpAlreadyEnrolled);
    clock.tick(30 * SECOND);
    await assert.rejects(step.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now())), TotpAlreadyEnrolled);
    assert.ok(new TotpEnrolmentChanged() instanceof InvalidOperation);
  });

  it('refuses to work when no store is registered', async () => {
    // Store tests in this run import @spinajs/authn-totp/db, which registers DbMfaSecretStore.
    DI.unregister(DbMfaSecretStore);
    DI.clearCache();
    try {
      const step = new TotpMfaStep({ keys: mfaKeyRingFrom({ secret: KEY }), options: totpOpts(), identities: null });
      await assert.rejects(step.beginEnrolment(ALICE), (e: Error) => e instanceof InvalidOperation && /MfaSecretStore/.test(e.message) && e.message.includes('@spinajs/authn-totp/db'));
      await assert.rejects(step.verify(ALICE, '123456'), /MfaSecretStore/);
    } finally {
      DI.register(DbMfaSecretStore).as(MfaSecretStore);
      DI.clearCache();
    }
  });

  it('refuses to work without an encryption key', async () => {
    const { child } = await boot([AUTHN_CONFIGURATION_SCHEMA], {});
    const step = readingFrom(new TotpMfaStep({ store, options: totpOpts(), identities: null }), child);
    try {
      await assert.rejects(step.beginEnrolment(ALICE), (e: Error) => e instanceof InvalidOption && /authn\.mfa\.encryptionKey/.test(e.message));
    } finally {
      await disposeBooted();
    }
    assert.strictEqual(await store.get(ALICE, 'totp'), null);
  });

  it('decrypts a row written under a previous key after rotation', async () => {
    const OLD = 'ff'.repeat(32);
    const before = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: OLD }), options: totpOpts(), identities: null });
    const { provisioning } = await before.beginEnrolment(ALICE);
    await before.confirmEnrolment(ALICE, totpFromProvisioning(provisioning, clock.now()));
    const after = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: KEY, previous: [OLD] }), options: totpOpts(), identities: null });
    clock.tick(30 * SECOND);
    assert.strictEqual(await after.verify(ALICE, totpFromProvisioning(provisioning, clock.now())), true);
  });
});

describe('v3 step: TotpMfaStep range floor', () => {
  const stepWith = (over: Record<string, unknown>) =>
    new TotpMfaStep({ store: new MemoryMfaSecretStore(), keys: mfaKeyRingFrom({ secret: 'ab'.repeat(32) }), options: { ...TOTP_DEFAULTS, ...over } as TotpOptions, identities: null });
  const rejects = (over: Record<string, unknown>) => assert.rejects(stepWith(over).beginEnrolment(ALICE), (e: Error) => e instanceof InvalidOption && /authn\.mfa\.totp/.test(e.message));

  it('rejects a window beyond the floor', () => rejects({ window: 50 }));
  it('rejects digits below the floor', () => rejects({ digits: 4 }));
  it('rejects a non-numeric window', () => rejects({ window: '3' }));
  it('accepts the defaults', async () => {
    await stepWith({}).beginEnrolment(ALICE);
  });
});

describe('v3 step: TotpMfaStep through DI', () => {
  // @spinajs/users' UserIdentityStore, registered by this package's src import, needs a booted Orm.
  class NoIdentities extends Identities {
    constructor() {
      super({});
    }
  }

  const DI_KEY = 'ab'.repeat(32);
  let clock: FakeClock;

  before(async () => {
    DI.clearCache();
    StubConfiguration.data = { authn: { mfa: { totp: { ...TOTP_DEFAULTS, issuer: 'Acme', digits: 8 }, encryptionKey: { secret: DI_KEY } } } };
    DI.register(StubConfiguration).as(Configuration);
    DI.register(MemoryMfaSecretStore).as(MfaSecretStore);
    DI.register(NoIdentities).as(IdentityStore);
    await DI.resolve(Configuration);
  });

  after(() => {
    DI.unregister(StubConfiguration);
    DI.unregister(MemoryMfaSecretStore);
    DI.unregister(NoIdentities);
    DI.clearCache();
  });

  beforeEach(() => {
    clock = new FakeClock(START);
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('reads authn.mfa.totp and authn.mfa.encryptionKey and uses the registered store', async () => {
    const steps = await DI.resolve(Array.ofType(MfaStep));
    const step = steps.find((s) => s.name === 'totp');
    assert.ok(step instanceof TotpMfaStep);
    const { provisioning } = await step.beginEnrolment(ALICE);
    const p = parseOtpauth(provisioning);
    assert.strictEqual(p.digits, 8);
    assert.strictEqual(new URL(provisioning).searchParams.get('issuer'), 'Acme');
    const store = await DI.resolve(MfaSecretStore);
    assert.ok(store instanceof MemoryMfaSecretStore);
    assert.strictEqual((await store.get(ALICE, 'totp'))?.keyId, mfaKeyFrom(DI_KEY).keyId);
    await step.confirmEnrolment(ALICE, totp(p.secret, clock.now(), p));
    clock.tick(30 * SECOND);
    assert.strictEqual(await step.verify(ALICE, totp(p.secret, clock.now(), p)), true);
  });
});
