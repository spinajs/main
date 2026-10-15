import { AuthzConfigError } from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRoleStore, compileRoles } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';

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
