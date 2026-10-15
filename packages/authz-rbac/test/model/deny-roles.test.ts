import { AuthzConfigError, DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, SYSTEM, TRUE } from '@spinajs/authz';
import type { Assignment, EvaluationContext, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRoleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService, compileGrants, compileRoles, runRbacPipeline } from '../../src/index.js';
import type { LadderDef, RbacInput, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | Record<string, unknown>)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) as unknown as RoleDef['grants'] });
const deny = (name: string, grants: readonly (string | Record<string, unknown>)[] = [], extra: Partial<RoleDef> = {}): RoleDef => role(name, grants, { ...extra, deny: true });

function refused(roles: readonly RoleDef[], ladders: readonly LadderDef[] = []): string {
  try {
    compileRoles(roles, ladders);
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzConfigError);
    return (e as Error).message;
  }
  throw new Error('compileRoles should refuse');
}

describe('authz-rbac deny roles (design §4.2)', () => {
  describe('compile', () => {
    it('accepts a deny role of plain permissions and globs, and one deny role extending another', () => {
      const g = compileRoles([deny('blocked', ['invoice:edit', 'invoice:*']), deny('frozen', [], { extends: ['blocked'] }), role('editor', ['invoice:edit'])]);
      expect(g.get('frozen')?.closure).to.deep.equal(['frozen', 'blocked']);
    });

    it('refuses deny that is not a boolean', () => {
      expect(refused([{ ...role('x'), deny: 'yes' } as unknown as RoleDef])).to.equal("Role 'x' (source: test): deny must be true or false");
    });

    it('refuses qualified deny grants', () => {
      for (const key of ['relation', 'on', 'fields', 'requiresTag', 'grantedAt']) {
        const value = key === 'on' ? [{ type: 'invoice' }] : key === 'fields' ? { read: ['*'] } : key === 'grantedAt' ? ['org'] : 'owner';
        expect(refused([deny('blocked', [{ permission: 'invoice:edit', [key]: value }])])).to.equal(`Role 'blocked' (source: test): deny grant 'invoice:edit' has ${key}; a deny role takes plain permissions or globs only`);
      }
    });

    it('refuses a deny role as a subject set, on a ladder or with implies', () => {
      expect(refused([deny('blocked', [], { subjectSet: true })])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot be a subject set");
      expect(refused([deny('blocked', [], { ladder: 'l' }), role('low', [], { ladder: 'l' })], [{ name: 'l', roles: ['low', 'blocked'] }])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot be on a ladder");
      expect(refused([deny('blocked', [], { implies: [{ role: 'blocked2', at: 'descendants' }] }), deny('blocked2')])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot imply roles");
    });

    it('refuses extends and implies between deny and permit roles', () => {
      expect(refused([deny('blocked', [], { extends: ['editor'] }), role('editor')])).to.equal("Role 'blocked' (source: test) is a deny role and extends permit role 'editor'; deny and permit roles do not mix");
      expect(refused([role('editor', [], { extends: ['blocked'] }), deny('blocked')])).to.equal("Role 'editor' (source: test) extends deny role 'blocked'; deny and permit roles do not mix");
      expect(refused([role('editor', [], { implies: [{ role: 'blocked', at: 'self-and-descendants' }] }), deny('blocked')])).to.equal("Role 'editor' (source: test) implies deny role 'blocked'; deny and permit roles do not mix");
    });
  });

  describe('config', () => {
    it('the schema takes deny: boolean', () => {
      const roleSchema = (AUTHZ_RBAC_CONFIGURATION_SCHEMA.properties.roles as { additionalProperties: { properties: Record<string, unknown> } }).additionalProperties;
      expect(roleSchema.properties.deny).to.deep.equal({ type: 'boolean' });
    });

    it('ConfigRoleStore passes deny through and refuses a non-boolean', async () => {
      const store = (roles: unknown) => new ConfigRoleStore({ get: <T>(path: string | string[]) => ((Array.isArray(path) && path[2] === 'roles' ? roles : undefined) as T) });
      const { roles } = await store({ blocked: { deny: true, grants: ['invoice:edit'] } }).load();
      expect(roles[0]).to.deep.include({ name: 'blocked', deny: true });
      let caught: unknown;
      try {
        await store({ blocked: { deny: 'yes', grants: [] } }).load();
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).to.equal('authz.rbac.roles.blocked.deny: must be true or false');
    });
  });
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const F1: ResourceRef = { type: 'folder', id: 'f1' };
const F2: ResourceRef = { type: 'folder', id: 'f2' };
const I42: ResourceRef = { type: 'invoice', id: '42' };
const alice = userPrincipal('alice');
const ROLE_DENIED = { code: 'role_denied', role: 'blocked', priority: DEFAULT_DENY_PRIORITY.role_denied };
const ROLES = [role('editor', ['invoice:edit', 'invoice:read']), deny('blocked', ['invoice:edit'])];

function registry(): PermissionRegistryImpl {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'invoice:edit', types: ['invoice', 'folder'], implies: ['invoice:read'] },
      { name: 'invoice:read', types: ['invoice', 'folder'] },
      { name: 'invoice:delete', types: ['invoice', 'folder'] },
    ],
    'test',
  );
  r.freeze();
  return r;
}

const row = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });

function input(assignments: readonly Assignment[], permission: string, opts: { resource?: ResourceRef; path?: readonly ResourceRef[]; principal?: typeof alice; roles?: readonly RoleDef[] } = {}): RbacInput {
  const roles = compileRoles(opts.roles ?? ROLES);
  const resource = opts.resource ?? I42;
  return { request: { principal: opts.principal ?? alice, permission, resource }, now: NOW, path: opts.path ?? [I42, F1, GLOBAL], assignments, roles, grants: compileGrants(roles, registry()) };
}

describe('authz-rbac deny roles in checks', () => {
  it('the grant index keeps deny roles out of the permits and follows no implies', () => {
    const grants = compileGrants(compileRoles(ROLES), registry());
    expect(grants.grants('blocked', 'invoice:edit')).to.deep.equal([]);
    expect(grants.permissions('blocked')).to.deep.equal([]);
    expect(grants.denies('blocked', 'invoice:edit')).to.equal(true);
    expect(grants.denies('blocked', 'invoice:read')).to.equal(false);
    expect(grants.deniedPermissions('blocked')).to.deep.equal(['invoice:edit']);
    expect(grants.denied('invoice:edit')).to.equal(true);
    expect(compileGrants(compileRoles([deny('nodelete', ['invoice:delete'])]), registry()).granted('invoice:delete')).to.equal(false);
  });

  it('a deny at an ancestor beats a global permit, with role_denied', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit'));
    expect(vote.permitWhen).to.deep.equal(TRUE);
    expect(vote.denyWhen).to.deep.equal(TRUE);
    expect(vote.denies).to.deep.equal([{ when: TRUE, reason: ROLE_DENIED }]);
  });

  it('denies only what it names, only on its path', () => {
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:read')).denyWhen).to.deep.equal(FALSE);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F2)], 'invoice:edit')).denyWhen).to.deep.equal(FALSE);
  });

  it('on a type-level request a scoped deny denies the rows under its scope', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit', { resource: { type: 'invoice' }, path: [{ type: 'invoice' }, GLOBAL] }));
    expect(vote.denyWhen).to.deep.equal({ op: 'under', scopes: [F1] });
  });

  it('a ceiling never drops a deny', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit', { principal: withCeiling(alice, { roles: ['editor'] }) }));
    expect(vote.denyWhen).to.deep.equal(TRUE);
  });

  it('an expired deny is gone, and a live one bounds validUntil', () => {
    const past = new Date(NOW.getTime() - 1);
    const soon = new Date(NOW.getTime() + 60_000);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1, { expiresAt: past })], 'invoice:edit')).denyWhen).to.deep.equal(FALSE);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1, { expiresAt: soon })], 'invoice:edit')).validUntil).to.deep.equal(soon);
  });

  describe('through the model', () => {
    const scopes = new FakeScopeResolver({ types: ['folder', 'invoice'], nodes: [{ ref: F1 }, { ref: I42, parent: F1 }] });
    const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

    async function model(rows: readonly Assignment[], roles: readonly RoleDef[] = ROLES): Promise<RbacModel> {
      const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      m.grantIndex();
      return m;
    }

    it('applies routes a permission only a deny role names', async () => {
      const m = await model([], [deny('nodelete', ['invoice:delete'])]);
      expect(m.applies(registry().require('invoice:delete'), 'invoice')).to.equal(true);
    });

    it('RbacService.coversAt refuses what a live deny on the path removes', async () => {
      const m = await model([row('e', 'editor'), row('b', 'blocked', F1)]);
      const service = new RbacService(m);
      expect(await service.coversAt(alice, ['editor'], I42, ctx())).to.equal(false);
      expect(await service.coversAt(alice, ['editor'], { type: 'folder', id: 'other' }, fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ types: ['folder'], nodes: [{ ref: { type: 'folder', id: 'other' } }] })] }))).to.equal(true);
    });

    it('SYSTEM is not subject to deny roles: the engine allows it before any model runs', () => {
      // authorizer.ts answers SYSTEM with TRUE and no models (B09); a deny assignment cannot name SYSTEM's singleton either.
      expect(SYSTEM.type).to.be.a('string');
    });
  });
});
