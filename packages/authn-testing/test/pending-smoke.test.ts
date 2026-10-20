import assert from 'node:assert/strict';
import 'mocha';
import { AUTHN_RULES, planCases, settleCase } from '../src/behaviour/index.js';

describe('pending smoke: every case against an empty harness', function () {
  this.timeout(60_000);

  for (const [id, rule] of AUTHN_RULES) {
    if (rule.cases.length === 0) {
      continue;
    }
    it(`${id}: every case is pending with exactly its needs in the title`, async () => {
      for (const p of planCases([id])) {
        const r = await settleCase(p, () => ({}), { fakeDate: false });
        assert.strictEqual(r.status, 'pending', `${p.kase.name}: ${String(r.error)}`);
        assert.strictEqual(r.title, `${p.kase.name} [pending: missing ${p.kase.needs.join(', ')}]`);
      }
    });
  }
});
