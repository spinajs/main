import { AuthzConfigError, FALSE, GLOBAL, PermissionRegistryImpl, TRUE, UnknownPermission } from '@spinajs/authz';
import type { Assignment, ResourceRef, Vote } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { LadderDef, RbacExtension, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const FILES: ResourceRef = { type: 'file' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, roleName: string): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope: GLOBAL, source: 'test' });

const READER = [role('viewer', ['file:read'])];
const NO_READ = [role('viewer', ['file:write'])];

interface Gate {
  readonly release: () => void;
}

/** Counts reads; with `hold` set, version() reads the version, then waits until the test releases it. */
class CountingRoleStore extends MemoryRoleStore {
  versions = 0;
  loads = 0;
  failVersion = false;
  hold = false;
  readonly gates: Gate[] = [];

  override async version(): Promise<string> {
    this.versions++;
    const version = await super.version();
    if (this.hold) await new Promise<void>((release) => this.gates.push({ release }));
    if (this.failVersion) throw new Error('role store unavailable');
    return version;
  }

  override async load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }> {
    this.loads++;
    return super.load();
  }
}

const isThenable = (v: unknown): boolean => typeof (v as { then?: unknown } | null)?.then === 'function';
const ctx = () => fakeEvaluationContext({ now: NOW });
const list = { principal: alice, permission: 'file:read', resource: FILES };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const failure = (p: Vote | Promise<unknown>): Promise<Error | undefined> =>
  Promise.resolve(p).then(
    () => undefined,
    (e: Error) => e,
  );

async function setup(opts: { config?: Record<string, unknown>; extensions?: readonly RbacExtension[] } = {}) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read' }, { name: 'file:write' }], 'test');
  registry.freeze();
  const roles = new CountingRoleStore(READER);
  const warnings: string[] = [];
  const clock = new ManualClock(NOW);
  const model = new RbacModel({ roles, assignments: new MemoryAssignmentStore([assignment('a1', 'viewer')]), clock, log: { warn: (m) => void warnings.push(m) }, ...(opts.extensions ? { extensions: opts.extensions } : {}) });
  await model.init(fakeModelInitContext({ model: 'rbac', config: opts.config ?? {}, permissions: registry }));
  model.grantIndex();
  await model.preload(alice, ctx());
  roles.versions = 0;
  roles.loads = 0;
  return { model, roles, warnings, clock };
}

const permits = async (model: RbacModel) => (await model.evaluate(list, ctx())).permitWhen;

describe('authz-rbac model: role definitions reload', () => {
  it('a role: invalidate makes the next request re-read and recompile the roles, and version() moves', async () => {
    const { model, roles } = await setup();
    const before = model.version();
    roles.set(NO_READ);
    expect(model.evaluate(list, ctx())).to.not.satisfy(isThenable);
    expect(await permits(model)).to.deep.equal(TRUE);
    model.invalidate(['role:viewer']);
    const after = model.evaluate(list, ctx());
    expect(after, 'a sync evaluate with stale roles answers with a promise').to.satisfy(isThenable);
    expect((await after).permitWhen).to.deep.equal(FALSE);
    expect(model.version()).to.not.equal(before);
    expect(model.version()).to.equal(await roles.version());
    expect(model.grantIndex().granted('file:read')).to.equal(false);
    expect(model.evaluate(list, ctx()), 'fresh roles answer without IO again').to.not.satisfy(isThenable);
  });

  for (const tags of [['model:rbac'], ['*'], ['ghost:x'], [7], null]) {
    it(`${JSON.stringify(tags)} also marks the roles stale`, async () => {
      const { model, roles } = await setup();
      roles.set(NO_READ);
      model.invalidate(tags as unknown as readonly string[]);
      expect(await permits(model)).to.deep.equal(FALSE);
    });
  }

  for (const tags of [['subject:user:alice'], ['scope:org:o1'], ['link:l1'], ['policy:p1'], ['rule:r1'], ['model:abac']]) {
    it(`${JSON.stringify(tags)} leaves the roles alone`, async () => {
      const { model, roles } = await setup();
      roles.set(NO_READ);
      model.invalidate(tags);
      expect(await permits(model)).to.deep.equal(TRUE);
      expect(roles.versions).to.equal(0);
    });
  }

  it('an unchanged version is read and nothing is recompiled', async () => {
    const { model, roles } = await setup();
    const graph = model.roleGraph();
    model.invalidate(['role:viewer']);
    expect(await permits(model)).to.deep.equal(TRUE);
    expect(roles.versions).to.equal(1);
    expect(roles.loads).to.equal(0);
    expect(model.roleGraph()).to.equal(graph);
  });

  it('runs the extensions’ compile hooks on the new roles', async () => {
    const seen: string[][] = [];
    const ext: RbacExtension = { compile: (graph) => void seen.push([...graph.names]) };
    const { model, roles } = await setup({ extensions: [ext] });
    roles.set([...READER, role('editor', ['file:write'])]);
    model.invalidate(['role:editor']);
    await permits(model);
    expect(seen).to.deep.equal([['viewer'], ['viewer', 'editor']]);
  });

  describe('fails closed', () => {
    it('after a failed reload version() moves to a stale value, so the host drops its decision cache; a good reload restores the store version', async () => {
      const { model, roles, clock } = await setup({ config: { cache: { rolesCheckSeconds: 10 } } });
      const before = model.version();
      roles.set([role('a', [], { extends: ['b'] }), role('b', [], { extends: ['a'] })]);
      clock.advance(10_000);
      expect(await failure(model.preload(alice, ctx()))).to.be.instanceOf(AuthzConfigError);
      const stale = model.version();
      expect(stale).to.not.equal(before);
      expect(stale).to.contain('#stale:');
      expect(model.version(), 'stable while nothing changes').to.equal(stale);
      roles.set(NO_READ);
      expect(await permits(model)).to.deep.equal(FALSE);
      expect(model.version()).to.equal(await roles.version());
    });

    it('a role store version that cannot be read moves version() to a stale value too', async () => {
      const { model, roles, clock } = await setup({ config: { cache: { rolesCheckSeconds: 10 } } });
      const before = model.version();
      roles.failVersion = true;
      clock.advance(10_000);
      expect((await failure(model.preload(alice, ctx())))?.message).to.equal('role store unavailable');
      expect(model.version()).to.not.equal(before);
      roles.failVersion = false;
      expect(await permits(model)).to.deep.equal(TRUE);
      expect(model.version()).to.equal(before);
    });

    it('roles that do not compile fail every vote and move version() off the old value; a fixed store recovers', async () => {
      const { model, roles, warnings } = await setup();
      const before = model.version();
      roles.set([role('a', [], { extends: ['b'] }), role('b', [], { extends: ['a'] })]);
      model.invalidate(['role:a']);
      const err = await failure(model.evaluate(list, ctx()));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(await failure(model.preload(alice, ctx()))).to.be.instanceOf(AuthzConfigError);
      expect(model.version()).to.equal(`${before}#stale:1`);
      expect(warnings.some((w) => w.includes('reloading the role definitions failed'))).to.equal(true);
      roles.set(NO_READ);
      expect(await permits(model)).to.deep.equal(FALSE);
      expect(model.version()).to.equal(await roles.version());
    });

    it('a grant of an unknown permission fails the reload (B02)', async () => {
      const { model, roles } = await setup();
      roles.set([role('viewer', ['ghost:read'])]);
      model.invalidate(['role:viewer']);
      expect(await failure(model.evaluate(list, ctx()))).to.be.instanceOf(UnknownPermission);
    });

    it('a compile hook that throws fails the reload', async () => {
      let fail = false;
      const { model, roles } = await setup({
        extensions: [
          {
            compile: () => {
              if (fail) throw new AuthzConfigError('hook refused');
            },
          },
        ],
      });
      fail = true;
      roles.set(NO_READ);
      model.invalidate(['role:viewer']);
      expect((await failure(model.evaluate(list, ctx())))?.message).to.equal('hook refused');
      fail = false;
      expect(await permits(model)).to.deep.equal(FALSE);
    });

    it('a config role the new roles no longer define fails the reload', async () => {
      const { model, roles } = await setup({ config: { anonymousRoles: ['viewer'] } });
      roles.set([role('reader', ['file:read'])]);
      model.invalidate(['role:viewer']);
      expect((await failure(model.evaluate(list, ctx())))?.message).to.contain('authz.rbac.anonymousRoles');
    });

    it('a role store that fails rejects, and the next request tries again', async () => {
      const { model, roles } = await setup();
      roles.failVersion = true;
      model.invalidate(['role:viewer']);
      expect((await failure(model.evaluate(list, ctx())))?.message).to.equal('role store unavailable');
      roles.failVersion = false;
      roles.set(NO_READ);
      expect(await permits(model)).to.deep.equal(FALSE);
    });
  });

  describe('concurrency', () => {
    it('requests during a reload share one store read', async () => {
      const { model, roles } = await setup();
      roles.set(NO_READ);
      roles.hold = true;
      model.invalidate(['role:viewer']);
      const votes = [model.evaluate(list, ctx()), model.evaluate(list, ctx()), model.preload(alice, ctx())];
      await settle();
      expect(roles.versions).to.equal(1);
      roles.hold = false;
      roles.gates[0].release();
      const [a, b] = await Promise.all(votes);
      expect([(a as Vote).permitWhen, (b as Vote).permitWhen]).to.deep.equal([FALSE, FALSE]);
      expect(roles.loads).to.equal(1);
    });

    it('an invalidate during a reload makes the next request reload again', async () => {
      const { model, roles } = await setup();
      roles.set(NO_READ);
      roles.hold = true;
      model.invalidate(['role:viewer']);
      const first = model.evaluate(list, ctx());
      await settle();
      // The change lands after the reload read the version.
      roles.set(READER);
      model.invalidate(['role:viewer']);
      roles.hold = false;
      roles.gates[0].release();
      expect((await first).permitWhen).to.deep.equal(TRUE);
      expect(await permits(model)).to.deep.equal(TRUE);
      expect(model.version()).to.equal(await roles.version());
    });
  });

  describe('periodic version check', () => {
    it('preload re-reads the version every authz.rbac.cache.rolesCheckSeconds without any invalidate', async () => {
      const { model, roles, clock } = await setup({ config: { cache: { rolesCheckSeconds: 10 } } });
      roles.set(NO_READ);
      clock.advance(9_999);
      await model.preload(alice, ctx());
      expect(roles.versions).to.equal(0);
      expect(await permits(model)).to.deep.equal(TRUE);
      clock.advance(1);
      await model.preload(alice, ctx());
      // The check's read, then the reload's own.
      expect(roles.versions).to.equal(2);
      expect(roles.loads).to.equal(1);
      expect(model.evaluate(list, ctx())).to.not.satisfy(isThenable);
      expect(await permits(model)).to.deep.equal(FALSE);
    });

    it('a check that finds the same version keeps sync answers', async () => {
      const { model, clock } = await setup({ config: { cache: { rolesCheckSeconds: 10 } } });
      clock.advance(10_000);
      await model.preload(alice, ctx());
      expect(model.evaluate(list, ctx())).to.not.satisfy(isThenable);
    });

    it('0 turns the check off', async () => {
      const { model, roles, clock } = await setup({ config: { cache: { rolesCheckSeconds: 0 } } });
      roles.set(NO_READ);
      clock.advance(3_600_000);
      await model.preload(alice, ctx());
      expect(roles.versions).to.equal(0);
      expect(await permits(model)).to.deep.equal(TRUE);
    });

    it('refuses a rolesCheckSeconds that is not a finite number at init (an unvalidated configuration)', async () => {
      for (const rolesCheckSeconds of ['x', Infinity]) {
        expect((await failure(setup({ config: { cache: { rolesCheckSeconds } } })))?.message).to.contain('authz.rbac.cache.rolesCheckSeconds');
      }
    });
  });
});
