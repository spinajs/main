import { AuthzConfigError, AUTHZ_CONFIGURATION_SCHEMA, PermissionRegistryImpl } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHZ_TOKEN_CONFIGURATION_SCHEMA, DEFAULT_ASSIGNMENTS_TTL_SECONDS, DEFAULT_GROUP_PRINCIPAL, DEFAULT_MAX_CACHED_SUBJECTS, DEFAULT_ROLES_CHECK_SECONDS, RoleStore, compileGrants, compileImplies, compileLadders, compileRoles, ladderEdges } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRoleStore, RBAC_STORE_DEFAULTS, RbacConfigBootstrapper, rbacStoreNames } from '../../src/stores/index.js';
import rbacStores from '../../src/config/rbac-stores.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The configuration package merges fragments with this customizer: arrays concatenate.
const mergeArrays = (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined);
const mergeFragments = (...fragments: object[]) => fragments.reduce((acc, f) => _.mergeWith(acc, _.cloneDeep(f), mergeArrays), {});

/** Configuration over a plain object, read with lodash paths as FrameworkConfiguration reads them. */
class ObjectConfiguration extends Configuration {
  constructor(private data: Record<string, unknown> = {}) {
    super();
  }
  public get RootConfig(): IConfigLike {
    return this.data as IConfigLike;
  }
  public get<T>(path: string[] | string, defaultValue?: T): T {
    return _.get(this.data, path, defaultValue) as T;
  }
  public set(path: string[] | string, value: unknown): void {
    _.set(this.data, path, value);
  }
  public merge(path: string[] | string, value: unknown): void {
    _.mergeWith(this.get(path), value, mergeArrays);
  }
  public async mergeSource(_source: Class<ConfigurationSource>): Promise<void> {}
  public async load(): Promise<void> {}
  protected onLoad(): unknown {
    return undefined;
  }
}

const storeFor = (rbac: unknown) => new ConfigRoleStore(new ObjectConfiguration({ authz: { rbac } }));
const rolesOf = async (rbac: unknown) => (await storeFor(rbac).load()).roles;
const role = (roles: readonly RoleDef[], name: string) => roles.find((r) => r.name === name)!;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function isDeepFrozen(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return true;
  return Object.isFrozen(v) && Object.values(v).every(isDeepFrozen);
}

// §8.2, authz.rbac part
const SAMPLE_8_2 = () => ({
  roles: {
    guest: { grants: [{ permission: 'user:read', relation: 'self', fields: { read: ['Login'] } }] },
    user: {
      grants: [
        { permission: 'user:read', relation: 'self', fields: { read: ['*', '!Password'] } },
        { permission: 'user:update', relation: 'self', fields: { write: ['Email', 'Password'] } },
        { permission: 'user.metadata:*', relation: 'owner' },
        { permission: 'fs:*', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] },
        { permission: 'fs:read', relation: 'owner', on: [{ type: 'fs', id: 'uploads' }] },
      ],
    },
    'admin.users': { assignable: false, grants: ['users:*', 'user.metadata:*'] },
    admin: { extends: ['admin.users'], grants: ['user:impersonate', 'authz:explain'] },
    'org.admin': { scopeTypes: ['org'], grants: ['org:*', 'project:*'] },
    'org.member': { scopeTypes: ['org'], grants: ['org:read', 'project:read'] },
  },
  ladders: {},
  rules: [],
  groupPrincipal: { role: 'group.member', scopeType: 'group' },
  defaultRoles: ['user'],
  anonymousRoles: ['guest'],
  serviceRoles: { 'service:telemetry': ['telemetry'] },
  stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['ConfigRuleStore'], links: ['DbLinkStore'] },
  cache: { assignmentsTtlSeconds: 60 },
  migration: { roleColumn: 'Role' },
});

const PW = ['project', 'org'];

// §8.5, authz.rbac part (rules shortened: L1b owns their schema)
const SAMPLE_8_5 = () => ({
  ladders: {
    project: { roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
    org: { roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
  },
  roles: {
    viewer: {
      ladder: 'project',
      grants: ['project:read', 'project:export', { permission: 'inspect:view', requiresTag: 'inspect' }, { permission: 'code:view', requiresTag: 'code' }, 'history:read', { permission: 'repo:read', grantedAt: PW }, 'presence:join', { permission: 'library:read', grantedAt: PW }, 'library:render'],
    },
    commenter: { ladder: 'project', grants: ['comment:create', 'comment:resolve', { permission: 'mr:comment', grantedAt: PW }] },
    editor: { ladder: 'project', grants: ['file:edit', 'version:save', 'version:restore', 'mr:approve', 'branch:create', 'mr:create', 'repo:push', 'file:manage', 'library:use', 'branch:merge', 'grants:invite'] },
    maintainer: { ladder: 'project', grants: ['library:publish', 'project:settings', 'grants:manage', 'project:delete'] },
    'org.file_guest': { ladder: 'org', grants: [] },
    'org.guest': { ladder: 'org', grants: [] },
    'org.member': { ladder: 'org', subjectSet: true, grants: [] },
    'org.admin': { ladder: 'org', grants: ['org:manage', 'audit:read'], implies: [{ role: 'maintainer', at: 'self-and-descendants', tags: ['inspect', 'code'], bypass: ['restrict', 'cap'] }] },
    'org.owner': { ladder: 'org', grants: ['org:billing'] },
    'group.member': { subjectSet: true, grants: [] },
  },
  rules: [{ id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } }],
  stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'], rules: ['ConfigRuleStore', 'DbRuleStore'], links: ['DbLinkStore'] },
});

describe('authz-rbac stores: ConfigRoleStore', function () {
  this.timeout(30000);
  it('is named ConfigRoleStore', () => {
    expect(storeFor({}).name).to.equal('ConfigRoleStore');
    expect(storeFor({})).to.be.instanceOf(RoleStore);
  });

  it('returns no roles and no ladders without config', async () => {
    expect(await new ConfigRoleStore(new ObjectConfiguration()).load()).to.deep.equal({ roles: [], ladders: [] });
    expect(await storeFor({}).load()).to.deep.equal({ roles: [], ladders: [] });
  });

  it('turns a string grant into { permission }', async () => {
    const roles = await rolesOf({ roles: { a: { grants: ['x:read', { permission: 'x:write', relation: 'owner' }] } } });
    expect(role(roles, 'a').grants).to.deep.equal([{ permission: 'x:read' }, { permission: 'x:write', relation: 'owner' }]);
  });

  it('fills the defaults and adds no optional keys', async () => {
    const roles = await rolesOf({ roles: { a: {} } });
    expect(roles).to.deep.equal([{ name: 'a', extends: [], grants: [], assignable: true, source: 'config' }]);
  });

  it('keeps the role order of the config', async () => {
    const roles = await rolesOf({ roles: { b: {}, a: {}, c: {} } });
    expect(roles.map((r) => r.name)).to.deep.equal(['b', 'a', 'c']);
  });

  it('passes every optional field through', async () => {
    const roles = await rolesOf({
      roles: {
        full: {
          ladder: 'project',
          extends: ['base'],
          grants: [{ permission: 'doc:read', relation: ['owner', 'self'], on: [{ type: 'doc', id: 'd-*' }, { type: 'dir' }], fields: { read: ['*'], write: ['Title'], hide: ['Secret'] }, requiresTag: 'pro', grantedAt: ['project'] }],
          implies: [
            { role: 'viewer', at: 'descendants', tags: ['a'], bypass: ['restrict'] },
            { role: 'other', at: 'self-and-descendants' },
          ],
          subjectSet: true,
          assignable: false,
          scopeTypes: ['project', 'org'],
          description: 'Everything',
        },
      },
    });
    expect(roles).to.deep.equal([
      {
        name: 'full',
        ladder: 'project',
        extends: ['base'],
        grants: [{ permission: 'doc:read', relation: ['owner', 'self'], on: [{ type: 'doc', id: 'd-*' }, { type: 'dir' }], fields: { read: ['*'], write: ['Title'], hide: ['Secret'] }, requiresTag: 'pro', grantedAt: ['project'] }],
        implies: [
          { role: 'viewer', at: 'descendants', tags: ['a'], bypass: ['restrict'] },
          { role: 'other', at: 'self-and-descendants' },
        ],
        subjectSet: true,
        assignable: false,
        scopeTypes: ['project', 'org'],
        description: 'Everything',
        source: 'config',
      },
    ]);
  });

  it('applies revoke after the fragments merge, on exact permission strings', async () => {
    const pkg = { authz: { rbac: { roles: { user: { grants: ['user.tokens:delete', 'user:read', { permission: 'user.tokens:delete', relation: 'self' }, 'user.tokens:*'] } } } } };
    const app = { authz: { rbac: { roles: { user: { revoke: ['user.tokens:delete'], grants: ['app:use'] } } } } };
    const merged = mergeFragments(pkg, app);
    expect(_.get(merged, 'authz.rbac.roles.user.grants')).to.have.length(5);

    const { roles } = await new ConfigRoleStore(new ObjectConfiguration(merged as Record<string, unknown>)).load();
    const user = role(roles, 'user');
    expect(user.grants).to.deep.equal([{ permission: 'user:read' }, { permission: 'user.tokens:*' }, { permission: 'app:use' }]);
    expect(user).to.not.have.property('revoke');
  });

  it('revokes only on the role that lists it, and a revoke that matches nothing is a no-op', async () => {
    const roles = await rolesOf({ roles: { a: { grants: ['x:read'], revoke: ['x:read', 'y:read'] }, b: { grants: ['x:read'] } } });
    expect(role(roles, 'a').grants).to.deep.equal([]);
    expect(role(roles, 'b').grants).to.deep.equal([{ permission: 'x:read' }]);
  });

  it('maps ladders with the name from the key', async () => {
    const { ladders } = await storeFor(SAMPLE_8_5()).load();
    expect(ladders).to.deep.equal([
      { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
      { name: 'org', roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
    ]);
  });

  it('reads the §8.2 and §8.5 samples', async () => {
    const a = await storeFor(SAMPLE_8_2()).load();
    expect(a.roles.map((r) => r.name)).to.deep.equal(['guest', 'user', 'admin.users', 'admin', 'org.admin', 'org.member']);
    expect(role(a.roles, 'admin.users')).to.deep.equal({ name: 'admin.users', extends: [], grants: [{ permission: 'users:*' }, { permission: 'user.metadata:*' }], assignable: false, source: 'config' });
    expect(role(a.roles, 'user').grants[3]).to.deep.equal({ permission: 'fs:*', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] });

    const b = await storeFor(SAMPLE_8_5()).load();
    expect(b.roles).to.have.length(10);
    expect(role(b.roles, 'viewer').grants[5]).to.deep.equal({ permission: 'repo:read', grantedAt: ['project', 'org'] });
    expect(role(b.roles, 'org.member').subjectSet).to.equal(true);
  });

  it('deep-freezes the result and does not alias the config', async () => {
    const rbac = SAMPLE_8_5();
    const store = storeFor(rbac);
    const out = await store.load();
    expect(isDeepFrozen(out)).to.equal(true);

    const viewer = role(out.roles, 'viewer');
    expect(viewer.grants[5].grantedAt).to.not.equal(PW);
    expect(out.ladders[0].roles).to.not.equal(rbac.ladders.project.roles);

    rbac.roles.viewer.grants.push('extra:read');
    rbac.ladders.project.roles.push('owner');
    (rbac.roles['org.admin'].implies[0].tags as string[]).push('x');
    expect(viewer.grants).to.have.length(9);
    expect(out.ladders[0].roles).to.have.length(4);
    expect(role(out.roles, 'org.admin').implies![0].tags).to.deep.equal(['inspect', 'code']);
    expect(Object.isFrozen(rbac.roles.viewer)).to.equal(false);
  });

  it('reads the config again on every load', async () => {
    const cfg = new ObjectConfiguration({ authz: { rbac: { roles: { a: {} } } } });
    const store = new ConfigRoleStore(cfg);
    expect((await store.load()).roles).to.have.length(1);
    cfg.set('authz.rbac.roles.b', {});
    expect((await store.load()).roles).to.have.length(2);
  });

  describe('version', () => {
    it('is a sha256 hex string, the same for the same config', async () => {
      const v = await storeFor(SAMPLE_8_5()).version();
      expect(v).to.match(/^[0-9a-f]{64}$/);
      expect(await storeFor(SAMPLE_8_5()).version()).to.equal(v);
      expect(await storeFor({}).version()).to.equal(await new ConfigRoleStore(new ObjectConfiguration()).version());
      expect(await storeFor({ roles: {}, ladders: {} }).version()).to.equal(await storeFor({}).version());
    });

    it('does not change when object keys are reordered', async () => {
      const a = { roles: { a: { grants: [{ permission: 'x', relation: 'self' }], assignable: false }, b: {} }, ladders: { l: { roles: ['a'], resourceTypes: ['t'] } } };
      const b = { ladders: { l: { resourceTypes: ['t'], roles: ['a'] } }, roles: { b: {}, a: { assignable: false, grants: [{ relation: 'self', permission: 'x' }] } } };
      expect(await storeFor(a).version()).to.equal(await storeFor(b).version());
    });

    it('ignores the other authz.rbac keys', async () => {
      expect(await storeFor({ roles: { a: {} }, stores: { roles: ['X'] } }).version()).to.equal(await storeFor({ roles: { a: {} } }).version());
    });

    it('changes with any value of roles or ladders', async () => {
      const base = await storeFor({ roles: { a: { grants: ['x'] } }, ladders: { l: { roles: ['a', 'b'] } } }).version();
      const variants = [{ roles: { a: { grants: ['y'] } }, ladders: { l: { roles: ['a', 'b'] } } }, { roles: { a: { grants: ['x', 'y'] } }, ladders: { l: { roles: ['a', 'b'] } } }, { roles: { a: { grants: ['x'], assignable: false } }, ladders: { l: { roles: ['a', 'b'] } } }, { roles: { b: { grants: ['x'] } }, ladders: { l: { roles: ['a', 'b'] } } }, { roles: { a: { grants: ['x'] } }, ladders: { l: { roles: ['b', 'a'] } } }, { roles: { a: { grants: ['x'] } }, ladders: { m: { roles: ['a', 'b'] } } }, { roles: { a: { grants: ['x'] } } }];
      const versions = await Promise.all(variants.map((v) => storeFor(v).version()));
      for (const v of versions) expect(v).to.not.equal(base);
      expect(new Set(versions).size).to.equal(versions.length);
    });
  });

  // The schema refuses every malformed shape at boot. A value it never saw (Configuration.set, the constructor seam)
  // must still never read as a broader role: the store refuses what would widen one, the model compile the rest.
  describe('values the schema never saw', () => {
    const refuses = async (rbac: unknown, path: string) => {
      const e = await rejection(storeFor(rbac).load());
      expect(e, JSON.stringify(rbac)).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.contain(path);
    };

    it('refuses roles and ladders that are not maps of objects', async () => {
      await refuses({ roles: [] }, 'authz.rbac.roles');
      await refuses({ roles: 'admin' }, 'authz.rbac.roles');
      await refuses({ ladders: [] }, 'authz.rbac.ladders');
      await refuses({ roles: { a: 'x' } }, 'authz.rbac.roles.a');
      await refuses({ roles: { a: new Date() } }, 'authz.rbac.roles.a');
      await refuses({ ladders: { l: null } }, 'authz.rbac.ladders.l');
    });

    it('refuses an unknown key, which would drop the restriction it misspells', async () => {
      await refuses({ roles: { a: { grants: ['x:read'], revok: ['x:read'] } } }, 'authz.rbac.roles.a.revok');
      await refuses({ roles: { a: { scopeType: ['org'] } } }, 'authz.rbac.roles.a.scopeType');
      await refuses({ roles: { a: { name: 'b' } } }, 'authz.rbac.roles.a.name');
      await refuses({ roles: { a: { grants: [{ permission: 'x:read', relations: 'self' }] } } }, 'authz.rbac.roles.a.grants[0].relations');
      await refuses({ roles: { a: { grants: [{ permission: 'x:read', onn: [{ type: 'doc', id: 'd1' }] }] } } }, 'authz.rbac.roles.a.grants[0].onn');
      await refuses({ roles: { a: { grants: [{ permission: 'x:read', requiresTags: 'pro' }] } } }, 'authz.rbac.roles.a.grants[0].requiresTags');
      await refuses({ ladders: { l: { roles: ['a'], resourceType: ['project'] } } }, 'authz.rbac.ladders.l.resourceType');
    });

    it('refuses a revoke that is not a list of permissions, which would revoke nothing', async () => {
      for (const revoke of ['x:read', null, [1], { 'x:read': true }]) await refuses({ roles: { a: { grants: ['x:read'], revoke } } }, 'authz.rbac.roles.a.revoke');
    });

    it('refuses grants that are not a list of permissions and grant objects', async () => {
      await refuses({ roles: { a: { grants: 'x:read' } } }, 'authz.rbac.roles.a.grants');
      await refuses({ roles: { a: { grants: null } } }, 'authz.rbac.roles.a.grants');
      await refuses({ roles: { a: { grants: ['x:read', 42] } } }, 'authz.rbac.roles.a.grants[1]');
      await refuses({ roles: { a: { grants: ['x:read', null] } } }, 'authz.rbac.roles.a.grants[1]');
      await refuses({ roles: { a: { grants: [['x:read']] } } }, 'authz.rbac.roles.a.grants[0]');
    });

    it('refuses a grantedAt that is not a list of scope types, which the model reads as no check or as a substring match', async () => {
      for (const grantedAt of ['project', null, [1]]) await refuses({ roles: { a: { grants: [{ permission: 'x:read', grantedAt }] } } }, 'authz.rbac.roles.a.grants[0].grantedAt');
    });

    it('refuses the role and ladder fields AuthzAdmin reads without the model compile, where they would read broader', async () => {
      for (const assignable of ['false', 'yes', null, 0]) await refuses({ roles: { a: { assignable } } }, 'authz.rbac.roles.a.assignable');
      for (const scopeTypes of ['project', null, [1]]) await refuses({ roles: { a: { scopeTypes } } }, 'authz.rbac.roles.a.scopeTypes');
      for (const l of [{}, { roles: 'viewer' }, { roles: null }, { roles: [1] }]) await refuses({ ladders: { l } }, 'authz.rbac.ladders.l.roles');
      for (const resourceTypes of ['project', null, [1]]) await refuses({ ladders: { l: { roles: ['a'], resourceTypes } } }, 'authz.rbac.ladders.l.resourceTypes');
    });

    it('hands the other malformed values to the model compile, which refuses them', async () => {
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'x:read' }, { name: 'x:write', fields: true }], 'test');
      registry.freeze();
      const compiles = async (rbac: unknown) => {
        const { roles, ladders } = await storeFor(rbac).load();
        const graph = compileRoles(roles, ladders, { extraEdges: ladderEdges });
        compileLadders(graph, compileGrants(graph, registry));
        compileImplies(graph);
      };
      const malformed: unknown[] = [
        { roles: { a: { grants: [''] } } },
        { roles: { a: { grants: [{ relation: 'self' }] } } },
        { roles: { a: { grants: [{ permission: 5 }] } } },
        { roles: { a: { grants: [{ permission: 'x:read', on: [{ id: 'y' }] }] } } },
        { roles: { a: { grants: [{ permission: 'x:read', on: [{ type: 'doc', idd: 'y' }] }] } } },
        { roles: { a: { grants: [{ permission: 'x:read', on: [] }] } } },
        { roles: { a: { grants: [{ permission: 'x:read', relation: 5 }] } } },
        { roles: { a: { grants: [{ permission: 'x:write', fields: { read: 'a' } }] } } },
        { roles: { a: { grants: [{ permission: 'x:write', fields: { reed: ['a'] } }] } } },
        { roles: { a: { extends: 'b' } } },
        { roles: { a: { extends: null } } },
        { roles: { a: { ladder: 5 } } },
        { roles: { a: { implies: [{ role: 'b', at: 'everywhere' }] }, b: {} } },
        { roles: { a: { implies: [{ role: 'b', at: 'descendants', bypass: ['ceiling'] }] }, b: {} } },
        { roles: { a: { implies: [{ role: 'b', at: 'descendants', tags: [1] }] }, b: {} } },
        { roles: { a: { implies: { role: 'b', at: 'descendants' } }, b: {} } },
      ];
      for (const rbac of malformed) expect(await rejection(compiles(rbac)), JSON.stringify(rbac)).to.be.instanceOf(AuthzConfigError);
      await compiles({ roles: { a: { ladder: 'l', grants: ['x:read'] }, b: { implies: [{ role: 'a', at: 'descendants' }] } }, ladders: { l: { roles: ['a'] } } });
    });
  });
});

describe('authz-rbac stores: ConfigRoleStore in DI', function () {
  this.timeout(30000);
  it('is registered under its class name only, not as a RoleStore every domain would read', () => {
    const names = (DI.RootContainer.Registry.getTypesChain(RoleStore) ?? []).map((e) => (typeof e.type === 'function' ? e.type.name : ''));
    expect(names).to.not.include('ConfigRoleStore');
    expect(DI.RootContainer.hasRegistered('ConfigRoleStore')).to.equal(true);
  });

  it('resolves with the Configuration of its container', async () => {
    const child = DI.child();
    try {
      child
        .register(
          class extends ObjectConfiguration {
            constructor() {
              super({ authz: { rbac: { roles: { a: { grants: ['x'] } } } } });
            }
          },
        )
        .as(Configuration);
      await child.resolve(Configuration);
      child.register(ConfigRoleStore).as(RoleStore);
      const store = (await child.resolve(RoleStore)) as RoleStore;
      expect(store).to.be.instanceOf(ConfigRoleStore);
      expect((await store.load()).roles.map((r) => r.name)).to.deep.equal(['a']);
    } finally {
      await child.dispose();
    }
  });

  it('reads authz.rbac.roles and ladders through @Config of its container', async () => {
    const { child } = await bootConfiguration({ authz: { rbac: { roles: { a: { grants: ['x:read'] } }, ladders: { l: { roles: ['a'] } } } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    try {
      child.register(ConfigRoleStore).as(RoleStore);
      const store = (await child.resolve(RoleStore)) as ConfigRoleStore;

      expect((store as unknown as { Roles: unknown }).Roles).to.deep.equal({ a: { grants: ['x:read'] } });
      expect(await store.load()).to.deep.equal({
        roles: [{ name: 'a', extends: [], grants: [{ permission: 'x:read' }], assignable: true, source: 'config' }],
        ladders: [{ name: 'l', roles: ['a'] }],
      });
    } finally {
      await child.dispose();
    }
  });
});

const bootRbac = (rbac: unknown) => bootConfiguration({ authz: { rbac } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);

/** authz.rbac as the configuration holds it after the boot validated it. */
async function configured(rbac: unknown): Promise<Record<string, unknown>> {
  const { child, configuration } = await bootRbac(rbac);
  try {
    return configuration.get(['authz', 'rbac']);
  } finally {
    await child.dispose();
  }
}

describe('authz-rbac stores: authz.rbac schema', function () {
  this.timeout(30000);
  it('declares its module and id', () => {
    expect(AUTHZ_RBAC_CONFIGURATION_SCHEMA.$configurationModule).to.equal('authz.rbac');
    expect(AUTHZ_RBAC_CONFIGURATION_SCHEMA.$id).to.equal('spinajs/authz-rbac.configuration.schema.json');
    expect(AUTHZ_RBAC_CONFIGURATION_SCHEMA.$id).to.not.equal(AUTHZ_CONFIGURATION_SCHEMA.$id);
  });

  it('defaults what the RBAC model reads to the code defaults', async () => {
    expect(await configured({})).to.deep.equal({
      groupPrincipal: DEFAULT_GROUP_PRINCIPAL,
      anonymousRoles: [],
      serviceRoles: {},
      cache: { assignmentsTtlSeconds: DEFAULT_ASSIGNMENTS_TTL_SECONDS, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS },
    });
  });

  it('accepts the §8.2 and §8.5 samples and adds only the model defaults', async () => {
    const defaults = {
      groupPrincipal: DEFAULT_GROUP_PRINCIPAL,
      anonymousRoles: [],
      serviceRoles: {},
      cache: { assignmentsTtlSeconds: DEFAULT_ASSIGNMENTS_TTL_SECONDS, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS },
    };
    for (const sample of [SAMPLE_8_2(), SAMPLE_8_5(), {}]) {
      expect(await configured(sample)).to.deep.equal(_.merge({}, defaults, sample));
    }
  });

  it('accepts connection, migration.idColumn and keeps keys of other lanes', async () => {
    const cfg = await configured({ connection: 'authz', migration: { roleColumn: 'Role', idColumn: 'Uuid' }, admin: { x: 1 }, future: { y: true }, stores: { roles: ['A'], policies: ['B'] } });
    expect(cfg.admin).to.deep.equal({ x: 1 });
    expect(cfg.future).to.deep.equal({ y: true });
    expect((cfg.stores as Record<string, unknown>).policies).to.deep.equal(['B']);
  });

  it('rejects bad shapes, naming the full path', async () => {
    const fails = async (rbac: unknown, path: string) => expect(await violationPaths(bootRbac(rbac)), JSON.stringify(rbac)).to.include(`authz.rbac.${path}`);
    // coerceTypes turns numbers and booleans into strings, so only arrays and null stay non-grants
    await fails({ roles: { a: { grants: [['x']] } } }, 'roles.a.grants.0');
    await fails({ roles: { a: { grants: [null] } } }, 'roles.a.grants.0');
    await fails({ roles: { a: { grants: [{ relation: 'self' }] } } }, 'roles.a.grants.0');
    await fails({ roles: { a: { assignable: 'yes' } } }, 'roles.a.assignable');
    await fails({ roles: { a: { subjectSet: 'maybe' } } }, 'roles.a.subjectSet');
    await fails({ roles: { a: { grant: [] } } }, 'roles.a.grant');
    await fails({ roles: { a: { implies: [{ role: 'b', at: 'up' }] } } }, 'roles.a.implies.0.at');
    await fails({ roles: { a: { implies: [{ role: 'b' }] } } }, 'roles.a.implies.0.at');
    await fails({ roles: { a: { revoke: 'x' } } }, 'roles.a.revoke');
    await fails({ roles: [] }, 'roles');
    await fails({ ladders: { project: { roles: 'viewer' } } }, 'ladders.project.roles');
    await fails({ ladders: { project: {} } }, 'ladders.project.roles');
    await fails({ rules: [1] }, 'rules.0');
    await fails({ rules: {} }, 'rules');
    await fails({ groupPrincipal: { role: '' } }, 'groupPrincipal.role');
    await fails({ defaultRoles: 'user' }, 'defaultRoles');
    await fails({ anonymousRoles: [['guest']] }, 'anonymousRoles.0');
    await fails({ serviceRoles: { 'service:x': 'a' } }, 'serviceRoles.service:x');
    await fails({ stores: { roles: 'ConfigRoleStore' } }, 'stores.roles');
    await fails({ stores: { links: [''] } }, 'stores.links.0');
    await fails({ cache: { assignmentsTtlSeconds: -1 } }, 'cache.assignmentsTtlSeconds');
    await fails({ cache: { maxSubjects: 1.5 } }, 'cache.maxSubjects');
    await fails({ cache: { rolesCheckSeconds: -1 } }, 'cache.rolesCheckSeconds');
    await fails({ migration: { roleColumn: '' } }, 'migration.roleColumn');
    await fails({ connection: '' }, 'connection');
  });

  describe('role names follow ROLE_NAME_PATTERN, the one authz and users read too', () => {
    const paths = async (rbac: unknown) => violationPaths(bootRbac(rbac));

    it('refuses a leading digit, true/false, edge whitespace and values coercion would turn into a name', async () => {
      const cases: Array<[unknown, string]> = [
        [{ roles: { '7up': {} } }, 'roles.7up'],
        [{ roles: { true: {} } }, 'roles.true'],
        [{ roles: { ' admin': {} } }, 'roles. admin'],
        [{ roles: { a: { extends: [5] } } }, 'roles.a.extends.0'],
        [{ roles: { a: { implies: [{ role: 'false', at: 'descendants' }] } } }, 'roles.a.implies.0.role'],
        [{ ladders: { project: { roles: ['viewer', 'admin '] } } }, 'ladders.project.roles.1'],
        [{ groupPrincipal: { role: '1group' } }, 'groupPrincipal.role'],
        [{ defaultRoles: [7] }, 'defaultRoles.0'],
        [{ anonymousRoles: [false] }, 'anonymousRoles.0'],
        [{ serviceRoles: { 'service:x': [' x'] } }, 'serviceRoles.service:x.0'],
      ];
      for (const [rbac, path] of cases) expect(await paths(rbac), JSON.stringify(rbac)).to.include(`authz.rbac.${path}`);

      const rule = (extra: Record<string, unknown>) => ({ rules: [{ id: 'r1', scope: { type: 'org', id: 'o1' }, ...extra }] });
      for (const rbac of [
        rule({ kind: 'cap', ladder: 'org', maxRole: 'true' }),
        rule({ kind: 'threshold', permissions: ['x:y'], minRole: '2nd' }),
        rule({ kind: 'restrict', allow: [{ set: { role: ' member', scope: { type: 'org', id: 'o1' } } }] }),
        rule({ kind: 'cap', ladder: 'org', maxRole: 'org.viewer', subjects: { rank: { ladder: 'org', at: 'org', lt: '0' } } }),
      ]) {
        expect((await paths(rbac)).some((p) => p.startsWith('authz.rbac.rules.0.')), JSON.stringify(rbac)).to.equal(true);
      }
    });

    it('accepts a 2.x role name with an inner space, as the converter writes it', async () => {
      const rbac = { roles: { 'Stock editor': {}, 'acme.salesman': { extends: ['Stock editor'] } }, ladders: { desk: { roles: ['Stock editor'] } }, defaultRoles: ['Stock editor'], anonymousRoles: ['acme.salesman'] };
      expect(await configured(rbac)).to.deep.include(rbac);
    });
  });
});

describe('authz-rbac stores: config fragment', function () {
  this.timeout(30000);
  it('ships only the cache default of §8.2 (store names and migration columns live in code)', () => {
    expect(rbacStores).to.deep.equal({
      authz: {
        rbac: {
          cache: { assignmentsTtlSeconds: 60 },
        },
      },
    });
  });

  it('passes the schema', async () => {
    expect((await configured(rbacStores.authz.rbac)).cache).to.deep.equal({ ...rbacStores.authz.rbac.cache, maxSubjects: DEFAULT_MAX_CACHED_SUBJECTS, rolesCheckSeconds: DEFAULT_ROLES_CHECK_SECONDS });
  });

  it('compiles to a file the configuration loads (lib/<mode>/config, no dot in the base name)', () => {
    expect(existsSync(join(PKG_ROOT, 'lib', 'mjs', 'config', 'rbac-stores.js'))).to.equal(true);
  });
});

describe('authz-rbac stores: schema registration', function () {
  this.timeout(30000);
  it('the bootstrapper registers the rbac and token schemas as __configurationSchema__ values', () => {
    const KEY = '__configurationSchema__';
    const had = DI.RootContainer.Cache.has(KEY);
    new RbacConfigBootstrapper().bootstrap();
    try {
      expect(DI.RootContainer.Cache.get(KEY)).to.include.members([AUTHZ_RBAC_CONFIGURATION_SCHEMA, AUTHZ_TOKEN_CONFIGURATION_SCHEMA]);
    } finally {
      const list = DI.RootContainer.Cache.get(KEY) as unknown[];
      for (const schema of [AUTHZ_RBAC_CONFIGURATION_SCHEMA, AUTHZ_TOKEN_CONFIGURATION_SCHEMA]) list.splice(list.indexOf(schema), 1);
      if (!had && list.length === 0) DI.uncache(KEY);
    }
  });

  describe('with the core schema in a real FrameworkConfiguration', () => {
    const LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

    async function boot(authz: object): Promise<Configuration> {
      const config = mergeFragments(rbacStores, { authz }, { logger: LOGGER });
      const child = DI.child();
      child.register(AUTHZ_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(AUTHZ_RBAC_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      // No file sources: the config comes only from onLoad, so no other package fragment takes part.
      child
        .register(
          class extends FrameworkConfiguration {
            protected loadSources() {
              this.Sources = [];
            }
            protected onLoad() {
              return _.cloneDeep(config);
            }
          },
        )
        .as(Configuration);
      try {
        return (await child.resolve(Configuration)) as Configuration;
      } finally {
        await child.dispose();
      }
    }

    it('validates authz.rbac next to authz and merges the fragment defaults', async () => {
      const cfg = await boot({ combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } }, rbac: SAMPLE_8_5() });
      expect(cfg.get('authz.rbac.cache.assignmentsTtlSeconds')).to.equal(60);
      expect(cfg.get('authz.rbac.migration')).to.equal(undefined);
      // the app's list replaces the code default, so no store name appears twice
      expect(cfg.get('authz.rbac.stores.rules')).to.deep.equal(['ConfigRuleStore', 'DbRuleStore']);
      expect(rbacStoreNames(cfg, 'rules')).to.deep.equal(['ConfigRuleStore', 'DbRuleStore']);
      expect(rbacStoreNames(cfg, 'links')).to.deep.equal(['DbLinkStore']);
      const { roles, ladders } = await new ConfigRoleStore(cfg).load();
      expect(roles).to.have.length(10);
      expect(ladders).to.have.length(2);
    });

    it('fails the boot on a bad authz.rbac shape', async () => {
      const e = await rejection(boot({ rbac: { ladders: { project: { roles: 'viewer' } } } }));
      expect(e).to.be.instanceOf(InvalidConfiguration);
      expect((e as InvalidConfiguration).validationExceptions!.some((v) => v.instancePath === '/ladders/project/roles')).to.equal(true);
    });

    it('still fails the boot on a bad core key', async () => {
      const e = await rejection(boot({ engine: { modelTimeoutMs: 0 } }));
      expect(e).to.be.instanceOf(InvalidConfiguration);
    });
  });
});

describe('authz-rbac stores: store names', function () {
  this.timeout(30000);
  const cfg = (stores?: object) => ({ get: (p: string[]) => _.get({ authz: { rbac: { stores } } }, p) } as unknown as Configuration);

  it('defaults to the §8.2 store names when the app sets none', () => {
    expect(rbacStoreNames(cfg(), 'roles')).to.deep.equal(['ConfigRoleStore']);
    expect(rbacStoreNames(cfg(), 'assignments')).to.deep.equal(['DbAssignmentStore']);
    expect(rbacStoreNames(cfg(), 'rules')).to.deep.equal(['ConfigRuleStore']);
    expect(rbacStoreNames(cfg(), 'links')).to.deep.equal(['DbLinkStore']);
    expect(Object.isFrozen(RBAC_STORE_DEFAULTS.rules)).to.equal(true);
  });

  it('an app list replaces the default and loses duplicates', () => {
    expect(rbacStoreNames(cfg({ rules: ['DbRuleStore', 'ConfigRuleStore', 'DbRuleStore'] }), 'rules')).to.deep.equal(['DbRuleStore', 'ConfigRuleStore']);
    expect(rbacStoreNames(cfg({ rules: [] }), 'rules')).to.deep.equal([]);
  });

  it('the schema takes a links secret of at least 32 characters', async () => {
    expect((await configured({ links: { secret: 'x'.repeat(32) } })).links).to.deep.equal({ secret: 'x'.repeat(32) });
    expect(await violationPaths(bootRbac({ links: { secret: 'short' } }))).to.include('authz.rbac.links.secret');
  });
});
