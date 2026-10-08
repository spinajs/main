import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_RULES, FACET_KINDS, PENDING_TRANSCRIPTION, RULE_IDS, isNeed } from '../src/behaviour/index.js';
import type { RuleId } from '../src/behaviour/index.js';

// Design §4.4.
const FACET_MAP = ['A01/core', 'A02/core', 'A02/external', 'A02/local', 'A02/http', 'A03/argon2', 'A04/local', 'A05/store', 'A05/core', 'A05/http', 'A06/store', 'A06/core', 'A07/store', 'A07/http', 'A08/store', 'A08/http', 'A08/lifecycle', 'A09/core', 'A09/store', 'A09/http', 'A10/step', 'A10/totp', 'A10/core', 'A10/http', 'A11/store', 'A11/local', 'A11/http', 'A12/api', 'A12/identity', 'A12/flow', 'A13/core', 'A13/local', 'A13/http', 'A14/token', 'A14/http', 'A15/token', 'A15/core', 'A16/jwt', 'A17/keys', 'A17/jws', 'A17/core', 'A17/http', 'A18/core', 'A19/store', 'A19/core', 'A19/oidc', 'A20/core', 'A20/http', 'A21/core', 'A22/http', 'A23/core', 'A23/http', 'A24/boot', 'A25/http', 'A26/http', 'A27/oidc', 'A30/local', 'A30/http', 'A31/http', 'A31/config', 'A32/migration', 'A32/http'];

// Design §11.1: in-kit SR titles and their facets.
const SR_TITLES: readonly [string, string][] = [
  ["SR-01 admin reads another user's reset token", 'A12/api'],
  ['SR-01 owner reads own 2fa secret', 'A12/api'],
  ['SR-02 2fa:enabled write by owner', 'A12/api'],
  ['SR-02 delete protected row by id', 'A12/api'],
  ['SR-03 spoofed X-Forwarded-For is ignored', 'A05/http'],
  ['SR-03 credential stuffing from one IP backs off', 'A06/store'],
  ['SR-03 at most maxConcurrent hashes run', 'A03/argon2'],
  ['SR-04 unknown login costs a hash', 'A02/local'],
  ['SR-04 reset request answers before the work', 'A11/local'],
  ['SR-05 parallel burst verifies only free attempts', 'A05/store'],
  ['SR-05 attacker cannot lock the owner out', 'A06/store'],
  ['SR-06 banning the impersonator ends the impersonation', 'A20/core'],
  ['SR-06 impersonation expires after maxMinutes', 'A20/core'],
  ['SR-07 pending session cannot impersonate', 'A09/http'],
  ['SR-07 pending whoami shows only MfaRequired', 'A09/http'],
  ['SR-08 reset revokes tokens', 'A11/local'],
  ['SR-08 minting a token needs fresh auth', 'A13/http'],
  ['SR-08 token without expiry refused', 'A14/token'],
  ['SR-09 no clear secret in users_metadata', 'A32/migration'],
  ['SR-09 TOTP secret encrypted at rest', 'A10/totp'],
  ["SR-10 lower admin cannot reset a higher admin's password", 'A25/http'],
  ['SR-10 admin MFA reset returns no secret', 'A25/http'],
  ['SR-11 login and impersonation are audited by default', 'A21/core'],
  ['SR-12 empty CORS list sends no CORS headers', 'A31/http'],
  ['SR-12 cross-origin cookie POST refused', 'A22/http'],
  ['SR-15', 'A10/totp'],
  ['SR-17', 'A11/local'],
  ['SR-18', 'A07/store'],
  ['SR-19', 'A21/core'],
  ['SR-20', 'A13/core'],
];

const ruleOf = (facet: string) => facet.split('/')[0] as RuleId;
const transcribed = (id: RuleId) => !PENDING_TRANSCRIPTION.has(id);
const allCases = () => [...AUTHN_RULES.values()].flatMap((r) => r.cases.map((c) => ({ rule: r.id, c })));

describe('behaviour registry', () => {
  it('RULE_IDS are A01–A27 and A30–A32 in order', () => {
    const expected = [...Array.from({ length: 27 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'A30', 'A31', 'A32'];
    assert.deepStrictEqual([...RULE_IDS], expected);
    assert.deepStrictEqual([...AUTHN_RULES.keys()], expected);
    assert.strictEqual(AUTHN_RULES.has('A28' as RuleId), false);
    assert.strictEqual(AUTHN_RULES.has('A29' as RuleId), false);
  });

  it('each rule has cases exactly when it is not pending transcription', () => {
    for (const [id, rule] of AUTHN_RULES) {
      assert.strictEqual(rule.id, id);
      assert.strictEqual(rule.cases.length > 0, transcribed(id), `${id}: ${rule.cases.length} cases, pending ${PENDING_TRANSCRIPTION.has(id)}`);
    }
    for (const id of PENDING_TRANSCRIPTION) {
      assert.ok(AUTHN_RULES.has(id), id);
    }
  });

  it('no rule is pending transcription', () => {
    assert.strictEqual(PENDING_TRANSCRIPTION.size, 0);
  });

  it('batch 5 transcribed A22, A25, A26, A27, A30, A31 and A32 with the design counts', () => {
    const counts = Object.fromEntries(['A22', 'A25', 'A26', 'A27', 'A30', 'A31', 'A32'].map((id) => [id, AUTHN_RULES.get(id as RuleId)!.cases.length]));
    assert.deepStrictEqual(counts, { A22: 19, A25: 13, A26: 5, A27: 14, A30: 7, A31: 10, A32: 8 });
  });

  it('task 3 transcribed the exemplars A02, A05, A06, A07 and A09 in full', () => {
    const counts = Object.fromEntries(['A02', 'A05', 'A06', 'A07', 'A09'].map((id) => [id, AUTHN_RULES.get(id as RuleId)!.cases.length]));
    assert.deepStrictEqual(counts, { A02: 15, A05: 11, A06: 20, A07: 14, A09: 16 });
  });

  it('case names are unique and start with the rule id', () => {
    const names = allCases().map(({ c }) => c.name);
    assert.strictEqual(new Set(names).size, names.length, 'duplicate case names');
    for (const { rule, c } of allCases()) {
      assert.ok(c.name.startsWith(`${rule} `), c.name);
    }
  });

  it('facets belong to their rule, use a facet kind and appear in the facet map', () => {
    for (const { rule, c } of allCases()) {
      const [id, kind] = c.facet.split('/');
      assert.strictEqual(id, rule, c.name);
      assert.ok((FACET_KINDS as readonly string[]).includes(kind), `${c.name}: ${c.facet}`);
      assert.ok(FACET_MAP.includes(c.facet), `${c.name}: ${c.facet} is not in the facet map`);
    }
  });

  it('every facet of the facet map occurs in its transcribed rule', () => {
    const used = new Set(allCases().map(({ c }) => c.facet));
    for (const f of FACET_MAP.filter((x) => transcribed(ruleOf(x)))) {
      assert.ok(used.has(f as never), `no case for ${f}`);
    }
  });

  it('every need is a port, fakeDate, mfa.recovery or a route builder', () => {
    for (const { c } of allCases()) {
      for (const n of c.needs) {
        assert.ok(isNeed(n), `${c.name}: ${n}`);
      }
      assert.strictEqual(new Set(c.needs).size, c.needs.length, `${c.name}: duplicate needs`);
    }
  });

  it('every in-kit SR title of a transcribed rule occurs exactly once, on its facet', () => {
    for (const [title, facet] of SR_TITLES.filter(([, f]) => transcribed(ruleOf(f)))) {
      const hits = allCases().filter(({ c }) => c.name.includes(` ${title}`));
      assert.strictEqual(hits.length, 1, `${title}: ${hits.map((x) => x.c.name).join(' | ')}`);
      assert.strictEqual(hits[0].c.facet, facet, title);
    }
  });
});
