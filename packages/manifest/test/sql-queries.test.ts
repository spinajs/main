import { expect } from 'chai';
import 'mocha';
import { mergeFragments, validateFragment } from '../src/index.js';
import type { ModelSqlQuery } from '../src/index.js';
import { fragment, src } from './support.js';

const meta = { app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '2026-11-03T00:00:00.000Z' };
const query = (pkg: string, over: Partial<ModelSqlQuery> = {}): ModelSqlQuery => ({ id: 'src/x.ts:1:1', text: 'SELECT Id FROM users WHERE Id IN (?)', placeholders: 1, dynamic: false, lists: [0], source: src(pkg), ...over });

describe('sqlQueries', () => {
  it('validates a fragment with a typed query', () => {
    const typed = query('app', { declaredRow: { text: '{ Id: number; }' }, declaredColumns: [{ name: 'Id', ts: 'number', nullable: false }], connection: 'reports' });
    expect(validateFragment(fragment('app', { sqlQueries: [typed] }))).to.deep.equal([]);
  });

  it('merges every fragment, prefixing ids with the package', () => {
    const merged = mergeFragments(fragment('app', { sqlQueries: [query('app')] }), [fragment('dep', { sqlQueries: [query('dep')] })], meta);
    expect(merged.sqlQueries?.map((q) => q.id)).to.deep.equal(['dep:src/x.ts:1:1', 'app:src/x.ts:1:1']);
  });

  it('omits the section when no fragment has a query', () => {
    expect(mergeFragments(fragment('app'), [], meta)).to.not.have.property('sqlQueries');
  });
});
