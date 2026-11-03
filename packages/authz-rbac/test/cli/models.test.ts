import { testHost } from '@spinajs/authz-testing';
import { AsyncService, DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { MemoryAdminAssignmentStore, MemoryRoleStore, RoleStore } from '../../src/index.js';
import { CheckConfigCommand, ExplainCommand } from '../../src/cli/index.js';
import { capture } from './fixture.js';
import type { Captured } from './fixture.js';

type Entries = Map<string, unknown[]>;

/** The registry and cache maps of the root container, as copies; the root boot under test writes into both. */
function rootMaps(): { registry: Entries; cache: Entries } {
  const root = DI.RootContainer as unknown as { Registry: { registry: Entries }; Cache: { cache: Entries } };
  return { registry: root.Registry.registry, cache: root.Cache.cache };
}

const copy = (m: Entries): Entries => new Map([...m].map(([k, v]) => [k, [...v]]));

function restore(target: Entries, saved: Entries): void {
  target.clear();
  for (const [k, v] of saved) target.set(k, v);
}

describe('authz cli under authz.models', function () {
  this.timeout(30000);
  let io: Captured;
  let saved: { registry: Entries; cache: Entries };

  before(() => testHost.installHost());
  after(() => testHost.uninstallHost());

  beforeEach(() => {
    const maps = rootMaps();
    saved = { registry: copy(maps.registry), cache: copy(maps.cache) };
    io = capture();
  });

  afterEach(async () => {
    io.restore();
    await testHost.resetHost();
    const maps = rootMaps();
    restore(maps.registry, saved.registry);
    restore(maps.cache, saved.cache);
  });

  it('wires RBAC from authz.models when the command boots authz: --explain-role finds RbacService with no wiring code', async () => {
    const config = testHost.config();
    config.set(['authz', 'permissions'], { 'doc:read': {} });
    config.set(['authz', 'models'], ['RbacModel']);
    // A store DI finds by name that needs no ORM connection, so the root boot runs without a database.
    DI.register(MemoryAdminAssignmentStore).asSelf();
    config.set(['authz', 'rbac'], { roles: { viewer: { grants: ['doc:read'] } }, stores: { assignments: ['MemoryAdminAssignmentStore'], links: [], membership: [] } });

    const cmd = new CheckConfigCommand();
    cmd.Container = DI.RootContainer;
    cmd.Configuration = config;
    await cmd.execute({ explainRole: 'viewer' });

    expect(io.err).to.deep.equal([]);
    // The real host also logs its runAs audit line to the console.
    expect(io.out.filter((line) => !line.includes('(authz-audit)'))).to.deep.equal(['OK: 1 role(s), 0 ladder(s)', 'role viewer: 1 effective grant(s)', '  doc:read']);
  });

  describe('the Orm comes only from the stores that need it', () => {
    let ormResolves: number;

    /** The Orm of a process with no database: every resolve is counted and fails. */
    class NoDatabaseOrm extends AsyncService {
      public async resolve(): Promise<void> {
        ormResolves++;
        throw new Error('no database configured');
      }
    }

    const memoryStores = (stores: Record<string, string[]> = {}) => {
      const config = testHost.config();
      config.set(['authz', 'permissions'], { 'doc:read': {} });
      config.set(['authz', 'models'], ['RbacModel']);
      DI.register(MemoryAdminAssignmentStore).asSelf();
      config.set(['authz', 'rbac'], { roles: { viewer: { grants: ['doc:read'] } }, stores: { assignments: ['MemoryAdminAssignmentStore'], links: [], membership: [], ...stores } });
      return config;
    };

    beforeEach(() => {
      ormResolves = 0;
      DI.register(NoDatabaseOrm).as(Orm);
    });

    const outLines = () => io.out.filter((line) => !line.includes('(authz-audit)'));

    it('authz:check-config on memory stores never resolves the Orm, also with a RoleStore the app registers', async () => {
      const config = memoryStores();
      DI.register(testHost.instance(new MemoryRoleStore([{ name: 'viewer', extends: [], grants: [], assignable: true, source: 'app' }], []))).as(RoleStore);

      const cmd = new CheckConfigCommand();
      cmd.Container = DI.RootContainer;
      cmd.Configuration = config;
      await cmd.execute({});

      expect(io.err).to.deep.equal([]);
      // The app's RoleStore and the ConfigRoleStore the RBAC boot registers in root.
      expect(outLines()).to.deep.equal(['OK: 2 role(s), 0 ladder(s)']);
      expect(ormResolves).to.equal(0);
    });

    it('authz:explain on memory stores never resolves the Orm', async () => {
      memoryStores();

      const cmd = new ExplainCommand();
      cmd.Container = DI.RootContainer;
      await cmd.execute('user:alice', 'doc:read');

      expect(io.err).to.deep.equal([]);
      expect(outLines()[0]).to.equal('DENIED: user:alice doc:read on $global');
      expect(ormResolves).to.equal(0);
    });

    it('authz:check-config with DbRuleStore boots the Orm through the store, and a failing boot is the message', async () => {
      const config = memoryStores({ rules: ['DbRuleStore'] });

      const cmd = new CheckConfigCommand();
      cmd.Container = DI.RootContainer;
      cmd.Configuration = config;
      await cmd.execute({});

      expect(io.err).to.have.length(1);
      expect(io.err[0]).to.contain('no database configured');
      expect(io.exitCode()).to.equal(1);
      expect(ormResolves).to.be.greaterThan(0);
    });
  });
});
