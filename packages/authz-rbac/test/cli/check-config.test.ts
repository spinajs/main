import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { META_OPTION } from '@spinajs/cli';
import type { IOption } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';

import { CheckConfigCommand } from '../../src/cli/index.js';
import { RoleStore } from '../../src/contracts.js';
import { ConfigRoleStore } from '../../src/stores/index.js';
import { capture, fakeAuthz } from './fixture.js';
import type { Captured } from './fixture.js';

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
  public merge(): void {}
  public async mergeSource(_source: Class<ConfigurationSource>): Promise<void> {}
  public async load(): Promise<void> {}
  protected onLoad(): unknown {
    return undefined;
  }
}

function command(rbac: unknown): { cmd: CheckConfigCommand; calls: ReturnType<typeof fakeAuthz>['runAs'] } {
  const f = fakeAuthz();
  const cmd = new CheckConfigCommand();
  cmd.Container = DI.RootContainer;
  cmd.Authz = f.service;
  cmd.Roles = new ConfigRoleStore(new ObjectConfiguration({ authz: { rbac } }));
  return { cmd, calls: f.runAs };
}

const GOOD = {
  ladders: { project: { roles: ['viewer', 'editor'] } },
  roles: { viewer: { ladder: 'project', grants: ['doc:read'] }, editor: { ladder: 'project', grants: [{ permission: 'doc:write', on: [{ type: 'doc' }], requiresTag: 'beta' }] } },
};

describe('authz:check-config', () => {
  let io: Captured;
  beforeEach(() => (io = capture()));
  afterEach(() => io.restore());

  it('prints OK with counts, inside runAs(SYSTEM, cli)', async () => {
    const { cmd, calls } = command(GOOD);
    await cmd.execute({});
    expect(io.out).to.deep.equal(['OK: 2 role(s), 1 ladder(s)']);
    expect(io.exitCode()).to.equal(undefined);
    expect(calls).to.have.length(1);
    expect(calls[0].reason).to.equal('cli');
  });

  it('prints the config error and exits 1 when a role store refuses its configuration', async () => {
    const { cmd } = command(GOOD);
    cmd.Roles = new (class extends RoleStore {
      readonly name = 'RefusingRoleStore';
      async load(): Promise<never> {
        throw new AuthzConfigError('authz.rbac.roles.viewer: role ghost is not defined');
      }
      async version(): Promise<string> {
        return 'v';
      }
    })();
    await cmd.execute({});
    expect(io.err).to.have.length(1);
    expect(io.err[0]).to.contain('authz.rbac.roles.viewer');
    expect(io.exitCode()).to.equal(1);
    expect(io.out).to.deep.equal([]);
  });

  it('declares only --explain-role: the unattended report is authz:audit-unattended in authz-orm', () => {
    expect((Reflect.getMetadata(META_OPTION, CheckConfigCommand) as IOption[]).map((o) => o.flags)).to.deep.equal(['--explain-role <role>']);
  });

  it('prints the boot error of AuthzService and exits 1', async () => {
    const { cmd } = command(GOOD);
    cmd.Authz = {
      runAs: async () => {
        throw new AuthzConfigError('Authz domain "root": permission doc:x is not declared');
      },
    } as never;
    await cmd.execute({});
    expect(io.err).to.deep.equal(['Authz domain "root": permission doc:x is not declared']);
    expect(io.exitCode()).to.equal(1);
  });

  describe('role stores from DI', () => {
    class NamedRoles extends RoleStore {
      readonly name = 'NamedRoles';
      async load() {
        return { roles: [{ name: 'viewer', extends: [], grants: [], assignable: true, source: 'test' }], ladders: [] };
      }
      async version() {
        return '1';
      }
    }

    const bare = (stores?: string[]) => {
      const { cmd } = command(GOOD);
      delete cmd.Roles;
      cmd.Configuration = new ObjectConfiguration(stores ? { authz: { rbac: { stores: { roles: stores } } } } : {});
      return cmd;
    };

    afterEach(() => {
      DI.unregister('NamedRoles');
      DI.uncache('NamedRoles');
    });

    it('loads the stores authz.rbac.stores.roles names when no RoleStore is registered', async () => {
      DI.register(NamedRoles).asSelf();
      await bare(['NamedRoles']).execute({});
      expect(io.out).to.deep.equal(['OK: 1 role(s), 0 ladder(s)']);
      expect(io.exitCode()).to.equal(undefined);
    });

    it('says which named store is missing and exits 1', async () => {
      await bare(['MissingRoleStore']).execute({});
      expect(io.err).to.have.length(1);
      expect(io.err[0]).to.contain('MissingRoleStore').and.to.contain('authz.rbac.stores.roles');
      expect(io.exitCode()).to.equal(1);
    });

    it('loads every registered RoleStore when the app registers some', async () => {
      const undo = testHost.registerInRoot(RoleStore, NamedRoles);
      try {
        await bare().execute({});
        expect(io.out).to.deep.equal(['OK: 1 role(s), 0 ladder(s)']);
      } finally {
        undo();
      }
    });
  });

  describe('--explain-role', () => {
    it('lists the grants the RBAC service reports', async () => {
      const { cmd } = command(GOOD);
      cmd.Rbac = {
        grantsOf: async (role) => (role === 'editor' ? [{ permission: 'doc:read' }, { permission: 'doc:write', relation: ['owner', 'member'], on: [{ type: 'doc', id: '7' }, { type: 'file' }], fields: { read: ['a'] }, requiresTag: 'beta', grantedAt: ['project'] }] : []),
      };
      await cmd.execute({ explainRole: 'editor' });
      expect(io.out).to.deep.equal(['OK: 2 role(s), 1 ladder(s)', 'role editor: 2 effective grant(s)', '  doc:read', '  doc:write  relation=owner|member  on=doc:7,file  fields={"read":["a"]}  requiresTag=beta  grantedAt=project']);
      expect(io.exitCode()).to.equal(undefined);
    });

    it('refuses a role that is not defined', async () => {
      const { cmd } = command(GOOD);
      cmd.Rbac = { grantsOf: () => [] };
      await cmd.execute({ explainRole: 'nope' });
      expect(io.err[0]).to.contain('unknown role').and.to.contain('nope');
      expect(io.exitCode()).to.equal(1);
    });

    describe('RbacService registered in DI', () => {
      const grants = [{ permission: 'doc:read' }];
      afterEach(() => {
        DI.unregister('RbacService');
        DI.uncache('RbacService');
      });

      it('finds a class registered under the name', async () => {
        class FakeRbac {
          grantsOf() {
            return grants;
          }
        }
        DI.register(FakeRbac).as('RbacService');
        const { cmd } = command(GOOD);
        await cmd.execute({ explainRole: 'editor' });
        expect(io.out).to.include('  doc:read');
        expect(io.exitCode()).to.equal(undefined);
      });

      it('finds a value registered under the name', async () => {
        DI.register({ grantsOf: () => grants }).asValue('RbacService');
        const { cmd } = command(GOOD);
        await cmd.execute({ explainRole: 'editor' });
        expect(io.out).to.include('  doc:read');
        expect(io.exitCode()).to.equal(undefined);
      });
    });

    it('importing the command registers ConfigRoleStore by name, not as the RoleStore of every domain', () => {
      expect(DI.RootContainer.hasRegistered('ConfigRoleStore')).to.equal(true);
      expect(DI.RootContainer.hasRegistered(RoleStore)).to.equal(false);
    });

    it('says the RBAC model is not registered and exits 1 when no RbacService exists', async () => {
      const { cmd } = command(GOOD);
      await cmd.execute({ explainRole: 'editor' });
      expect(io.err).to.have.length(1);
      expect(io.err[0]).to.contain('RBAC model').and.to.contain('not registered');
      expect(io.exitCode()).to.equal(1);
    });
  });
});
