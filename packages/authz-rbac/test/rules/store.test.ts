import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRuleStore, RuleStore, readRuleDefs } from '../../src/index.js';
import { CANVAS_RULES } from './canvas-rules.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1 = { type: 'org', id: 'o1' };
const P1 = { type: 'project', id: 'p1' };

const cap = (extra: Record<string, unknown> = {}) => ({ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', ...extra });

describe('authz-rbac ConfigRuleStore', () => {
  it('reads valid rules of each kind, frozen, with source config and dates for ISO expiries', () => {
    const rules = readRuleDefs([{ id: 'r1', kind: 'restrict', scope: O1, allow: [{ type: 'user', id: 'u1' }, { set: { role: 'org.member', scope: O1 } }] }, cap({ subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } }, assignments: { subjectTypes: ['user'] }, expiresAt: '2027-01-01T00:00:00.000Z' }), { id: 's1', kind: 'cap', scope: GLOBAL, stripTags: true, when: { attr: 'scope.org.policies.addons', eq: false } }, { id: 'c2', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: null }, { id: 'c3', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }, { id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:*'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: { code: 'branch_protected', pattern: 'release/*', priority: 700, sortKey: 'release/*' } }, { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: { ref: 'principal.attributes.min' } }]);
    expect(rules.map((r) => r.id)).to.deep.equal(['r1', 'c1', 's1', 'c2', 'c3', 't1', 't2']);
    expect(rules.every((r) => r.source === 'config' && Object.isFrozen(r))).to.equal(true);
    expect(rules[1].expiresAt).to.deep.equal(new Date('2027-01-01T00:00:00.000Z'));
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

  // The schema refuses every malformed rule at boot. A list it never saw (Configuration.set, the constructor seam) must
  // still never read as a rule that applies to fewer requests than it says: the store refuses those, the model the rest.
  describe('rules the schema never saw', () => {
    const refuses = (rules: unknown, ...parts: string[]) => {
      let thrown: unknown;
      try {
        readRuleDefs(rules as unknown[]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, JSON.stringify(rules)).to.be.instanceOf(AuthzConfigError);
      for (const p of parts) expect((thrown as Error).message, JSON.stringify(rules)).to.contain(p);
    };

    it('refuses an unknown kind, which no step runs', () => {
      refuses([cap({ kind: 'grant' })], "(id 'c1')", 'kind');
      refuses([cap({ kind: undefined })], "(id 'c1')", 'kind');
    });

    it('refuses an unknown key, which would drop what it misspells', () => {
      refuses([{ id: 't1', kind: 'threshold', scope: GLOBAL, permission: ['x:y'], minRole: 'viewer' }], "(id 't1')", 'permission');
      refuses([cap({ maxrole: 'editor' })], "(id 'c1')", 'maxrole');
      refuses([{ id: 's1', kind: 'cap', scope: GLOBAL, striptags: true }], "(id 's1')", 'striptags');
      refuses([cap({ allow: [] })], "(id 'c1')", 'allow');
    });

    it('refuses a scope other than $global or a node with an id, which no check path holds', () => {
      for (const scope of [{ type: 'file' }, { type: 'org', idd: 'o1' }, { id: 'o1' }, 'org', { type: 'org', id: '' }, { type: 'org', id: null }, { type: 'org', id: 1 }, { type: '$global', id: 'x' }, { type: '', id: 'o1' }, null]) refuses([cap({ scope })], "(id 'c1')", 'scope');
    });

    it('refuses a subject ref with an empty type, which no principal has', () => {
      refuses([cap({ subjects: { refs: [{ type: '', id: 'u1' }] } })], "(id 'c1')", 'subjects.refs');
    });

    it('names a rules value or a rule that is not an object instead of a TypeError', () => {
      for (const rules of [null, {}, 'r1']) refuses(rules, 'authz.rbac.rules');
      for (const rule of [null, 'c1', []]) refuses([rule], 'authz.rbac.rules[0]', 'object');
    });

    it('refuses a selector that selects nothing or a threshold without permissions', () => {
      const t = (extra: Record<string, unknown>) => ({ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', ...extra });
      refuses([t({ permissions: undefined })], "(id 't1')", 'permissions');
      refuses([t({ permissions: [] })], "(id 't1')", 'permissions');
      refuses([t({ permissions: 'x:y' })], "(id 't1')", 'permissions');
      refuses([cap({ resourceTypes: [] })], "(id 'c1')", 'resourceTypes');
      refuses([cap({ subjects: { principalTypes: [] } })], "(id 'c1')", 'subjects.principalTypes');
      refuses([cap({ subjects: { actorTypes: [1] } })], "(id 'c1')", 'subjects.actorTypes');
      refuses([cap({ subjects: { refs: [] } })], "(id 'c1')", 'subjects.refs');
      for (const id of [undefined, null, '']) refuses([cap({ subjects: { refs: [{ type: 'user', id }] } })], "(id 'c1')", 'subjects.refs');
      refuses([cap({ assignments: { scopeTypes: [] } })], "(id 'c1')", 'assignments.scopeTypes');
      refuses([cap({ assignments: { subjectTypes: 'user' } })], "(id 'c1')", 'assignments.subjectTypes');
    });

    it('refuses a rank without exactly one bound, which would select nobody or pick one of two', () => {
      for (const bound of [{}, { lte: 'org.guest' }, { lt: 'org.guest', gte: 'org.member' }]) refuses([cap({ subjects: { rank: { ladder: 'org', at: 'org', ...bound } } })], "(id 'c1')", 'subjects.rank');
    });

    it('refuses a cap that neither caps nor strips tags', () => {
      refuses([{ id: 'c1', kind: 'cap', scope: GLOBAL, ladder: 'project' }], "(id 'c1')", 'maxRole');
      refuses([{ id: 'c1', kind: 'cap', scope: GLOBAL, stripTags: 'true' }], "(id 'c1')", 'maxRole');
    });

    it('refuses an expiresAt that is not a date', () => {
      refuses([cap({ expiresAt: 'soon' })], "(id 'c1')", 'expiresAt');
      refuses([cap({ expiresAt: new Date('soon') })], "(id 'c1')", 'expiresAt');
    });

    it('refuses an expiresAt string without a timezone, which would be read as local time', () => {
      for (const expiresAt of ['2027-01-01T00:00:00', '2027-01-01', 'Jan 1 2027']) refuses([cap({ expiresAt })], "(id 'c1')", 'expiresAt');
      for (const expiresAt of ['2027-01-01T00:00:00Z', '2027-01-01T00:00:00.000+02:00', '2027-01-01T00:00:00-0130']) expect(readRuleDefs([cap({ expiresAt })])[0].expiresAt).to.deep.equal(new Date(expiresAt));
    });

    it('does not read a null authz.rbac.rules as no rules', () => {
      expect(() => new ConfigRuleStore({ get: () => null } as unknown as Configuration).all()).to.throw();
    });
  });
});

describe('authz-rbac authz.rbac.rules schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(rules: unknown): Promise<Configuration> {
    const booted = await bootConfiguration({ authz: { rbac: { rules } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (rules: unknown) => violationPaths(boot(rules));

  // bootConfiguration passes the values through JSON, which turns a Date into a string.
  async function bootValues(rules: unknown): Promise<Configuration> {
    const child = DI.RootContainer.child();
    children.push(child);
    child.register(AUTHZ_RBAC_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources() {
            this.Sources = [];
          }
          protected onLoad() {
            return { authz: { rbac: { rules } } };
          }
        },
      )
      .as(Configuration);
    return (await child.resolve(Configuration)) as Configuration;
  }

  it('takes valid rules of each kind; ConfigRuleStore gives a rule without a scope GLOBAL', async () => {
    const configuration = await boot([
      { id: 'r1', kind: 'restrict', scope: O1, allow: [{ type: 'user', id: 'u1' }, { set: { role: 'org.member', scope: O1 } }] },
      cap({ subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } }, assignments: { subjectTypes: ['user'] }, expiresAt: '2027-01-01T00:00:00.000Z' }),
      { id: 's1', kind: 'cap', scope: GLOBAL, stripTags: true, when: { attr: 'scope.org.policies.addons', eq: false } },
      { id: 'c2', kind: 'cap', ladder: 'project', maxRole: null },
      { id: 'c3', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } },
      { id: 't1', kind: 'threshold', scope: P1, resourceTypes: ['branch'], permissions: ['file:*'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: { code: 'branch_protected', pattern: 'release/*', priority: 700, sortKey: 'release/*' } },
      { id: 't2', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: { ref: 'principal.attributes.min' } },
    ]);
    const rules = new ConfigRuleStore(configuration).all();

    expect(rules.map((r) => r.id)).to.deep.equal(['r1', 'c1', 's1', 'c2', 'c3', 't1', 't2']);
    expect(rules.find((r) => r.id === 'c2')!.scope).to.deep.equal(GLOBAL);
    expect(rules.find((r) => r.id === 'c1')!.expiresAt).to.deep.equal(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('refuses a malformed rule at boot, naming the full path', async () => {
    expect(await refused({})).to.include('authz.rbac.rules');
    expect(await refused([cap({ colour: 'red' })])).to.include('authz.rbac.rules.0.colour');
    expect(await refused([cap({ kind: 'grant' })])).to.include('authz.rbac.rules.0.kind');
    expect(await refused([{ id: 'c1', kind: 'cap', scope: GLOBAL }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([{ id: 'c1', kind: 'cap', scope: GLOBAL, maxRole: 'viewer' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([cap({ maxRole: '' })])).to.include('authz.rbac.rules.0.maxRole');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'] }])).to.include('authz.rbac.rules.0.minRole');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', at: 'org' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([{ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['x:y'], minRole: 'viewer', reason: { code: 'x', model: 'abac' } }])).to.include('authz.rbac.rules.0.reason.model');
    expect(await refused([cap({ subjects: { rank: { ladder: 'org', at: 'org', lt: 'a', gte: 'b' } } })])).to.include('authz.rbac.rules.0.subjects.rank');
    expect(await refused([{ id: 'r1', kind: 'restrict', scope: O1, allow: [], ladder: 'project' }])).to.include('authz.rbac.rules.0.ladder');
    expect(await refused([cap({ expiresAt: 'soon' })])).to.include('authz.rbac.rules.0.expiresAt');
    expect(await refused([cap(), cap()])).to.include('authz.rbac.rules');
    expect(await refused([cap({ scope: { type: 'file' } })])).to.include('authz.rbac.rules.0.scope.type');
    expect(await refused([cap({ scope: { type: '$global', id: 'x' } })])).to.include('authz.rbac.rules.0.scope.type');
  });

  // coerceTypes turns a null id into '', which would scope the rule to no node or select no principal.
  it('refuses a null or empty id of a scope or a subject ref', async () => {
    for (const id of [null, '']) {
      expect(await refused([cap({ scope: { type: 'org', id } })]), String(id)).to.include('authz.rbac.rules.0.scope.id');
      expect(await refused([cap({ subjects: { refs: [{ type: 'user', id }] } })]), String(id)).to.include('authz.rbac.rules.0.subjects.refs.0.id');
    }
  });

  it('takes an expiresAt Date from a JS config; refuses an invalid one, a non-date and a date-time without a timezone', async () => {
    const configuration = await bootValues([cap({ expiresAt: new Date('2027-01-01T00:00:00.000Z') })]);
    expect(new ConfigRuleStore(configuration).all()[0].expiresAt).to.deep.equal(new Date('2027-01-01T00:00:00.000Z'));
    const invalid = await bootValues([cap({ expiresAt: new Date('soon') })]);
    expect(() => new ConfigRuleStore(invalid).all()).to.throw(AuthzConfigError, 'expiresAt');
    expect(await refused([cap({ expiresAt: {} })])).to.include('authz.rbac.rules.0.expiresAt');
    expect(await refused([cap({ expiresAt: '2027-01-01T00:00:00' })])).to.include('authz.rbac.rules.0.expiresAt');
  });

  it('ConfigRuleStore reads authz.rbac.rules through @Config of its container', async () => {
    const { child } = await bootConfiguration({ authz: { rbac: { rules: [cap()] } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(child);
    child.register(ConfigRuleStore).as(RuleStore);
    const store = (await child.resolve(RuleStore)) as ConfigRuleStore;
    expect(store.all().map((r) => r.id)).to.deep.equal(['c1']);
  });
});
