import { ConfigRoleStore, ConfigRuleStore } from '@spinajs/authz-rbac';
import type { Configuration } from '@spinajs/configuration';
import * as chai from 'chai';
import { readFileSync, writeFileSync } from 'node:fs';

import { branchRulePermissions, branchWritePermissions, canvasAuthzConfig, capabilityPermission, CapabilityTableError, orgLevelPermissions, readCapabilities, RULE_IDS } from './config.js';
import type { CanvasAuthzConfig } from './config.js';
import { CANVAS_FIXTURES_DIR } from './fixtures.js';

const expect = chai.expect;

const SNAPSHOT = CANVAS_FIXTURES_DIR + 'config.snapshot.json';
const capabilitiesJson = (): Record<string, unknown> => JSON.parse(readFileSync(CANVAS_FIXTURES_DIR + 'capabilities.json', 'utf8'));
const PW = ['project', 'org'];

/** The Configuration surface the config stores read: `get(path[], default)`. */
const configurationOf = (config: CanvasAuthzConfig): Configuration =>
  ({
    get: (path: string[] | string, defaultValue?: unknown) => {
      const value = (Array.isArray(path) ? path : path.split('.')).reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), { authz: config });
      return value === undefined ? defaultValue : value;
    },
  }) as unknown as Configuration;

/** capabilities.json with one row (by name) edited, or the whole table edited. */
function tableWith(edit: (t: Record<string, unknown>, rows: Record<string, unknown>[]) => void): unknown {
  const t = capabilitiesJson();
  edit(t, t.capabilities as Record<string, unknown>[]);
  return t;
}
const row = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.name === name)!;

describe('canvas C6 config generator (design §8.5)', () => {
  const config = canvasAuthzConfig(capabilitiesJson());

  describe('snapshot', () => {
    it('equals fixtures/canvas-c6/config.snapshot.json', () => {
      // K1_UPDATE_SNAPSHOT=1 rewrites the snapshot from the generator; review the diff before committing.
      if (process.env.K1_UPDATE_SNAPSHOT === '1') writeFileSync(SNAPSHOT, JSON.stringify(config, null, 2) + '\n', 'utf8');
      expect(config).to.deep.equal(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
    });

    it('is plain JSON', () => {
      expect(JSON.parse(JSON.stringify(config))).to.deep.equal(config);
    });
  });

  describe('agrees with the design listing', () => {
    it('has the 30 permissions in wire order, each on org, project, file and branch (org:manage also on group)', () => {
      expect(Object.keys(config.permissions)).to.deep.equal([
        'project:read', 'project:export', 'inspect:view', 'code:view', 'history:read', 'repo:read', 'presence:join', 'comment:create', 'comment:resolve', 'mr:comment',
        'mr:approve', 'file:edit', 'branch:create', 'version:save', 'version:restore', 'mr:create', 'repo:push', 'file:manage', 'library:read', 'library:use',
        'library:render', 'branch:merge', 'library:publish', 'project:settings', 'grants:invite', 'grants:manage', 'project:delete', 'org:manage', 'org:billing', 'audit:read',
      ]);
      for (const [name, p] of Object.entries(config.permissions)) expect(p, name).to.deep.equal({ types: name === 'org:manage' ? ['org', 'project', 'file', 'branch', 'group'] : ['org', 'project', 'file', 'branch'] });
    });

    it('fixes combine, ladders and stores', () => {
      expect(config.combine).to.deep.equal({ default: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] } });
      expect(config.rbac.ladders).to.deep.equal({
        project: { roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
        org: { roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
      });
      expect(config.rbac.stores).to.deep.equal({ roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['ConfigRuleStore', 'DbRuleStore'], links: ['DbLinkStore'] });
    });

    it('gives the project roles the grants of the listing', () => {
      const roles = config.rbac.roles;
      expect(Object.keys(roles)).to.deep.equal(['viewer', 'commenter', 'editor', 'maintainer', 'org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner', 'group.member']);
      expect(roles.viewer).to.deep.equal({
        ladder: 'project',
        grants: [
          'project:read',
          'project:export',
          { permission: 'inspect:view', requiresTag: 'inspect' },
          { permission: 'code:view', requiresTag: 'code' },
          'history:read',
          { permission: 'repo:read', grantedAt: PW },
          'presence:join',
          { permission: 'library:read', grantedAt: PW },
          'library:render',
        ],
      });
      expect(roles.commenter).to.deep.equal({ ladder: 'project', grants: ['comment:create', 'comment:resolve', { permission: 'mr:comment', grantedAt: PW }] });
      // The design lists editor's grants non-PW first; the generator keeps wire order, so compare as members.
      expect(roles.editor.ladder).to.equal('project');
      expect(roles.editor.grants).to.have.deep.members([
        'file:edit',
        'version:save',
        'version:restore',
        ...['mr:approve', 'branch:create', 'mr:create', 'repo:push', 'file:manage', 'library:use', 'branch:merge', 'grants:invite'].map((permission) => ({ permission, grantedAt: PW })),
      ]);
      expect(roles.maintainer).to.deep.equal({ ladder: 'project', grants: ['library:publish', 'project:settings', 'grants:manage', 'project:delete'].map((permission) => ({ permission, grantedAt: PW })) });
    });

    it('gives the org roles the grants and flags of the listing', () => {
      const roles = config.rbac.roles;
      expect(roles['org.file_guest']).to.deep.equal({ ladder: 'org', grants: [] });
      expect(roles['org.guest']).to.deep.equal({ ladder: 'org', grants: [] });
      expect(roles['org.member']).to.deep.equal({ ladder: 'org', subjectSet: true, grants: [] });
      expect(roles['org.admin']).to.deep.equal({
        ladder: 'org',
        grants: ['org:manage', 'audit:read'],
        implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect', 'code'], bypass: ['restrict', 'cap'] }],
      });
      expect(roles['org.owner']).to.deep.equal({ ladder: 'org', grants: ['org:billing'] });
      expect(roles['group.member']).to.deep.equal({ subjectSet: true, grants: [] });
    });

    it('has the 13 rules in design order, external-sharing-off included', () => {
      const ids = ['file-grant-cap', 'link-cap', 'link-org-cap', 'guest-cap', 'guest-org-cap', 'external-cap', 'external-sharing-off', 'guest-addons', 'link-addons', 'link-members-only', 'no-download', 'editors-may-not-invite', 'delete-needs-org-admin'];
      expect(config.rbac.rules.map((r) => r.id)).to.deep.equal(ids);
      expect(RULE_IDS).to.deep.equal(ids);
      expect(config.rbac.rules[6]).to.deep.equal({
        id: 'external-sharing-off',
        kind: 'cap',
        ladder: 'project',
        maxRole: null,
        subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } },
        assignments: { subjectTypes: ['user', 'group'] },
        when: { attr: 'scope.org.policies.external_sharing', eq: false },
      });
    });

    it('has the agents-disabled policy', () => {
      expect(config.abac).to.deep.equal({
        policies: [{ id: 'agents-disabled', effect: 'deny', actorTypes: ['agent'], permissions: ['*'], when: { attr: 'scope.org.policies.agents_allowed', eq: false }, reason: 'agents_disabled', priority: 100 }],
      });
    });

    it('gives implies to org.admin only, onto the project ladder (r3, H26)', () => {
      const withImplies = Object.entries(config.rbac.roles).filter(([, r]) => r.implies !== undefined);
      expect(withImplies.map(([name]) => name)).to.deep.equal(['org.admin']);
      for (const i of config.rbac.roles['org.admin'].implies!) expect(config.rbac.ladders.project.roles).to.include(i.role);
    });

    it('returns fresh objects on every call', () => {
      const a = canvasAuthzConfig(capabilitiesJson());
      a.rbac.rules[0].maxRole = 'viewer';
      (a.rbac.roles.viewer.grants[5] as { grantedAt: string[] }).grantedAt.push('file');
      expect(canvasAuthzConfig(capabilitiesJson())).to.deep.equal(config);
    });
  });

  describe('permission names', () => {
    it('maps x.y to x:y and export to project:export', () => {
      expect(capabilityPermission('repo.read')).to.equal('repo:read');
      expect(capabilityPermission('export')).to.equal('project:export');
    });

    for (const bad of ['project', 'a.b.c', '.read', 'repo.', '']) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        expect(() => capabilityPermission(bad)).to.throw(CapabilityTableError);
      });
    }
  });

  describe('branch and org permission lists', () => {
    it('lists the branch-write permissions in wire order', () => {
      expect(branchWritePermissions(capabilitiesJson())).to.deep.equal(['file:edit', 'version:save', 'version:restore', 'repo:push', 'branch:merge']);
    });

    it('splits them into push and merge rule lists', () => {
      expect(branchRulePermissions(capabilitiesJson())).to.deep.equal({ push: ['file:edit', 'version:save', 'version:restore', 'repo:push'], merge: ['branch:merge'] });
    });

    it('lists the org-level permissions', () => {
      expect(orgLevelPermissions(capabilitiesJson())).to.deep.equal(['org:manage', 'org:billing', 'audit:read']);
    });
  });

  describe('readCapabilities', () => {
    it('keeps the vendored table in wire order', () => {
      const t = readCapabilities(capabilitiesJson());
      expect(t.roles).to.deep.equal(['none', 'viewer', 'commenter', 'editor', 'maintainer']);
      expect(t.addons).to.deep.equal(['inspect', 'code']);
      expect(t.capabilities.map((c) => c.name)).to.deep.equal((capabilitiesJson().capabilities as { name: string }[]).map((c) => c.name));
    });

    const malformed: [string, () => unknown][] = [
      ['an unknown top-level key', () => tableWith((t) => (t.extra = 1))],
      ['an unknown row key', () => tableWith((_, rows) => (row(rows, 'repo.read').note = 'x'))],
      ['a missing row key', () => tableWith((_, rows) => delete row(rows, 'repo.read').branch_write)],
      ['an unknown role in the role list', () => tableWith((t) => (t.roles as string[]).push('owner'))],
      ['a role list out of ladder order', () => tableWith((t) => (t.roles = ['none', 'commenter', 'viewer', 'editor', 'maintainer']))],
      ['a role list missing a ladder role', () => tableWith((t) => (t.roles = ['none', 'viewer', 'editor', 'maintainer']))],
      ['an unknown min_role', () => tableWith((_, rows) => (row(rows, 'repo.read').min_role = 'owner'))],
      ['min_role none', () => tableWith((_, rows) => (row(rows, 'repo.read').min_role = 'none'))],
      ['an unknown org_role', () => tableWith((_, rows) => (row(rows, 'org.manage').org_role = 'member'))],
      ['an unknown add-on', () => tableWith((_, rows) => (row(rows, 'code.view').addon = 'xray'))],
      ['a row with both min_role and org_role', () => tableWith((_, rows) => (row(rows, 'org.manage').min_role = 'viewer'))],
      ['a row with neither min_role nor org_role', () => tableWith((_, rows) => (row(rows, 'repo.read').min_role = null))],
      ['an org_role row with an add-on', () => tableWith((_, rows) => (row(rows, 'org.manage').addon = 'code'))],
      ['an org_role row that is project-wide', () => tableWith((_, rows) => (row(rows, 'org.manage').project_wide = true))],
      ['an org_role row that is branch-write', () => tableWith((_, rows) => (row(rows, 'org.manage').branch_write = true))],
      ['a duplicate name', () => tableWith((_, rows) => rows.push({ ...row(rows, 'repo.read') }))],
      ['a bad capability name', () => tableWith((_, rows) => (row(rows, 'repo.read').name = 'repo'))],
      ['a non-boolean flag', () => tableWith((_, rows) => (row(rows, 'repo.read').project_wide = 'yes'))],
    ];
    for (const [what, make] of malformed) {
      it(`refuses ${what}`, () => {
        const input = make();
        expect(() => readCapabilities(input)).to.throw(CapabilityTableError);
        expect(() => canvasAuthzConfig(input)).to.throw(CapabilityTableError);
      });
    }
  });

  describe('loads through the authz-rbac config stores', () => {
    it('ConfigRoleStore reads the roles and ladders', async () => {
      const { roles, ladders } = await new ConfigRoleStore(configurationOf(config)).load();
      expect(roles.map((r) => r.name)).to.deep.equal(Object.keys(config.rbac.roles));
      expect(ladders.map((l) => l.name)).to.deep.equal(['project', 'org']);
      const viewer = roles.find((r) => r.name === 'viewer')!;
      expect(viewer.grants).to.have.length(9);
      expect(viewer.grants[2]).to.deep.equal({ permission: 'inspect:view', requiresTag: 'inspect' });
      expect(roles.find((r) => r.name === 'org.admin')!.implies).to.deep.equal(config.rbac.roles['org.admin'].implies);
      expect(roles.filter((r) => r.subjectSet).map((r) => r.name)).to.deep.equal(['org.member', 'group.member']);
    });

    it('ConfigRuleStore reads the rules from a list and from a Configuration', () => {
      const fromList = new ConfigRuleStore(config.rbac.rules as never).all();
      const fromConfig = new ConfigRuleStore(configurationOf(config)).all();
      expect(fromList.map((r) => r.id)).to.deep.equal([...RULE_IDS]);
      expect(fromConfig.map((r) => r.id)).to.deep.equal([...RULE_IDS]);
      for (const r of fromConfig) expect(r.scope).to.deep.equal({ type: '$global' });
    });
  });
});
