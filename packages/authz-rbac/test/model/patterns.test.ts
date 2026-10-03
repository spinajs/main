import { AuthzConfigError, FALSE, GLOBAL, TRUE, defaultAttribute, evaluateResidual } from '@spinajs/authz';
import type { EvaluationContext, Principal, ResourceRef, SubjectEnv } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { compilePattern, patternFilter, patternsFilter } from '../../src/index.js';
import type { ResourcePattern } from '../../src/index.js';

const expect = chai.expect;

const alice = userPrincipal('alice', { attributes: { pool: 'p1', org: { id: 7 }, flag: true, empty: '', nothing: null, list: ['a'] } });

const HOME: ResourceRef = { type: 'dir', id: 'home' };
const HOME_ALICE: ResourceRef = { type: 'dir', id: 'home/alice' };
const HOME_ALICE_DOCS: ResourceRef = { type: 'dir', id: 'home/alice/docs' };
const HOME_BOB: ResourceRef = { type: 'dir', id: 'home/bob' };
const HOME_BOB_X: ResourceRef = { type: 'dir', id: 'home/bob/x' };
const FILE_IN_ALICE: ResourceRef = { type: 'file', id: 'home/alice/a.txt' };

const PATHS: Record<string, readonly ResourceRef[]> = {
  'dir:home': [HOME, GLOBAL],
  'dir:home/alice': [HOME_ALICE, HOME, GLOBAL],
  'dir:home/alice/docs': [HOME_ALICE_DOCS, HOME_ALICE, HOME, GLOBAL],
  'dir:home/bob': [HOME_BOB, HOME, GLOBAL],
  'dir:home/bob/x': [HOME_BOB_X, HOME_BOB, HOME, GLOBAL],
  'file:home/alice/a.txt': [FILE_IN_ALICE, HOME_ALICE, HOME, GLOBAL],
};

/** The filter of one pattern for a request on `resource` (concrete when it has an id). */
function on(pattern: ResourcePattern, resource: ResourceRef, principal: Principal = alice) {
  const path = resource.id === undefined ? [GLOBAL] : PATHS[`${resource.type}:${resource.id}`] ?? [resource, GLOBAL];
  return patternFilter(compilePattern(pattern, 'test'), { resource, path, principal });
}

const doc = (id: string): ResourceRef => ({ type: 'doc', id });
const cmpGlob = (value: string) => ({ op: 'cmp', field: 'id', cmp: 'glob', value });

describe('authz-rbac model: resource patterns (B16)', () => {
  describe('compile', () => {
    it('an id without * outside the templates is exact; with one it is a glob', () => {
      expect(compilePattern({ type: 'doc', id: 'pub-1' }, 'test').glob).to.equal(false);
      expect(compilePattern({ type: 'dir', id: 'home/{principal.id}' }, 'test').glob).to.equal(false);
      expect(compilePattern({ type: 'doc', id: 'pub-*' }, 'test').glob).to.equal(true);
      expect(compilePattern({ type: 'doc', id: '{principal.id}-*' }, 'test').glob).to.equal(true);
      expect(compilePattern({ type: 'doc' }, 'test').glob).to.equal(false);
    });

    it('refuses a malformed pattern or template, naming where it is', () => {
      const bad: unknown[] = [null, 'doc', { id: 'x' }, { type: '' }, { type: 'doc', id: 7 }, { type: 'doc', id: '' }, { type: 'doc', id: '{env.now}' }, { type: 'doc', id: '{principal}' }, { type: 'doc', id: '{principal.attributes}' }, { type: 'doc', id: '{principal.attributes.a..b}' }, { type: 'doc', id: '{principal.attributes.__proto__}' }, { type: 'doc', id: 'a{b' }, { type: 'doc', id: 'a}b' }, { type: 'doc', id: '{principal.identity}' }, { type: 'doc', ID: 'pub-1' }, { type: 'doc', id: 'pub-1', scope: 'x' }];
      for (const p of bad) {
        expect(() => compilePattern(p as ResourcePattern, "rbac role 'r' grant 'doc:read'"), JSON.stringify(p))
          .to.throw(AuthzConfigError)
          .with.property('message')
          .that.contains("rbac role 'r' grant 'doc:read'");
      }
    });
  });

  describe('a concrete request', () => {
    it('a type-only pattern matches every resource of that type and no other', () => {
      expect(on({ type: 'doc' }, doc('x'))).to.deep.equal(TRUE);
      expect(on({ type: 'doc' }, { type: 'note', id: 'n1' })).to.deep.equal(FALSE);
    });

    it('an exact id matches that node and what lies below it, of any type', () => {
      expect(on({ type: 'doc', id: 'pub-1' }, doc('pub-1'))).to.deep.equal(TRUE);
      expect(on({ type: 'doc', id: 'pub-1' }, doc('pub-2'))).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/alice' }, HOME_ALICE)).to.deep.equal(TRUE);
      expect(on({ type: 'dir', id: 'home/alice' }, HOME_ALICE_DOCS)).to.deep.equal(TRUE);
      expect(on({ type: 'dir', id: 'home/alice' }, FILE_IN_ALICE)).to.deep.equal(TRUE);
      expect(on({ type: 'dir', id: 'home/alice' }, HOME)).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/alice' }, HOME_BOB)).to.deep.equal(FALSE);
      expect(on({ type: 'doc', id: 'home/alice' }, HOME_ALICE)).to.deep.equal(FALSE);
    });

    it('a glob matches the ids of its own type only, segment-aware', () => {
      expect(on({ type: 'doc', id: 'pub-*' }, doc('pub-2'))).to.deep.equal(TRUE);
      expect(on({ type: 'doc', id: 'pub-*' }, doc('priv-1'))).to.deep.equal(FALSE);
      expect(on({ type: 'doc', id: 'pub-*' }, { type: 'note', id: 'pub-1' })).to.deep.equal(FALSE);
      expect(on({ type: 'file', id: 'shared/*' }, { type: 'file', id: 'shared/a.txt' })).to.deep.equal(TRUE);
      expect(on({ type: 'file', id: 'shared/*' }, { type: 'file', id: 'shared/sub/c.txt' })).to.deep.equal(FALSE);
      expect(on({ type: 'file', id: 'public/**' }, { type: 'file', id: 'public/x/y.txt' })).to.deep.equal(TRUE);
      expect(on({ type: 'dir', id: 'home/*' }, FILE_IN_ALICE)).to.deep.equal(FALSE);
    });
  });

  describe('a type-level request', () => {
    it('a type-only pattern is TRUE for its type and FALSE for another', () => {
      expect(on({ type: 'doc' }, { type: 'doc' })).to.deep.equal(TRUE);
      expect(on({ type: 'doc' }, { type: 'note' })).to.deep.equal(FALSE);
    });

    it('an exact id becomes under the node, whatever the requested type', () => {
      expect(on({ type: 'dir', id: 'home/{principal.id}' }, { type: 'dir' })).to.deep.equal({ op: 'under', scopes: [HOME_ALICE] });
      expect(on({ type: 'dir', id: 'home/alice' }, { type: 'file' })).to.deep.equal({ op: 'under', scopes: [HOME_ALICE] });
    });

    it('a glob becomes cmp glob on the id for its own type, FALSE for another', () => {
      expect(on({ type: 'doc', id: '{principal.id}-*' }, { type: 'doc' })).to.deep.equal(cmpGlob('alice-*'));
      expect(on({ type: 'doc', id: 'pub-*' }, { type: 'note' })).to.deep.equal(FALSE);
    });
  });

  describe('{principal.*} templates', () => {
    it('substitutes the id, the type and attributes, nested ones and scalars of any kind', () => {
      expect(on({ type: 'doc', id: '{principal.type}:{principal.id}-*' }, { type: 'doc' })).to.deep.equal(cmpGlob('user:alice-*'));
      expect(on({ type: 'doc', id: '{principal.attributes.pool}-*' }, { type: 'doc' })).to.deep.equal(cmpGlob('p1-*'));
      expect(on({ type: 'doc', id: 'org-{principal.attributes.org.id}' }, doc('org-7'))).to.deep.equal(TRUE);
      expect(on({ type: 'doc', id: '{principal.attributes.flag}' }, doc('true'))).to.deep.equal(TRUE);
    });

    it('a missing, null, empty or non-scalar value matches nothing', () => {
      for (const path of ['missing', 'nothing', 'empty', 'org', 'list', 'org.id.deeper', 'pool.length']) {
        expect(on({ type: 'doc', id: `{principal.attributes.${path}}-*` }, { type: 'doc' }), path).to.deep.equal(FALSE);
        expect(on({ type: 'doc', id: `{principal.attributes.${path}}` }, doc('-')), path).to.deep.equal(FALSE);
      }
      expect(on({ type: 'doc', id: '{principal.attributes.pool}-*' }, doc('undefined-x'), userPrincipal('carol'))).to.deep.equal(FALSE);
    });

    it('a value holding a glob metacharacter matches nothing instead of widening the pattern', () => {
      for (const id of ['*', 'a*', '?', 'a[b]']) {
        const p = userPrincipal(id);
        expect(on({ type: 'doc', id: '{principal.id}-*' }, { type: 'doc' }, p), id).to.deep.equal(FALSE);
        expect(on({ type: 'doc', id: 'x-{principal.id}' }, doc(`x-${id}`), p), id).to.deep.equal(FALSE);
      }
    });

    it('an id or type holding / matches nothing, so it cannot reach into another subtree', () => {
      const intruder = userPrincipal('bob/x');
      expect(on({ type: 'dir', id: 'home/{principal.id}' }, HOME_BOB_X, intruder)).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/{principal.id}' }, { type: 'dir' }, intruder)).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/{principal.id}/*' }, { type: 'dir', id: 'home/bob/x/y' }, intruder)).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/{principal.id}/*' }, { type: 'dir' }, intruder)).to.deep.equal(FALSE);
      expect(on({ type: 'dir', id: 'home/{principal.type}' }, HOME_BOB_X, { ...alice, type: 'bob/x' } as Principal)).to.deep.equal(FALSE);
      for (const id of ['.', '..']) expect(on({ type: 'dir', id: 'home/{principal.id}' }, { type: 'dir' }, userPrincipal(id)), id).to.deep.equal(FALSE);
    });

    it('an attribute may be a path, but not with an empty, . or .. segment', () => {
      const withDir = (dir: string) => userPrincipal('alice', { attributes: { dir } });
      expect(on({ type: 'dir', id: 'home/{principal.attributes.dir}' }, { type: 'dir' }, withDir('alice/docs'))).to.deep.equal({ op: 'under', scopes: [HOME_ALICE_DOCS] });
      expect(on({ type: 'dir', id: 'home/{principal.attributes.dir}' }, HOME_ALICE_DOCS, withDir('alice/docs'))).to.deep.equal(TRUE);
      for (const dir of ['../bob', 'alice/../bob', 'a//b', '/abs', 'a/', 'a/.', '.', '..']) {
        expect(on({ type: 'dir', id: 'home/{principal.attributes.dir}' }, { type: 'dir' }, withDir(dir)), dir).to.deep.equal(FALSE);
        expect(on({ type: 'dir', id: 'home/{principal.attributes.dir}/*' }, { type: 'dir' }, withDir(dir)), dir).to.deep.equal(FALSE);
      }
    });
  });

  it('the engine reads each type-level filter row by row as the concrete check answers it (B06)', async () => {
    const rows = [HOME, HOME_ALICE, HOME_ALICE_DOCS, HOME_BOB, HOME_BOB_X, FILE_IN_ALICE];
    const patterns: ResourcePattern[] = [{ type: 'dir', id: 'home/{principal.id}' }, { type: 'dir', id: 'home/alice' }, { type: 'dir', id: 'home/*' }, { type: 'file', id: 'home/**' }, { type: 'dir' }];
    for (const pattern of patterns) {
      for (const row of rows) {
        const env: SubjectEnv = {
          principal: alice,
          ref: row,
          attribute: defaultAttribute,
          relation: () => undefined,
          ancestors: async (r) => PATHS[`${r.type}:${r.id}`] ?? null,
          native: () => undefined,
          ctx: {} as EvaluationContext,
        };
        const filtered = await evaluateResidual(on(pattern, { type: row.type }), { id: row.id }, env);
        expect(filtered, `${JSON.stringify(pattern)} on ${row.type}:${row.id}`).to.equal(on(pattern, row).op === 'true');
      }
    }
  });

  it('several patterns OR', () => {
    const patterns = [compilePattern({ type: 'doc', id: 'pub-*' }, 'test'), compilePattern({ type: 'dir', id: 'home/{principal.id}' }, 'test'), compilePattern({ type: 'note' }, 'test')];
    expect(patternsFilter(patterns, { resource: { type: 'doc' }, path: [GLOBAL], principal: alice })).to.deep.equal({ op: 'or', args: [cmpGlob('pub-*'), { op: 'under', scopes: [HOME_ALICE] }] });
    expect(patternsFilter(patterns, { resource: { type: 'note' }, path: [GLOBAL], principal: alice })).to.deep.equal(TRUE);
    expect(patternsFilter(patterns, { resource: doc('priv-1'), path: [doc('priv-1'), GLOBAL], principal: alice })).to.deep.equal(FALSE);
    expect(patternsFilter(patterns, { resource: doc('pub-9'), path: [doc('pub-9'), GLOBAL], principal: alice })).to.deep.equal(TRUE);
  });
});
