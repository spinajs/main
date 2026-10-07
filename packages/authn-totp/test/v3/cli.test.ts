import 'mocha';
import assert from 'node:assert/strict';
import { META_COMMAND } from '@spinajs/cli';
import type { ICommand } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { DbAuthnAuditSink, DbAuthnThrottle } from '@spinajs/authn-orm';
import { AuthnEventSink, AuthnService, AuthnThrottle, IdentityStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnEvent, IdentityRef } from '@spinajs/authn/contracts';
import { base32Decode, EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeClock, FakeIdentityStore, MemoryLinkStore, MemorySessionIssuer, parseOtpauth, RecordingEventSink, RecordingPrincipalFactory, throttleParams, totpFromProvisioning } from '@spinajs/authn-testing';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { MemoryMfaSecretStore } from '../../src/store/index.js';
import { TotpMfaStep } from '../../src/step/index.js';
import { TOTP_DEFAULTS, totpOpts } from './support/totp-defaults.js';
import { TotpService } from '../../src/service/index.js';
import { MfaReset } from '../../src/cli/index.js';
import { CLI_ACTOR } from '../../src/cli/common.js';
import { registered } from '../../src/support/registered.js';
import authnTotpConfig from '../../src/config/authn-totp.js';
import * as pkg from '../../src/index.js';

const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

type Lines = { success: string[]; info: string[]; warn: string[] };

describe('v3 cli: authn:mfa-reset', () => {
  let clock: FakeClock;
  let identities: FakeIdentityStore;
  let store: MemoryMfaSecretStore;
  let step: TotpMfaStep;
  let events: RecordingEventSink;
  let service: TotpService;
  let alice: IdentityRef;

  function command(): { cmd: MfaReset; out: Lines } {
    const out: Lines = { success: [], info: [], warn: [] };
    const cmd = new MfaReset();
    Object.defineProperty(cmd, 'Log', { value: { success: (m: string) => out.success.push(m), info: (m: string) => out.info.push(m), warn: (m: string) => out.warn.push(m) } });
    Object.defineProperty(cmd, 'Identities', { value: identities });
    Object.defineProperty(cmd, 'Totp', { value: service });
    return { cmd, out };
  }

  async function enrol(): Promise<{ provisioning: string; recoveryCodes: readonly string[] }> {
    const { provisioning } = await step.beginEnrolment(alice);
    const { recoveryCodes } = await step.confirmEnrolment(alice, totpFromProvisioning(provisioning, clock.now()));
    return { provisioning, recoveryCodes: recoveryCodes ?? [] };
  }

  beforeEach(() => {
    clock = new FakeClock(new Date('2026-10-04T10:00:00Z'));
    clock.install();
    identities = new FakeIdentityStore();
    alice = identities.add({ login: 'alice', email: 'alice@example.com' });
    store = new MemoryMfaSecretStore();
    step = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: KEY }), options: totpOpts(), identities: null });
    events = new RecordingEventSink();
    const sessions = new MemorySessionIssuer();
    const throttle = new FakeBackoffThrottle(throttleParams());
    const authn = new FakeAuthnService({ strategies: [], throttle, identities, links: new MemoryLinkStore(), linking: { jit: false, byVerifiedEmail: false }, policy: new EnrolledMfaPolicy([step]), steps: [step], sessions, sinks: [events], principals: new RecordingPrincipalFactory() });
    service = new TotpService({ step, sessions, authn, throttle, sinks: [events], maxAgeSeconds: 300 });
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('resets an enrolled account, prints the success line and records the CLI as actor', async () => {
    const { provisioning, recoveryCodes } = await enrol();
    const { cmd, out } = command();
    await cmd.execute('alice');
    assert.deepStrictEqual(out.success, ['MFA reset for alice']);
    assert.strictEqual(await step.enrolment(alice), 'none');
    assert.strictEqual(await store.countRecoveryCodes(alice), 0);
    const [e] = events.ofType('mfa.disable');
    assert.deepStrictEqual(e.actor, CLI_ACTOR);
    assert.deepStrictEqual(e.identity, alice);
    assert.strictEqual(e.userAgent, 'spinajs-cli');

    const secret = parseOtpauth(provisioning).secret;
    const raw = base32Decode(secret);
    const needles = [secret, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url'), ...recoveryCodes, ...recoveryCodes.map((c) => c.replace(/-/g, ''))];
    const text = JSON.stringify({ out, events: events.all() }).toUpperCase();
    assert.strictEqual(
      needles.find((n) => text.includes(n.toUpperCase())),
      undefined,
    );
  });

  it('finds the account by email too', async () => {
    await enrol();
    const { cmd, out } = command();
    await cmd.execute('alice@example.com');
    assert.deepStrictEqual(out.success, ['MFA reset for alice@example.com']);
  });

  it('says so when the account has no MFA', async () => {
    const { cmd, out } = command();
    await cmd.execute('alice');
    assert.deepStrictEqual([...out.success, ...out.info], ['No MFA enrolment for alice']);
  });

  it('an unknown login throws, echoing only the login, and changes nothing', async () => {
    await enrol();
    const { cmd, out } = command();
    await assert.rejects(cmd.execute('mallory'), (e: Error) => e.message.includes('mallory') && !e.message.includes(alice.id));
    assert.deepStrictEqual(out, { success: [], info: [], warn: [] });
    assert.strictEqual(await step.enrolment(alice), 'confirmed');
    assert.deepStrictEqual(events.all(), []);
  });

  it('carries the authn:mfa-reset command name', () => {
    const meta = Reflect.getMetadata(META_COMMAND, MfaReset) as ICommand;
    assert.match(meta.nameAndArgs, /^authn:mfa-reset\b/);
  });

  it('the package no longer exports EnableUser2Fa and keeps the QR helper', () => {
    assert.strictEqual((pkg as Record<string, unknown>).EnableUser2Fa, undefined);
    assert.strictEqual(typeof pkg.Generate2FaQrCode, 'function');
    assert.strictEqual(typeof pkg.buildOtpAuthUrl, 'function');
    assert.strictEqual(typeof pkg.MfaReset, 'function');
    assert.strictEqual((pkg as Record<string, unknown>).CLI_ACTOR, undefined);
    assert.strictEqual((pkg as Record<string, unknown>).cliContext, undefined);
  });

  it('the package config lists no MFA step and keeps its defaults', () => {
    const mfa = (authnTotpConfig as unknown as { authn: { mfa: { steps: unknown; encryptionKey: unknown; totp: { recoveryCodes: number; issuer: string } } } }).authn.mfa;
    assert.strictEqual(mfa.steps, undefined, 'arrays concatenate across config files; the app lists the step');
    assert.strictEqual(mfa.encryptionKey, undefined, 'every app loads this file; a null key would stand in for an unset one');
    assert.strictEqual(mfa.totp.recoveryCodes, 10);
    assert.strictEqual(mfa.totp.issuer, 'SpinaJS');
    assert.deepStrictEqual(mfa.totp, { ...TOTP_DEFAULTS });
  });

  describe('under DI', () => {
    const seen: AuthnEvent[] = [];

    class KitSink extends AuthnEventSink {
      async publish(e: AuthnEvent): Promise<void> {
        seen.push(e);
      }
    }
    class KitIdentities extends FakeIdentityStore {
      constructor() {
        super();
        this.add({ id: alice.id, login: 'alice' });
      }
    }
    class KitTotp extends TotpService {
      constructor() {
        super({ step });
      }
    }
    /** RbacCliCommand autoinjects the Orm; the reset never touches it. */
    class KitOrm {}

    before(() => {
      DI.clearCache();
      // Other files in this run load @spinajs/authn-totp/db, which registers authn-orm's DB defaults; the reset needs none.
      DI.unregister(DbAuthnAuditSink);
      DI.unregister(DbAuthnThrottle);
      DI.register(KitSink).as(AuthnEventSink);
      DI.register(KitIdentities).as(IdentityStore);
      DI.register(KitTotp).as(TotpService);
      DI.register(KitOrm).as(Orm);
    });

    after(() => {
      DI.unregister(KitSink);
      DI.unregister(KitIdentities);
      DI.unregister(KitTotp);
      DI.unregister(KitOrm);
      DI.register(DbAuthnAuditSink).as(AuthnEventSink);
      DI.register(DbAuthnThrottle).as(AuthnThrottle);
      DI.clearCache();
    });

    it('adminReset needs only the step and the sinks', async () => {
      for (const t of [SessionIssuer, AuthnService, AuthnThrottle]) {
        assert.strictEqual(registered(t), false, t.name);
      }
      await enrol();
      seen.length = 0;
      const svc = new TotpService({ step });
      assert.deepStrictEqual(await svc.adminReset(CLI_ACTOR, alice, { now: clock.now(), purpose: 'request' }), { reset: true });
      assert.deepStrictEqual(
        seen.map((e) => e.type),
        ['mfa.disable'],
      );
    });

    it('resolves MfaReset with its injected IdentityStore and TotpService and runs it', async () => {
      await enrol();
      seen.length = 0;
      const cmd = await DI.resolve(MfaReset);
      const out: string[] = [];
      Object.defineProperty(cmd, 'Log', { value: { success: (m: string) => out.push(m) } });
      await cmd.execute('alice');
      assert.deepStrictEqual(out, ['MFA reset for alice']);
      assert.strictEqual(await step.enrolment(alice), 'none');
      assert.deepStrictEqual(seen[0]?.actor, CLI_ACTOR);
    });
  });
});

describe('v3 support: registered', () => {
  abstract class Probe {}
  class ProbeImpl extends Probe {}

  afterEach(() => {
    DI.unregister(ProbeImpl);
    DI.clearCache();
  });

  it('is false before, true while and false after a registration', () => {
    assert.strictEqual(registered(Probe), false);
    DI.register(ProbeImpl).as(Probe);
    assert.strictEqual(registered(Probe), true);
    DI.unregister(ProbeImpl);
    assert.strictEqual(registered(Probe), false);
  });

  it('a failed command without an IdentityStore says so', async () => {
    const cmd = new MfaReset();
    Object.defineProperty(cmd, 'Identities', { value: undefined });
    await assert.rejects(cmd.execute('alice'), /needs a registered IdentityStore/);
  });
});
