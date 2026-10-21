import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy } from '@spinajs/authn-testing';

import type { AuthnContext, ExternalSubject, StrategyOutcome } from '../../src/index.js';
import { buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreParts } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const PROVIDER = 'oidc:corp';
const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });

/** An interactive strategy for `{ kind: 'kit-external' }` that answers the external subject `external`. */
const externalLike = (external: ExternalSubject) =>
  new FakeStrategy({
    name: PROVIDER,
    kinds: ['kit-external'],
    interactive: true,
    keys: () => [],
    verify: (): StrategyOutcome => ({ ok: true, external, method: 'oidc' }),
  });

const passwordLike = () =>
  new FakeStrategy({
    name: 'local',
    kinds: ['kit-password'],
    interactive: true,
    keys: () => [{ kind: 'account', value: 'u@example.test' }],
    verify: (): StrategyOutcome => ({ ok: true, identity: { type: 'user', id: 'u' }, method: 'password' }),
  });

describe('DefaultAuthnService: the IdP session id in the session facts (FLOW-2)', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  async function boot(s: FakeStrategy): Promise<CoreParts> {
    parts = await buildCore({}, { strategies: [{ name: s.name, service: `Svc_${s.name.replace(/\W/g, '_')}`, instance: s, listed: true }] });
    const id = parts.identities.add({ id: 'u', login: 'u@example.test' });
    await parts.links.link(id, { provider: PROVIDER, subject: 'kc-1' });
    return parts;
  }

  it('an OIDC login whose ID token has sid stores facts.external = { provider, sid }', async () => {
    const p = await boot(externalLike({ provider: PROVIDER, subject: 'kc-1', sid: 'idp-session-1' }));
    const r = await p.service.authenticate({ kind: 'kit-external' }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    const stored = await p.sessions.restore(r.session!.id);
    assert.deepStrictEqual({ ...stored?.facts.external }, { provider: PROVIDER, sid: 'idp-session-1' });
    assert.deepStrictEqual({ ...(await p.service.principalOf(r)).authn?.external }, { provider: PROVIDER, sid: 'idp-session-1' });
  });

  it('an OIDC login without sid stores the provider only', async () => {
    const p = await boot(externalLike({ provider: PROVIDER, subject: 'kc-1' }));
    const r = await p.service.authenticate({ kind: 'kit-external' }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.deepStrictEqual({ ...(await p.sessions.restore(r.session!.id))?.facts.external }, { provider: PROVIDER });
  });

  it('an sid that is no string is not stored', async () => {
    const p = await boot(externalLike({ provider: PROVIDER, subject: 'kc-1', sid: 42 as unknown as string }));
    const r = await p.service.authenticate({ kind: 'kit-external' }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    assert.deepStrictEqual({ ...(await p.sessions.restore(r.session!.id))?.facts.external }, { provider: PROVIDER });
  });

  it('a password login stores no external', async () => {
    const p = await boot(passwordLike());
    const r = await p.service.authenticate({ kind: 'kit-password' }, ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    const stored = await p.sessions.restore(r.session!.id);
    assert.ok(stored, 'the session exists');
    assert.strictEqual(stored.facts.external, undefined);
    assert.ok(!('external' in stored.facts));
  });
});
