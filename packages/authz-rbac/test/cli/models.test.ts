import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { MemoryAdminAssignmentStore } from '../../src/index.js';
import { CheckConfigCommand } from '../../src/cli/index.js';
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
});
