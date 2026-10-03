import 'mocha';
import assert from 'node:assert/strict';
import type { JwsClaims, JwsKey, JwsVerifyOptions } from '@spinajs/authn/contracts';
import { loadC8Fixtures } from '@spinajs/authn-testing';
import type { C8KeysFile, C8TicketsFile } from '@spinajs/authn-testing';
import { LocalJwsSigner, StrictJwsVerifier } from '../src/jws/index.js';

// Canvas C8 (`contracts/ts/plane-api/src/{schemas,ticket}.ts`): the TicketClaims schema and ticketProblems, as the
// claims rule a canvas verifier passes. Test code only: authn-keys knows nothing about canvas tickets.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROLES = ['none', 'viewer', 'commenter', 'editor', 'maintainer'];
const KINDS = ['user', 'agent', 'link'];
const MAX_TICKET_TTL_SECS = 600;
const LONE_SURROGATE = /\p{Surrogate}/u;

type Claims = JwsClaims & Record<string, unknown>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isUuid = (v: unknown): boolean => isStr(v) && UUID.test(v);
const optUuid = (o: Record<string, unknown>, k: string): boolean => o[k] === undefined || o[k] === null || isUuid(o[k]);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function schemaOk(p: Readonly<Record<string, unknown>>): boolean {
  const agent = p.agent;
  const agentOk = agent === undefined || agent === null || (isObj(agent) && isUuid(agent.session) && isUuid(agent.task) && (agent.roots === undefined || agent.roots === null || strings(agent.roots)));
  return isStr(p.iss) && isStr(p.aud) && isUuid(p.jti) && isStr(p.sid) && KINDS.includes(p.kind as string) && optUuid(p, 'sub') && isStr(p.name) && optUuid(p, 'link') && agentOk && optUuid(p, 'on_behalf_of') && isUuid(p.project) && isStr(p.branch) && optUuid(p, 'file') && ROLES.includes(p.role as string) && strings(p.capabilities) && strings(p.addons) && isCount(p.iat) && isCount(p.exp);
}

function ticketProblems(p: Readonly<Record<string, unknown>>): boolean {
  const set = (k: string) => p[k] !== undefined && p[k] !== null;
  const [sub, link, agent, obo] = [set('sub'), set('link'), set('agent'), set('on_behalf_of')];
  const iat = p.iat as number;
  const exp = p.exp as number;
  const a = isObj(p.agent) ? p.agent : null;
  const texts = [p.iss, p.aud, p.jti, p.sid, p.sub, p.name, p.link, p.on_behalf_of, p.project, p.branch, p.file, p.role, ...(p.capabilities as string[]), ...(p.addons as string[]), ...(a ? [a.session, a.task, ...((a.roots as string[] | null | undefined) ?? [])] : [])];
  return (p.kind === 'user' && (!sub || link || agent || obo)) || (p.kind === 'link' && (!link || agent || obo)) || (p.kind === 'agent' && (sub || link || !agent || !obo)) || p.role === 'none' || (p.sid as string).length === 0 || Buffer.byteLength(p.sid as string) > 128 || (p.branch as string).length === 0 || exp <= iat || exp - iat > MAX_TICKET_TTL_SECS || texts.some((s) => isStr(s) && LONE_SURROGATE.test(s));
}

const ticketClaims = (p: Readonly<Record<string, unknown>>): Claims | null => (schemaOk(p) && !ticketProblems(p) ? (p as Claims) : null);

let fixtures: { keys: C8KeysFile; tickets: C8TicketsFile };

const jwks = (): Map<string, JwsKey> => new Map(fixtures.keys.jwks.keys.map((k) => [k.kid, { kid: k.kid, alg: 'EdDSA', jwk: { kty: k.kty, crv: k.crv, x: k.x } } as JwsKey]));

const options = (nowS: number, keys = jwks()): JwsVerifyOptions<Claims> => ({
  typ: 'canvas-rt+jwt',
  algorithms: ['EdDSA'],
  keys: async (kid) => keys.get(kid) ?? null,
  claims: ticketClaims,
  issuer: 'canvas-api',
  audience: 'canvas-realtime',
  now: new Date(nowS * 1000),
  skewSeconds: 30,
  maxLifetimeSeconds: MAX_TICKET_TTL_SECS,
});

describe('canvas C8 golden tickets', () => {
  before(() => {
    fixtures = loadC8Fixtures();
  });

  it('has the vendored set: 3 valid and 23 invalid tickets', () => {
    assert.strictEqual(fixtures.tickets.valid.length, 3);
    assert.strictEqual(fixtures.tickets.invalid.length, 23);
  });

  it('the signer reproduces every valid ticket byte for byte', async () => {
    const signer = new LocalJwsSigner(fixtures.keys.signing.map((k) => ({ ...k })));
    for (const t of fixtures.tickets.valid) {
      assert.strictEqual(await signer.sign(t.claims as Claims, { typ: 'canvas-rt+jwt', kid: t.kid }), t.token, t.name);
    }
  });

  it('the signer serves the public JWKS of the fixtures', async () => {
    const signer = new LocalJwsSigner(fixtures.keys.signing.map((k) => ({ ...k })));
    assert.deepStrictEqual(
      (await signer.publicKeys()).map((k) => ({ kid: k.kid, alg: k.alg, ...k.jwk })),
      fixtures.keys.jwks.keys.map((k) => ({ kid: k.kid, alg: 'EdDSA', kty: k.kty, crv: k.crv, x: k.x })),
    );
  });

  it('the verifier accepts every valid ticket with its claims', async () => {
    for (const t of fixtures.tickets.valid) {
      const r = await new StrictJwsVerifier().verify(t.token, options(t.now));
      assert.ok(r.ok, `${t.name}: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(r.claims, t.claims, t.name);
      assert.strictEqual(r.key.kid, t.kid);
    }
  });

  for (let i = 0; i < 23; i += 1) {
    it(`the verifier rejects invalid ticket ${i + 1} with its C8 code`, async () => {
      const t = fixtures.tickets.invalid[i];
      assert.deepStrictEqual(await new StrictJwsVerifier().verify(t.token, options(t.now)), { ok: false, code: t.error }, t.name);
    });
  }

  it('expires at exp + 30 s, not before; not valid before iat − 30 s', async () => {
    const t = fixtures.tickets.valid[0];
    const { iat, exp } = t.claims as { iat: number; exp: number };
    const at = async (s: number) => {
      const r = await new StrictJwsVerifier().verify(t.token, options(s));
      return r.ok ? 'ok' : r.code;
    };
    assert.strictEqual(await at(exp + 29), 'ok');
    assert.strictEqual(await at(exp + 30), 'expired');
    assert.strictEqual(await at(iat - 30), 'ok');
    assert.strictEqual(await at(iat - 31), 'not_yet_valid');
  });

  it('a key taken out of the set fails with unknown_key (emergency rotation, C8 D5)', async () => {
    const t = fixtures.tickets.valid[1];
    const keys = jwks();
    keys.delete(t.kid);
    assert.deepStrictEqual(await new StrictJwsVerifier().verify(t.token, options(t.now, keys)), { ok: false, code: 'unknown_key' });
  });
});
