import 'mocha';
import { randomBytes, randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { Credentials } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemorySessionIssuer, RecordingEventSink, generateKeyPair, runStrategyConformance, signCompactJws } from '@spinajs/authn-testing';
import type { FakeClock, KitKeyPair, StrategySubject } from '@spinajs/authn-testing';

import '../../src/generator.js';
import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { DbTokenService, NoTokenProfilesPolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './db.js';

const DAY_MS = 86_400_000;
const POOL_SIZE = 4;
const ISSUER = 'https://idp.conformance.test';
const AUDIENCE = 'conformance-api';
const ISSUERS_PATH = ['authn', 'jwt', 'issuers'];

const bearer = (token: string): Credentials => ({ kind: 'bearer', token } as Credentials);
const tokenOf = (c: Credentials): string => (c as { token: string }).token;
const sessionsOf = (issuer: MemorySessionIssuer) => ({ count: async () => (await issuer.storage.storedKeys()).length });
/** In the format the generator mints, so the strategy hashes it and looks it up like a real token. */
const randomToken = (): string => `spt_${randomBytes(32).toString('base64url')}`;

async function tokenSubject({ clock }: { clock: FakeClock }): Promise<StrategySubject> {
  const identities = new FakeIdentityStore();
  const tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities);
  const strategy = new TokenStrategy(tokens);
  await strategy.resolve();

  const owner = identities.add({ login: randomUUID() });
  await insertUserRow(owner.id);

  // Minted before the case body: create publishes token.create, and the case asserts verify publishes nothing.
  const pool: string[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const r = await tokens.create(owner, { name: `conformance-${i}`, kind: 'pat', expiresAt: new Date(clock.now().getTime() + DAY_MS) }, clock.ctx({ purpose: 'request' }));
    if (!r.ok) {
      throw new Error(`could not mint a conformance token: ${r.code}`);
    }
    pool.push(r.plaintext);
  }
  let next = 0;

  return {
    strategy,
    valid: async () => bearer(pool[next++ % pool.length]),
    // A token has no account apart from its secret, so a wrong secret and an unknown account are the same lookup.
    invalid: async () => bearer(randomToken()),
    unknown: async () => bearer(randomToken()),
    secretsOf: (c) => [tokenOf(c)],
    sessions: sessionsOf(new MemorySessionIssuer()),
    events: new RecordingEventSink(),
  };
}

async function jwtSubject({ clock }: { clock: FakeClock }): Promise<StrategySubject> {
  const configuration = DI.get(Configuration)!;
  const saved = configuration.get(ISSUERS_PATH);
  const key: KitKeyPair = generateKeyPair('EdDSA');
  // Same kid as the configured key, so the strategy selects that key and only the signature is wrong.
  const wrongKey: KitKeyPair = { ...generateKeyPair('EdDSA'), kid: key.kid };

  // Configuration.set bypasses the schema, so the members it would default are given here.
  configuration.set(ISSUERS_PATH, [{ issuer: ISSUER, audience: AUDIENCE, keys: [{ ...key.publicJwk, kid: key.kid, alg: 'EdDSA', use: 'sig' }], algorithms: ['EdDSA'], clockSkewSeconds: 30, subjectClaim: 'sub' }]);
  const strategy = new JwtBearerStrategy();
  try {
    await strategy.resolve();
  } finally {
    configuration.set(ISSUERS_PATH, saved);
  }

  const sign = (k: KitKeyPair): Credentials => {
    const now = Math.floor(clock.now().getTime() / 1000);
    return bearer(signCompactJws({ alg: k.alg, kid: k.kid, typ: 'JWT' }, { iss: ISSUER, aud: AUDIENCE, sub: 'conformance-sub', iat: now, exp: now + 300, jti: randomUUID() }, k));
  };

  return {
    strategy,
    valid: async () => sign(key),
    invalid: async () => sign(wrongKey),
    // No unknown(): the strategy looks up no account; it answers an external subject and AuthnService links it.
    secretsOf: (c) => [tokenOf(c)],
    sessions: sessionsOf(new MemorySessionIssuer()),
    events: new RecordingEventSink(),
  };
}

describe('authn-token strategy conformance', function () {
  before(async function () {
    this.timeout(15000);
    await bootV3Db();
  });

  after(async () => {
    await shutdownV3Db();
  });

  runStrategyConformance(tokenSubject, { title: 'TokenStrategy conformance' });

  runStrategyConformance(jwtSubject, { title: 'JwtBearerStrategy conformance' });
});
