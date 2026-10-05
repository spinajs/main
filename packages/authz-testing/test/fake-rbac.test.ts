import { expect } from 'chai';
import 'mocha';

import { FALSE, GLOBAL, TRUE } from '@spinajs/authz';
import type { DecisionRequest, ResourceRef, Vote } from '@spinajs/authz';

import { FakeAdapter, FakePermissionRegistry, FakeRbacModel, evaluateFilter, fakeEvaluationContext, isAllowed, userPrincipal } from '../src/index.js';

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const project: ResourceRef = { type: 'project', id: 'p1' };
const file: ResourceRef = { type: 'file', id: 'f1' };
const other: ResourceRef = { type: 'file', id: 'f2' };

const registry = new FakePermissionRegistry(['file:read', 'file:write', 'file:delete', 'user:read']);
const adapter = new FakeAdapter({
  types: ['file'],
  rows: { file: [{ id: 'f1' }, { id: 'f2' }] },
  parents: [
    [file, project],
    [other, { type: 'project', id: 'p2' }],
  ],
});
const ctx = () => fakeEvaluationContext({ adapters: [adapter], permissions: registry });
const req = (principal = alice, permission = 'file:read', resource: ResourceRef = file): DecisionRequest => ({ principal, permission, resource });

const roles = {
  viewer: ['file:read'],
  editor: ['file:*', { permission: 'user:read', relation: 'self' }],
  owner: [{ permission: 'file:delete', relation: 'owner' }],
};

describe('FakeRbacModel', () => {
  it('a role at an ancestor of the resource permits; elsewhere no_access', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer', scope: project }] });
    expect(await m.evaluate(req(), ctx())).to.deep.eq({ model: 'rbac', permitWhen: TRUE, denyWhen: FALSE, cacheable: true });
    const denied = (await m.evaluate(req(alice, 'file:read', other), ctx())) as Vote;
    expect(denied.permitWhen).to.eq(FALSE);
    expect(denied.reason).to.deep.eq({ code: 'no_access', model: 'rbac' });
    expect(((await m.evaluate(req(bob), ctx())) as Vote).permitWhen).to.eq(FALSE);
    expect(((await m.evaluate(req(alice, 'file:write'), ctx())) as Vote).permitWhen).to.eq(FALSE);
  });

  it('a role at GLOBAL permits everywhere; scope defaults to GLOBAL', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'editor' }] });
    expect(((await m.evaluate(req(alice, 'file:write', other), ctx())) as Vote).permitWhen).to.eq(TRUE);
  });

  it('a grant with a relation yields a relation residual', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'owner', scope: project }] });
    expect(((await m.evaluate(req(alice, 'file:delete'), ctx())) as Vote).permitWhen).to.deep.eq({ op: 'relation', relation: 'owner' });
  });

  it('an unknown resource is no permit with reason unknown_resource', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer' }] });
    const v = (await m.evaluate(req(alice, 'file:read', { type: 'file', id: 'nope' }), ctx())) as Vote;
    expect(v.permitWhen).to.eq(FALSE);
    expect(v.reason).to.deep.eq({ code: 'unknown_resource', model: 'rbac' });
  });

  it('a type-level request answers synchronously with under over the assignment scopes, TRUE for GLOBAL', () => {
    const scoped = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer', scope: project }, { subject: alice, role: 'owner', scope: { type: 'project', id: 'p2' } }] });
    const typeLevel = (permission: string) => scoped.evaluate(req(alice, permission, { type: 'file' }), ctx()) as Vote;
    expect(typeLevel('file:read').permitWhen).to.deep.eq({ op: 'under', scopes: [project] });
    expect(typeLevel('file:delete').permitWhen).to.deep.eq({ op: 'and', args: [{ op: 'under', scopes: [{ type: 'project', id: 'p2' }] }, { op: 'relation', relation: 'owner' }] });
    const global = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer', scope: GLOBAL }] });
    expect((global.evaluate(req(alice, 'file:read', { type: 'file' }), ctx()) as Vote).permitWhen).to.eq(TRUE);
  });

  it('check ⇔ list: the type-level residual selects exactly the rows the concrete votes permit', async () => {
    const rows = new FakeAdapter({
      types: ['file'],
      rows: { file: [{ id: 'a', owner: 'alice' }, { id: 'b', owner: 'bob' }, { id: 'c', owner: 'alice' }, { id: 'd', owner: 'dave' }] },
      parents: [
        [{ type: 'file', id: 'a' }, project],
        [{ type: 'file', id: 'b' }, project],
        [{ type: 'file', id: 'c' }, { type: 'project', id: 'p2' }],
        [{ type: 'file', id: 'd' }, { type: 'project', id: 'p2' }],
      ],
      relations: [{ type: 'file', relation: 'owner', column: 'owner' }],
    });
    const m = new FakeRbacModel({
      roles,
      assignments: [
        { subject: alice, role: 'owner' },
        { subject: bob, role: 'viewer', scope: project },
        { subject: userPrincipal('carol'), role: 'editor' },
        { subject: userPrincipal('dave'), role: 'owner', scope: { type: 'project', id: 'p2' } },
      ],
    });
    const context = fakeEvaluationContext({ adapters: [rows], permissions: registry });
    const expected: Record<string, Record<string, string[]>> = {
      alice: { 'file:read': [], 'file:delete': ['a', 'c'] },
      bob: { 'file:read': ['a', 'b'], 'file:delete': [] },
      carol: { 'file:read': ['a', 'b', 'c', 'd'], 'file:delete': ['a', 'b', 'c', 'd'] },
      dave: { 'file:read': [], 'file:delete': ['d'] },
    };
    for (const who of Object.keys(expected)) {
      const principal = userPrincipal(who);
      for (const permission of ['file:read', 'file:delete']) {
        const residual = ((await m.evaluate(req(principal, permission, { type: 'file' }), context)) as Vote).permitWhen;
        const listed = (await rows.rows('file', residual, { principal, context })).map((r) => r.id);
        const checked: string[] = [];
        for (const row of rows.all('file')) {
          const ref = { type: 'file', id: row.id };
          const vote = (await m.evaluate(req(principal, permission, ref), context)) as Vote;
          if (isAllowed(await evaluateFilter(vote.permitWhen, row, { principal, ref, context }))) checked.push(row.id);
        }
        expect(listed, `${who} ${permission}`).to.deep.eq(checked);
        expect(checked, `${who} ${permission}`).to.deep.eq(expected[who][permission]);
      }
    }
  });

  it('check ⇔ list for a type-only assignment scope: it applies to rows under any node of that type', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer', scope: { type: 'project' } }] });
    const context = ctx();
    const residual = ((await m.evaluate(req(alice, 'file:read', { type: 'file' }), context)) as Vote).permitWhen;
    const listed = (await adapter.rows('file', residual, { principal: alice, context })).map((r) => r.id);
    const checked: string[] = [];
    for (const row of adapter.all('file')) {
      const ref = { type: 'file', id: row.id };
      const vote = (await m.evaluate(req(alice, 'file:read', ref), context)) as Vote;
      if (isAllowed(await evaluateFilter(vote.permitWhen, row, { principal: alice, ref, context }))) checked.push(row.id);
    }
    expect(checked).to.deep.eq(['f1', 'f2']);
    expect(listed).to.deep.eq(checked);
  });

  it('companions speak too', async () => {
    const link = { ...userPrincipal('l1'), type: 'link', companions: [{ type: 'user', id: 'alice' }] };
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer' }] });
    expect(((await m.evaluate(req(link), ctx())) as Vote).permitWhen).to.eq(TRUE);
  });

  it('routes only permissions some role grants; honest capabilities', () => {
    const m = new FakeRbacModel({ roles });
    expect(m.applies(registry.require('file:read'), 'file')).to.eq(true);
    expect(m.applies(registry.require('user:read'), 'user')).to.eq(true);
    expect(new FakeRbacModel({ roles: { viewer: ['file:read'] } }).applies(registry.require('user:read'), 'user')).to.eq(false);
    expect(m.capabilities).to.deep.eq({ effects: ['permit'], residuals: ['true', 'false', 'and', 'or', 'relation', 'under'], sync: 'always', fields: false, needsSubject: false });
  });

  it('assign / revoke bump the version', async () => {
    const m = new FakeRbacModel({ roles });
    const v0 = m.version();
    m.assign({ subject: alice, role: 'viewer', scope: project });
    expect(m.version()).to.not.eq(v0);
    expect(((await m.evaluate(req(), ctx())) as Vote).permitWhen).to.eq(TRUE);
    const v1 = m.version();
    m.revoke({ subject: alice, role: 'viewer', scope: project });
    expect(m.version()).to.not.eq(v1);
    expect(((await m.evaluate(req(), ctx())) as Vote).permitWhen).to.eq(FALSE);
  });

  it('summarize lists roles applying at the point and the permissions they grant', async () => {
    const m = new FakeRbacModel({ roles, assignments: [{ subject: alice, role: 'viewer', scope: project }, { subject: alice, role: 'owner' }, { subject: bob, role: 'editor' }] });
    const s = await m.summarize(alice, file, ctx());
    expect(s).to.deep.eq({
      model: 'rbac',
      roles: [
        { role: 'viewer', scope: project },
        { role: 'owner', scope: GLOBAL },
      ],
      permissions: [
        { name: 'file:read', conditional: false },
        { name: 'file:delete', conditional: true },
      ],
    });
    expect((await m.summarize(alice, GLOBAL, ctx())).roles).to.deep.eq([{ role: 'owner', scope: GLOBAL }]);
  });
});
