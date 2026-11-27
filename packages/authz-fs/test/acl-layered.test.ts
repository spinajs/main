import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { join } from 'node:path';

import { AuthzConfigError, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { principalSubjectKey } from '@spinajs/authz-rbac';
import { userPrincipal } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI, NewInstance } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { FILE_PROVIDER_INSTANCES, FILE_PROVIDER_INSTANCES_TOKEN, FsProviderLayer, fsNative, layeredFs, publishedFs } from '@spinajs/fs';
import type { IFsLocalOptions, fs } from '@spinajs/fs';
import type { IUploadedFile } from '@spinajs/http';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthzFsAcl_2026_10_17_00_00_00, AuthzUploadMiddleware, FsAcl, FsAclRelation, OrmFileAclStore, fromFsPath } from '../src/index.js';
import { fileAclStore } from '../src/acl/shared.js';
import { FakeConfiguration } from './helpers.js';
import { ALICE, ANY_USER, BOB } from './support/acl-contract.js';
import { FakeAuthz } from './support/fake-authz.js';
import { installQuietLog } from './support/log.js';
import { useMiddleware } from './support/mw-setup.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// TENANT_FILES stands for a provider listed in tenancy.fs.prefixed: authz-fs has no dependency on tenancy.
const TENANT_FILES = 'layered-uploads';
const VIEW = 'layered-view';
const SHARED = 'layered-docs';
const MODES = ['off', 'audit', 'enforce'] as const;
const REFUSED = /file ACL of fs "layered-uploads": a provider layer/;

/** Hands out another provider for TENANT_FILES, as TenantFsLayer hands out a TenantFs. */
class StandInLayer extends FsProviderLayer {
  public wrap(found: fs): fs {
    return found.Name === TENANT_FILES ? (publishedFs(VIEW) ?? found) : found;
  }
}

/** `Array.ofType` leaves a `@NewInstance()` class out: `@spinajs/fs` refuses the lookup rather than skip it. */
@NewInstance()
class SkippedLayer extends FsProviderLayer {
  public wrap(found: fs): fs {
    return found;
  }
}

/** The principal's own key only, so no RbacService of an authz host is resolved. */
class OwnKeyRelation extends FsAclRelation {
  protected override async subjectKeys(principal: Principal): Promise<readonly string[]> {
    return [principalSubjectKey(principal)];
  }
}

/** Registers `layer` in root, or removes it; the layer list is cached, so both ends uncache it. */
function useLayer(layer: Class<FsProviderLayer>, on: boolean): void {
  if (on) DI.register(layer).as(FsProviderLayer);
  else DI.unregister(layer);
  DI.uncache(Array.ofType(FsProviderLayer));
}

describe('authz-fs file ACL of a provider a layer hands out as another', function () {
  this.timeout(30000);

  let orm: Orm | undefined;
  let db: OrmDriver;
  let config: Configuration;
  let undoLog: (() => void) | undefined;
  let layered = false;
  const store = new OrmFileAclStore();
  const alice = userPrincipal('alice');
  const acl = (principal: Principal, authz = new FakeAuthz()) => new FsAcl({ service: async () => authz, principal: () => principal, log: { warn: () => undefined }, store: async () => store });
  const rowsOf = async (fsName: string): Promise<number> => ((await db.select().from('fs_acl').where({ fs: fsName })) as unknown[]).length;
  const layer = (on: boolean): void => {
    if (on === layered) return;
    useLayer(StandInLayer, on);
    layered = on;
  };

  before(async () => {
    undoLog = installQuietLog();
    DI.register(FakeConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    config = await DI.resolve<Configuration>(Configuration);
    config.set(['db'], { DefaultConnection: 'sqlite', MigrationCheck: 'off', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations' } }] });
    orm = await DI.resolve<Orm>(Orm);
    db = orm.Connections.get('default')!;
    await new AuthzFsAcl_2026_10_17_00_00_00().up(db);
    for (const name of [TENANT_FILES, VIEW, SHARED]) DI.register({ Name: name, BasePath: '' }).asMapValue(FILE_PROVIDER_INSTANCES, name);
  });

  after(async () => {
    layer(false);
    for (const name of [TENANT_FILES, VIEW, SHARED]) DI.get(FILE_PROVIDER_INSTANCES_TOKEN)?.delete(name);
    for (const c of new Set(orm?.Connections.values() ?? [])) await c.disconnect().catch(() => undefined);
    DI.uncache(Orm);
    DI.uncache(Configuration);
    DI.unregister(FakeConfiguration);
    DI.unregister(SqliteOrmDriver);
    undoLog?.();
  });

  beforeEach(() => config.set(['authz', 'fs'], undefined));
  afterEach(() => layer(false));

  it('without a layer the file ACL of the same provider works as before', async () => {
    await acl(alice).grant(TENANT_FILES, 'plain/a.pdf', ALICE, 'viewer');
    expect(await store.holds(TENANT_FILES, ['plain/a.pdf'], ['user:alice'], 'viewer', new Date())).to.equal(true);
    await acl(SYSTEM).revoke(TENANT_FILES, 'plain/a.pdf', ALICE, 'viewer');
    expect(await rowsOf(TENANT_FILES)).to.equal(0);
  });

  it('refuses every read and write of the ACL of a layered provider, in mode off too, and writes nothing', async () => {
    await store.grant({ fs: TENANT_FILES, path: 'reports/q1.pdf', subject: ALICE, relation: 'viewer' });
    layer(true);
    for (const mode of MODES) {
      config.set(['authz', 'fs'], { [TENANT_FILES]: { mode }, [SHARED]: { mode } });
      await expect(acl(alice).grant(TENANT_FILES, 'reports/q1.pdf', ANY_USER, 'viewer'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      // before the fs:manage decision: a principal the policy refuses gets the refusal, not AccessDenied
      await expect(acl(alice, new FakeAuthz(() => false)).revoke(TENANT_FILES, 'reports/q1.pdf', ALICE, 'viewer'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(acl(SYSTEM).list(TENANT_FILES, 'reports/q1.pdf'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.holds(TENANT_FILES, ['reports/q1.pdf'], ['user:alice'], 'viewer', new Date()), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.list(TENANT_FILES, 'reports/q1.pdf'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.ownerOf(TENANT_FILES, 'reports/q1.pdf'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.grant({ fs: TENANT_FILES, path: 'x.pdf', subject: BOB, relation: 'viewer' }), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.revoke(TENANT_FILES, 'reports/q1.pdf', 'user:alice', 'viewer'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.setOwnerIfAbsent(TENANT_FILES, 'logo.png', ALICE), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.deleteTree(TENANT_FILES, 'reports'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.deletePath(TENANT_FILES, 'reports/q1.pdf'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      // the middleware moves rows onto the destination whatever the destination's mode
      await expect(store.moveTree(SHARED, 'in', TENANT_FILES, 'in'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
      await expect(store.movePath(TENANT_FILES, 'reports/q1.pdf', SHARED, 'q1.pdf'), mode).to.be.rejectedWith(AuthzConfigError, REFUSED);
    }
    expect(await rowsOf(TENANT_FILES)).to.equal(1);
    expect(await rowsOf(SHARED)).to.equal(0);
  });

  it('a fromFsPath route on a layered provider does not read the row that would grant it', async () => {
    expect(await fileAclStore(DI.RootContainer)).to.be.instanceOf(OrmFileAclStore);
    await store.grant({ fs: TENANT_FILES, path: 'shared/q2.pdf', subject: ALICE, relation: 'viewer' });
    const ref = await fromFsPath(TENANT_FILES, 'path')({ params: { path: 'shared/q2.pdf' } });
    const viewer = new OwnKeyRelation('file', 'viewer');
    expect(await viewer.holds(alice, ref)).to.equal(true);

    layer(true);
    await expect(viewer.holds(alice, ref)).to.be.rejectedWith(AuthzConfigError, REFUSED);
  });

  it('a layer DI would skip makes the file ACL throw InvalidOperation instead of answering "not layered"', async () => {
    useLayer(SkippedLayer, true);
    try {
      await expect(store.holds(SHARED, ['a.txt'], ['user:alice'], 'viewer', new Date())).to.be.rejectedWith(InvalidOperation, /SkippedLayer cannot run/);
    } finally {
      useLayer(SkippedLayer, false);
    }
  });

  it('a provider no layer wraps keeps its file ACL in every mode while another one is layered', async () => {
    layer(true);
    for (const mode of MODES) {
      config.set(['authz', 'fs'], { [TENANT_FILES]: { mode }, [SHARED]: { mode } });
      await acl(alice).grant(SHARED, `${mode}/a.txt`, ALICE, 'viewer');
      expect(await store.holds(SHARED, [`${mode}/a.txt`], ['user:alice'], 'viewer', new Date()), mode).to.equal(true);
      await store.moveTree(SHARED, mode, SHARED, `${mode}-moved`);
      expect(await acl(SYSTEM).list(SHARED, `${mode}-moved/a.txt`), mode).to.have.length(1);
    }
  });
});

/** Views handed out by ViewLayer, by name: same Name, another base path, as a tenant's view keeps the name. */
const views = new Map<string, fs>();

class ViewLayer extends FsProviderLayer {
  public wrap(found: fs): fs {
    return views.get(found.Name) ?? found;
  }
}

const ENTRIES = {
  'mw-lay': { mode: 'enforce', stampOwner: true },
  'mw-lay-audit': { mode: 'audit', stampOwner: true },
  'mw-lay-off': { mode: 'off' },
  'mw-plain': { mode: 'enforce', stampOwner: true },
};
const MW_REFUSED = /^authz\.fs\.mw-lay(-audit)? is "(enforce|audit)", whose checks read and keep the file ACL of fs "mw-lay(-audit)?": a provider layer/;

describe('authz-fs checks on file actions of a provider a layer hands out as another', function () {
  this.timeout(30000);
  const s = useMiddleware(ENTRIES);
  const names: string[] = [];

  /** fsNative `name` published in root; with `view`, ViewLayer hands out another fsNative of that name. */
  const provider = (name: string, files: Readonly<Record<string, string>> = {}, view = false): fsNative<IFsLocalOptions> => {
    const published = s.local(name, files);
    DI.register(published).asMapValue(FILE_PROVIDER_INSTANCES, name);
    names.push(name);
    if (view) views.set(name, new fsNative<IFsLocalOptions>({ name, basePath: s.base(`${name}-view`, files) }));
    return published;
  };

  /** Through a provider no `authz.fs` entry names, so no check runs. */
  const onDisk = (base: string, path: string): Promise<boolean> => new fsNative<IFsLocalOptions>({ name: 'mw-probe', basePath: join(s.dir, base) }).exists(path);

  beforeEach(() => useLayer(ViewLayer, true));

  afterEach(() => {
    useLayer(ViewLayer, false);
    for (const name of names.splice(0)) DI.get(FILE_PROVIDER_INSTANCES_TOKEN)?.delete(name);
    views.clear();
  });

  it('an action on a checked layered provider is refused before any decision, IO or ACL call, for SYSTEM too', async () => {
    const handedOut: fs[] = [];
    for (const name of ['mw-lay', 'mw-lay-audit']) {
      const published = provider(name, { 'a.txt': 'A', 'd/b.txt': 'B' }, true);
      const view = layeredFs(published);
      expect(view).to.not.equal(published);
      handedOut.push(view);
      for (const target of [view, published]) {
        await expect(target.write('new.txt', 'x'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
        await expect(target.read('a.txt'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
        await expect(target.exists('a.txt'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
        await expect(target.list('d'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
        await expect(target.rm('a.txt'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
      }
      s.principal = SYSTEM;
      await expect(view.write('new.txt', 'x'), name).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
      s.principal = userPrincipal('alice');
    }
    const plain = provider('mw-plain', { 'a.txt': 'A' });
    await expect(plain.copy('a.txt', 'a.txt', handedOut[0]), 'copy into it').to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
    expect(s.authz.calls).to.deep.equal([]);
    expect(s.acl.calls).to.deep.equal([]);
    for (const base of ['mw-lay', 'mw-lay-view', 'mw-lay-audit', 'mw-lay-audit-view']) {
      expect(await onDisk(base, 'new.txt'), base).to.equal(false);
      expect(await onDisk(base, 'a.txt'), base).to.equal(true);
    }
  });

  it('AuthzUploadMiddleware refuses an upload to a checked layered provider before the decision', async () => {
    provider('mw-lay', {}, true);
    const upload: IUploadedFile = { Size: 1, Name: 'a.png', BaseName: 'a.png', Type: 'image/png', Provider: null, OriginalFile: {} as IUploadedFile['OriginalFile'] };
    const middleware = new AuthzUploadMiddleware({ container: s.child, service: async () => s.authz, principal: () => s.principal, log: { warn: () => undefined } });
    await expect(middleware.beforeUpload(upload, { fs: 'mw-lay' })).to.be.rejectedWith(AuthzConfigError, MW_REFUSED);
    expect(s.authz.calls).to.deep.equal([]);
  });

  it('a layered provider in mode off runs unchecked and its file ACL is never read or written', async () => {
    const off = layeredFs(provider('mw-lay-off', { 'a.txt': 'A' }, true));
    await off.write('b.txt', 'B');
    expect(await off.read('b.txt', 'utf-8')).to.equal('B');
    expect(await off.exists('a.txt')).to.equal(true);
    expect((await off.list('')).sort()).to.deep.equal(['a.txt', 'b.txt']);
    expect(off.tmppath('.txt')).to.be.a('string');
    await off.rm('b.txt');
    expect(s.authz.calls).to.deep.equal([]);
    expect(s.acl.calls).to.deep.equal([]);
  });

  it('copy and move between a plain and a layered provider: each target is decided by its own filesystem, no row lands on the layered one', async () => {
    const plain = provider('mw-plain', { 'a.txt': 'A', 'b.txt': 'B' });
    const off = layeredFs(provider('mw-lay-off', { 'in.txt': 'I' }, true));
    for (const path of ['a.txt', 'b.txt']) await s.acl.grant({ fs: 'mw-plain', path, subject: BOB, relation: 'viewer' });
    await plain.copy('a.txt', 'a-copy.txt', off);
    await plain.move('b.txt', 'b-moved.txt', off);
    await off.move('in.txt', 'in-moved.txt', plain);
    expect(s.errors).to.deep.equal([]);
    expect(s.authz.calls.length).to.be.greaterThan(0);
    expect(s.authz.keys().filter((k) => k.includes('mw-lay'))).to.deep.equal([]);
    expect(s.acl.rows.map((r) => `${r.fs}:${r.path} ${r.subjectKey}`)).to.deep.equal(['mw-plain:a.txt user:bob']);
    expect((await onDisk('mw-lay-off-view', 'b-moved.txt')) && (await onDisk('mw-plain', 'in-moved.txt'))).to.equal(true);
  });

  it('a provider no layer wraps gets the same decisions and ACL calls whether or not another provider is layered', async () => {
    const run = async (round: string, layerOn: boolean) => {
      useLayer(ViewLayer, layerOn);
      s.acl.clear();
      s.authz.calls.length = 0;
      provider('mw-lay', {}, true);
      const plain = new fsNative<IFsLocalOptions>({ name: 'mw-plain', basePath: s.base(round, { 'a.txt': 'A', 'd/b.txt': 'B' }) });
      DI.register(plain).asMapValue(FILE_PROVIDER_INSTANCES, 'mw-plain');
      names.push('mw-plain');
      await s.acl.grant({ fs: 'mw-plain', path: 'd', subject: BOB, relation: 'viewer' });
      await plain.write('new.txt', 'N');
      await plain.read('a.txt');
      await plain.list('d');
      await plain.copy('a.txt', 'a2.txt');
      await plain.move('d', 'e');
      await plain.rm('a.txt');
      return JSON.stringify({ decisions: s.authz.calls, acl: s.acl.calls, rows: s.acl.rows });
    };
    const without = await run('round-1', false);
    expect(await run('round-2', true)).to.equal(without);
    expect(without).to.include('setOwnerIfAbsent');
  });
});
