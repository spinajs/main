import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import type { Configuration } from '@spinajs/configuration';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, readRuleDefs } from '../../src/index.js';
import { CANVAS_RULES } from './canvas-rules.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = { type: 'org', id: 'o1' };
const P1 = { type: 'project', id: 'p1' };

const cap = (extra: Record<string, unknown> = {}) => ({ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', ...extra });
const refused = (rules: unknown, ...parts: string[]) => {
  let thrown: unknown;
  try {
    readRuleDefs(rules);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, JSON.stringify(rules)).to.be.instanceOf(AuthzConfigError);
  for (const p of parts) expect((thrown as Error).message).to.contain(p);
};

describe('authz-rbac ConfigRuleStore', () => {
  it('reads valid rules of each kind, frozen, with source config and dates for ISO expiries', () => {
    const rules = readRuleDefs([{ id: 'r1', kind: 'restrict', scope: O1, allow: [{ type: 'user', id: 'u1' }, { set: { role: 'org.member', scope: O1 } }] }, cap({ subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } }, assignments: { subjectTypes: ['user'] }, expiresAt: '2027-01-01T00:00:00.000Z' }), { id: 's1', kind: 'cap', scope: GLOBAL, stripTags: true, when: { attr: 'scope.org.policies.addons', eq: false } }, { id: 'c2', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: null }, { id: 'c3', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }, { id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:*'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: { code: 'branch_protected', pattern: 'release/*', priority: 700, sortKey: 'release/*' } }, { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: { ref: 'principal.attributes.min' } }]);
    expect(rules.map((r) => r.id)).to.deep.equal(['r1', 'c1', 's1', 'c2', 'c3', 't1', 't2']);
    expect(rules.every((r) => r.source === 'config' && Object.isFrozen(r))).to.equal(true);
    expect(rules[1].expiresAt).to.deep.equal(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('refuses malformed rules, naming the rule and the path', () => {
    refused({}, 'list');
    refused([cap({ colour: 'red' })], "[0] (id 'c1')", 'colour');
    refused([cap({ kind: 'grant' })], "(id 'c1')", 'kind');
    refused([{ id: 'c1', kind: 'cap', scope: GLOBAL }], "(id 'c1')");
    refused([cap({ ladder: undefined })], "(id 'c1')");
    refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'] }], "(id 't1')", 'minRole');
    refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', at: 'org' }], "(id 't1')", 'ladder');
    refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', reason: { code: 'x', model: 'abac' } }], "(id 't1')");
    refused([cap({ subjects: { rank: { ladder: 'org', at: 'org', lt: 'a', gte: 'b' } } })], "(id 'c1')", '/subjects/rank');
    refused([{ id: 'r1', kind: 'restrict', scope: O1, allow: [], ladder: 'project' }], "(id 'r1')", 'ladder');
    refused([cap({ expiresAt: 'soon' })], "(id 'c1')", 'expiresAt');
    refused([cap(), cap()], "[1] (id 'c1')", 'another rule');
    refused([cap({ scope: { type: 'file' } })], "(id 'c1')", 'bare type');
  });

  it('forPath gives the live rules whose scope is on the path', async () => {
    const store = new ConfigRuleStore([cap({ id: 'g' }), cap({ id: 'o', scope: O1 }), cap({ id: 'p', scope: P1 }), cap({ id: 'old', scope: O1, expiresAt: new Date(NOW.getTime() - 1) })] as RuleDef[]);
    expect((await store.forPath([O1, GLOBAL], NOW)).map((r) => r.id)).to.deep.equal(['g', 'o']);
    expect(store.rulesOn([P1], NOW).map((r) => r.id)).to.deep.equal(['p']);
  });

  it('loads the rules of design §8.5 as written: no scope means GLOBAL', () => {
    const rules = readRuleDefs(CANVAS_RULES);
    expect(rules).to.have.length(13);
    expect(rules.every((r) => r.scope.type === GLOBAL.type && r.scope.id === undefined)).to.equal(true);
  });

  it('a stable version that follows the rules', async () => {
    const a = new ConfigRuleStore([cap()] as RuleDef[]);
    expect(await a.version()).to.equal(await new ConfigRuleStore([cap()] as RuleDef[]).version());
    expect(await a.version()).to.not.equal(await new ConfigRuleStore([cap({ maxRole: 'editor' })] as RuleDef[]).version());
  });

  it('reads authz.rbac.rules from the configuration', () => {
    const paths: unknown[] = [];
    const configuration = { get: (path: unknown) => (paths.push(path), [cap()]) } as unknown as Configuration;
    expect(new ConfigRuleStore(configuration).all().map((r) => r.id)).to.deep.equal(['c1']);
    expect(paths).to.deep.equal([['authz', 'rbac', 'rules']]);
  });
});
