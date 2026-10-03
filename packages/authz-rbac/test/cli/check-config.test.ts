import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { Orm } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';

import { CheckConfigCommand } from '../../src/cli/index.js';
import { RoleStore } from '../../src/contracts.js';
import { ConfigRoleStore } from '../../src/stores/index.js';
import { bootSqlite } from '../orm/fixture.js';
import type { BootedDb } from '../orm/fixture.js';
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

  it('prints the config error and exits 1 when the role configuration is refused', async () => {
    const { cmd } = command({ roles: { viewer: { grants: 'doc:read' } } });
    await cmd.execute({});
    expect(io.err).to.have.length(1);
    expect(io.err[0]).to.contain('authz.rbac.roles.viewer.grants');
    expect(io.exitCode()).to.equal(1);
    expect(io.out).to.deep.equal([]);
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

    it('importing the command registers the config RoleStore', () => {
      expect(DI.RootContainer.hasRegistered(RoleStore)).to.equal(true);
    });

    it('says the RBAC model is not registered and exits 1 when no RbacService exists', async () => {
      const { cmd } = command(GOOD);
      await cmd.execute({ explainRole: 'editor' });
      expect(io.err).to.have.length(1);
      expect(io.err[0]).to.contain('RBAC model').and.to.contain('not registered');
      expect(io.exitCode()).to.equal(1);
    });
  });

  describe('--unattended', function () {
    this.timeout(30000);
    let db: BootedDb;
    before(async () => {
      db = await bootSqlite();
    });
    after(async () => {
      await db.close();
    });

    const withOrm = (cmd: CheckConfigCommand) => {
      cmd.Orm = { Connections: new Map([['default', db.driver]]) } as unknown as Orm;
      cmd.Configuration = new ObjectConfiguration({});
      return cmd;
    };

    it('reports that DbDecisionAudit is not enabled when the table is absent', async () => {
      const { cmd } = command(GOOD);
      await withOrm(cmd).execute({ unattended: true });
      expect(io.err).to.have.length(1);
      expect(io.err[0]).to.contain('DbDecisionAudit').and.to.contain('not enabled');
      expect(io.exitCode()).to.equal(1);
    });

    it('counts unattended queries per resource type', async () => {
      await db.driver.schema().createTable('authz_audit', (t) => {
        t.string('id', 36).primaryKey().notNull();
        t.dateTime('at').notNull();
        t.string('kind', 16).notNull();
        t.string('principal', 100).notNull();
        t.string('permission', 160);
        t.string('resource', 255);
        t.string('reason', 255);
        t.text('trace');
      });
      const rows: Array<[string, string, string]> = [
        ['doc:1', 'doc:read', 'unattended'],
        ['doc:2', 'doc:read', 'unattended'],
        ['file:9', 'file:read', 'unattended'],
        ['we%3Aird:1', 'x', 'unattended'],
        ['project:3', 'project:read', 'no_access'],
      ];
      let n = 0;
      for (const [resource, permission, reason] of rows) {
        await db.driver
          .insert()
          .into('authz_audit')
          .values({ id: `r${++n}`, at: new Date(), kind: 'deny', principal: 'unattended:unattended', permission, resource, reason });
      }

      const { cmd } = command(GOOD);
      await withOrm(cmd).execute({ unattended: true });
      expect(io.out).to.deep.equal(['OK: 2 role(s), 1 ladder(s)', 'resource types queried without a principal:', '  doc  2', '  file  1', '  we:ird  1']);
      expect(io.exitCode()).to.equal(undefined);
    });
  });
});
