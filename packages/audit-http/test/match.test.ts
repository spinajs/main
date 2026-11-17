import 'mocha';
import { expect } from 'chai';
import { AuditConfigError } from '@spinajs/audit';

import { matchesRoute } from '../src/index.js';
import { ruleFor, rulesOf } from '../src/match.js';

describe('audit.http.rules patterns', () => {
  it('matches the method and the path segments', () => {
    expect(matchesRoute('DELETE /admin/users/:id', 'delete', '/admin/users/:id')).to.eq(true);
    expect(matchesRoute('DELETE /admin/users/:id', 'get', '/admin/users/:id')).to.eq(false);
    expect(matchesRoute('* /admin/users/:id', 'post', '/admin/users/:id')).to.eq(true);
    expect(matchesRoute('GET /admin/users', 'get', '/admin/users/:id')).to.eq(false);
  });

  it('reads * as one segment and ** as any number of them', () => {
    expect(matchesRoute('GET /admin/*', 'get', '/admin/users')).to.eq(true);
    expect(matchesRoute('GET /admin/*', 'get', '/admin/users/:id')).to.eq(false);
    expect(matchesRoute('DELETE /admin/**', 'delete', '/admin')).to.eq(true);
    expect(matchesRoute('DELETE /admin/**', 'delete', '/admin/users/:id/keys')).to.eq(true);
    expect(matchesRoute('GET /**/export', 'get', '/reports/2026/export')).to.eq(true);
    expect(matchesRoute('GET /**/export', 'get', '/reports/2026')).to.eq(false);
  });

  it('takes the first rule that fits and refuses an entry it cannot read', () => {
    const rules = rulesOf([
      { match: 'DELETE /admin/**', action: 'admin.delete' },
      { match: '* /admin/**', trail: 'admin' },
    ]);

    expect(ruleFor(rules, 'DELETE', '/admin/users/:id')?.action).to.eq('admin.delete');
    expect(ruleFor(rules, 'GET', '/admin/users')?.trail).to.eq('admin');
    expect(ruleFor(rules, 'GET', '/reports')).to.eq(undefined);
    expect(rulesOf(undefined)).to.deep.eq([]);
    expect(() => rulesOf([{ match: 'DELETE /a' }, { match: 'DELETE' }])).to.throw(AuditConfigError, "audit.http.rules[1]: match must be '<METHOD or *> <path pattern>', and action and trail, when given, a name");
  });
});
