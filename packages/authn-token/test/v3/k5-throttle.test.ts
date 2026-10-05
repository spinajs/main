import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy, AuthnEventSink, AuthnService, AuthnThrottle, IdentityLinkStore, IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthnContext, Credentials, IdentityRef, TokenCreateOptions } from '@spinajs/authn/contracts';
import { MemoryAuthnThrottle } from '@spinajs/authn';
import { FakeIdentityStore, MemoryLinkStore, RecordingEventSink, RecordingPrincipalFactory, generateKeyPair, signCompactJws, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, KitKeyPair } from '@spinajs/authn-testing';

import '../../src/generator.js';
import { JwtBearerStrategy } from '../../src/jwt/JwtBearerStrategy.js';
import { DbTokenService, NoTokenProfilesPolicy, UsersTableTokenOwnerResolver } from '../../src/service/index.js';
import { TokenStrategy } from '../../src/strategy/TokenStrategy.js';
import { bootV3Db, insertUserRow, shutdownV3Db } from './db.js';

// K5: the real DefaultAuthnService over TokenStrategy, JwtBearerStrategy and MemoryAuthnThrottle.

const NOW = new Date('2026-10-04T10:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const DAY = 86_400_000;
const IP = '192.0.2.10';
const ISSUER = 'https://idp.k5.test';
const AUDIENCE = 'k5-api';
const ISSUERS_PATH = ['authn', 'jwt', 'issuers'];

const bearer = (token: string): Credentials => ({ kind: 'bearer', token });

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class K5TokenConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }
    protected loadSources(): void {
      this.Sources = [];
    }
    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

const statuses = (rs: readonly AuthenticationResult[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rs) {
    const k = r.status === 'failure' ? `failure:${r.reason}` : r.status;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

describe('authn-token per-request throttling (K5, K6, DefaultAuthnService)', function () {
  this.timeout(30_000);

  let kp: KitKeyPair;
  let saved: unknown;
  let child: IContainer | undefined;

  const config = () => DI.get(Configuration)!;

  before(async () => {
    await bootV3Db();
    saved = config().get(ISSUERS_PATH);
    kp = generateKeyPair('EdDSA');
    // Configuration.set bypasses the schema, so the members it would default are given here.
    config().set(ISSUERS_PATH, [{ issuer: ISSUER, audience: AUDIENCE, keys: [{ ...kp.publicJwk, kid: kp.kid, alg: kp.alg, use: 'sig' }], algorithms: ['EdDSA'], clockSkewSeconds: 30, subjectClaim: 'sub' }]);
  });

  after(async () => {
    config().set(ISSUERS_PATH, saved);
    await shutdownV3Db();
  });

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  async function world(overrides: ConfigOverrides = {}) {
    const identities = new FakeIdentityStore();
    const tokens = new DbTokenService(new UsersTableTokenOwnerResolver(), new NoTokenProfilesPolicy(), identities);
    const token = new TokenStrategy(tokens);
    await token.resolve();
    const jwt = new JwtBearerStrategy();
    await jwt.resolve();
    const links = new MemoryLinkStore();
    const listed = [
      { name: token.name, service: 'K5Token', instance: token },
      { name: jwt.name, service: 'K5Jwt', instance: jwt },
    ];
    child = DI.RootContainer.child();
    child.register(configurationOf({ authn: { strategies: listed.map(({ name, service }) => ({ name, service })), throttle: { service: 'MemoryAuthnThrottle' }, audit: { sinks: ['K5Events'] } } })).as(Configuration);
    bind(child, AuthnThrottle, 'MemoryAuthnThrottle', new MemoryAuthnThrottle(throttleParams(overrides) as ConstructorParameters<typeof MemoryAuthnThrottle>[0]));
    bind(child, IdentityStore, 'K5IdentityStore', identities);
    bind(child, IdentityLinkStore, 'K5Links', links);
    bind(child, PrincipalFactory, 'K5PrincipalFactory', new RecordingPrincipalFactory());
    bind(child, AuthnEventSink, 'K5Events', new RecordingEventSink());
    for (const s of listed) bind(child, AuthenticationStrategy, s.service, s.instance);
    const service = (await child.resolve(AuthnService)) as AuthnService;

    const owner: IdentityRef = identities.add({ login: randomUUID() });
    await insertUserRow(owner.id);
    const ctx = (ms = 0, ip = IP): AuthnContext => ({ now: new Date(NOW.getTime() + ms), ip, purpose: 'request' });
    const minted = await tokens.create(owner, { name: 'k5', kind: 'pat', expiresAt: new Date(NOW.getTime() + DAY) } as TokenCreateOptions, ctx());
    if (!minted.ok) throw new Error(`not minted: ${JSON.stringify(minted)}`);
    const subject = `sub-${randomUUID()}`;
    await links.link(owner, { provider: `jwt:${ISSUER}`, subject });
    const jws = (): string => signCompactJws({ alg: kp.alg, kid: kp.kid, typ: 'JWT' }, { iss: ISSUER, aud: AUDIENCE, sub: subject, iat: NOW_S, exp: NOW_S + 300, jti: randomUUID() }, kp);
    const auth = (c: Credentials, ms = 0, ip = IP) => service.authenticate(c, ctx(ms, ip));
    return { pat: minted.plaintext, jws, auth, identities, owner };
  }

  it('lets 30 parallel requests with one valid API token through', async () => {
    const w = await world();
    expect(statuses(await Promise.all(Array.from({ length: 30 }, () => w.auth(bearer(w.pat)))))).to.deep.equal({ success: 30 });
  });

  it('lets parallel requests with valid JWT bearers through, one token or many', async () => {
    const w = await world();
    const token = w.jws();
    expect(statuses(await Promise.all(Array.from({ length: 15 }, () => w.auth(bearer(token)))))).to.deep.equal({ success: 15 });
    expect(statuses(await Promise.all(Array.from({ length: 15 }, () => w.auth(bearer(w.jws())))))).to.deep.equal({ success: 15 });
  });

  it('throttles a repeated invalid API token with backoff and leaves other credentials alone', async () => {
    const w = await world();
    const wrong = `${w.pat.slice(0, -6)}zzzzzz`;
    const free = throttleParams().login.account!.free;
    for (let i = 0; i < free; i++) expect(await w.auth(bearer(wrong), i)).to.deep.equal({ status: 'failure', reason: 'invalid_credentials' });
    expect(await w.auth(bearer(wrong), free)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    expect((await w.auth(bearer(w.pat), free)).status).to.equal('success');
    expect(await w.auth(bearer(wrong), free + 1000)).to.deep.equal({ status: 'failure', reason: 'invalid_credentials' });
    expect(await w.auth(bearer(wrong), free + 1001)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 2 });
  });

  it('K6: failures of a token or JWT from another ip never hold its owner in backoff', async () => {
    const w = await world();
    const elsewhere = '198.51.100.7';
    const free = throttleParams().login.account!.free;
    const jwt = w.jws();
    w.identities.setStatus(w.owner, { banned: true });
    for (const t of [w.pat, jwt]) {
      for (let i = 0; i < free; i++) expect((await w.auth(bearer(t), i, elsewhere)).status, `refused ${i + 1}`).to.equal('failure');
      expect(await w.auth(bearer(t), free, elsewhere)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    }
    w.identities.setStatus(w.owner, { banned: false });
    expect((await w.auth(bearer(w.pat), free)).status).to.equal('success');
    expect((await w.auth(bearer(jwt), free)).status).to.equal('success');
    expect(await w.auth(bearer(w.pat), free, elsewhere)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
  });

  it('throttles sprayed invalid tokens and JWTs on the ip key, and valid ones do not clear it', async () => {
    const w = await world({ authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } } } } });
    const forged = generateKeyPair('EdDSA');
    const sprayed = [`${w.pat.slice(0, -6)}aaaaaa`, signCompactJws({ alg: forged.alg, kid: kp.kid, typ: 'JWT' }, { iss: ISSUER, aud: AUDIENCE, sub: 'victim', iat: NOW_S, exp: NOW_S + 300 }, forged), `${w.pat.slice(0, -6)}bbbbbb`];
    for (const [i, t] of sprayed.entries()) {
      expect((await w.auth(bearer(t), i * 2)).status, `spray ${i + 1}`).to.equal('failure');
      if (i < 2) expect((await w.auth(bearer(i === 0 ? w.pat : w.jws()), i * 2 + 1)).status, `valid ${i + 1}`).to.equal('success');
    }
    expect(await w.auth(bearer(`${w.pat.slice(0, -6)}cccccc`), 10)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    expect(await w.auth(bearer(w.pat), 11)).to.deep.equal({ status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
  });
});
