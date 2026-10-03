import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { FALSE, TRUE, compilePermissionGlob } from '@spinajs/authz';
import type { AdminCallContext, Principal, ResourceRef } from '@spinajs/authz';

import { CheckRbacAdminFacts } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';
import { G, P1, START, StaticRoleStore, installHost, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
const grants = (...names: string[]) => names.map((permission) => ({ permission }));

const ROLES: RoleDef[] = [role('viewer', { ladder: 'project', grants: grants('file:read') }), role('editor', { ladder: 'project', grants: [{ permission: 'file:edit', relation: 'owner' }] }), role('maintainer', { ladder: 'project', grants: grants('project:settings') }), role('empty'), role('globber', { grants: grants('file:*') }), role('broken', { extends: ['ghost'] }), role('reader', { extends: ['viewer'] }), role('userAdmin', { grants: grants('users:update') })];
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'editor', 'maintainer'] },
  { name: 'bare', roles: ['empty'] },
];

/** alice: file:read and file:edit unconditionally, project:settings only conditionally, rank editor; anyone else nothing. */
function model(): StaticModel {
  return new StaticModel({
    name: 'facts',
    votes: (req): ScriptedVote => {
      if (req.principal.id !== 'alice') return {};
      const roles = { project: 'editor' };
      if (['file:read', 'file:edit', 'file:delete', 'users:update'].some((g) => compilePermissionGlob(g)(req.permission))) return { permitWhen: TRUE, roles };
      if (req.permission === 'project:settings') return { permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' }, roles };
      return { permitWhen: FALSE, roles };
    },
  });
}

describe('CheckRbacAdminFacts', function () {
  this.timeout(20000);
  let d: RbacDomain;
  const facts = new CheckRbacAdminFacts();
  const alice = userPrincipal('alice');
  const bob = userPrincipal('bob');

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    d = await rbacDomain('test', { roleStores: [new StaticRoleStore('facts', ROLES, LADDERS)], model: model(), permissions: { 'users:update': {} } });
  });

  const ctx = (actor: Principal = alice): AdminCallContext => ({ domain: 'test', now: START, authz: d.service, actor, container: d.container, dryRun: false });
  const covers = (r: string, at: ResourceRef = P1, actor: Principal = alice) => facts.covers(actor, r, at, ctx(actor));

  it('covers a role when every literal permission of its closure is allowed unconditionally', async () => {
    expect(await covers('viewer')).to.equal(true);
    expect(await covers('reader')).to.equal(true);
    expect(await covers('editor')).to.equal(true);
    expect(await covers('viewer', P1, bob)).to.equal(false);
  });

  it('a conditional allow does not cover', async () => {
    expect(await covers('maintainer')).to.equal(false);
  });

  it('a role that grants nothing is covered', async () => {
    expect(await covers('empty', P1, bob)).to.equal(true);
  });

  it('fails closed: a glob grant, an undefined role in the closure, a check that throws', async () => {
    expect(await covers('globber')).to.equal(false);
    expect(await covers('broken')).to.equal(false);
    expect(await covers('ghost')).to.equal(false);
    // users:update is not checkable on a project.
    expect(await covers('userAdmin', P1)).to.equal(false);
    expect(await covers('userAdmin', G)).to.equal(true);
  });

  it('effectiveRole reads Decision.roles of a check at the scope, denials included', async () => {
    expect(await facts.effectiveRole(alice, 'project', P1, ctx())).to.equal('editor');
    expect(await facts.effectiveRole(bob, 'project', P1, ctx(bob))).to.equal(undefined);
  });

  it('effectiveRole is undefined for an unknown ladder and for a ladder without a literal permission', async () => {
    expect(await facts.effectiveRole(alice, 'ghost', P1, ctx())).to.equal(undefined);
    expect(await facts.effectiveRole(alice, 'bare', P1, ctx())).to.equal(undefined);
  });
});
