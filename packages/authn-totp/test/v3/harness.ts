import { randomBytes } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DbMfaStore } from '@spinajs/authn-orm';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, FakeStrategy, MemoryLinkStore, MemoryPasswordCredentialStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, fakeSeedPort, parseOtpauth, throttleParams, totp } from '@spinajs/authn-testing';
import type { ConfigOverrides, Harness, HarnessContext, MfaStoragePort } from '@spinajs/authn-testing';
import { mfaKeyRingFrom } from '../../src/cipher/index.js';
import { DbMfaSecretStore } from '../../src/db.js';
import { identityKey, MemoryMfaSecretStore } from '../../src/store/index.js';
import type { MfaSecretStore } from '../../src/store/index.js';
import { TotpMfaStep } from '../../src/step/index.js';
import type { TotpOptions } from '../../src/step/index.js';
import { TOTP_DEFAULTS, totpOpts } from './support/totp-defaults.js';
import { bootSqlite, clearMfaTables, rawQuery } from './support/sqlite.js';
import type { SqliteDb } from './support/sqlite.js';

export type StoreKind = 'memory' | 'sqlite';

const SUPPORTED = ['authn.throttle', ...Object.keys(TOTP_DEFAULTS).map((k) => `authn.mfa.totp.${k}`)];

function leafKeys(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    return [prefix];
  }
  return Object.entries(o).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

function checkConfig(config: ConfigOverrides): void {
  const unsupported = leafKeys(config).filter((k) => k !== '' && !SUPPORTED.some((s) => k === s || k.startsWith(`${s}.`)));
  // mfa.enrol confirms with the previous time step, which only a window of 1 or more accepts.
  if (config.authn?.mfa?.totp && (config.authn.mfa.totp as Partial<TotpOptions>).window === 0) {
    unsupported.push('authn.mfa.totp.window');
  }
  if (unsupported.length > 0) {
    throw new UnsupportedConfig(unsupported);
  }
}

let db: Promise<SqliteDb> | undefined;

/** One sqlite database for every case of the run; each case starts from empty MFA tables. */
async function sqliteStore(): Promise<{ store: MfaSecretStore; storage: MfaStoragePort }> {
  const { driver } = await (db ??= bootSqlite('a10'));
  await clearMfaTables(driver);
  const select = async (sql: string, id: IdentityRef): Promise<Record<string, unknown>[]> => (await rawQuery(driver, sql, [identityKey(id)])) as Record<string, unknown>[];
  return {
    store: new DbMfaSecretStore(new DbMfaStore(driver)),
    storage: {
      storedSecret: async (id) => {
        const rows = await select("SELECT secret_enc FROM authn_mfa WHERE identity = ? AND step = 'totp'", id);
        return rows.length ? String(rows[0].secret_enc) : null;
      },
      storedRecoveryCodes: async (id) => (await select('SELECT code_hash FROM authn_recovery_code WHERE identity = ?', id)).map((r) => String(r.code_hash)),
    },
  };
}

function memoryStore(): { store: MfaSecretStore; storage: MfaStoragePort } {
  const store = new MemoryMfaSecretStore();
  return {
    store,
    storage: {
      storedSecret: async (id) => (await store.get(id, 'totp'))?.secretEnc ?? null,
      storedRecoveryCodes: async (id) => store.recoveryCodeHashes(id),
    },
  };
}

export async function disposeTotpHarnessDb(): Promise<void> {
  const pending = db;
  db = undefined;
  await (await pending)?.dispose();
}

/** The real TotpMfaStep over the kit fakes (design §10.3), on the memory store or DbMfaSecretStore on sqlite. */
export async function totpHarness(ctx: HarnessContext, kind: StoreKind = 'memory'): Promise<Harness> {
  checkConfig(ctx.config);
  const options = totpOpts((ctx.config.authn?.mfa?.totp ?? {}) as Partial<TotpOptions>);
  const { store, storage } = kind === 'sqlite' ? await sqliteStore() : memoryStore();
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const step = new TotpMfaStep({ store, keys: mfaKeyRingFrom({ secret: randomBytes(32).toString('hex') }), options, identities });
  const params = throttleParams(ctx.config);
  const throttle = new FakeBackoffThrottle(params);
  const events = new RecordingEventSink();
  const sessions = new MemorySessionIssuer();
  const service = new FakeAuthnService({
    strategies: [FakeStrategy.password({ identities, passwords })],
    throttle,
    identities,
    links: new MemoryLinkStore(),
    linking: { jit: false, byVerifiedEmail: false },
    policy: new EnrolledMfaPolicy([step]),
    steps: [step],
    sessions,
    sinks: [events],
    principals: new RecordingPrincipalFactory(),
  });

  const seeds = new Map<string, string>();
  const recovery = new Map<string, readonly string[]>();
  const seedOf = (id: IdentityRef): string => {
    const seed = seeds.get(identityKey(id));
    if (!seed) throw new Error(`totpHarness: ${identityKey(id)} is not enrolled through mfa.enrol`);
    return seed;
  };

  return {
    service,
    seed: fakeSeedPort(identities, passwords),
    sessions,
    throttle: { throttle, params },
    events,
    mfa: {
      step,
      async enrol(id) {
        const { provisioning } = await step.beginEnrolment(id);
        const { secret } = parseOtpauth(provisioning);
        // The previous time step confirms, so the current one stays free for code().
        const previous = new Date(Date.now() - options.period * 1000);
        const { recoveryCodes } = await step.confirmEnrolment(id, totp(secret, previous, options));
        seeds.set(identityKey(id), secret);
        recovery.set(identityKey(id), recoveryCodes ?? []);
      },
      code: async (id) => totp(seedOf(id), new Date(), options),
      recoveryCodes: async (id) => recovery.get(identityKey(id)) ?? [],
    },
    mfaStorage: storage,
  };
}
