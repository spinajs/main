import * as chai from 'chai';
import 'mocha';

import { Configuration, ConfigurationSource, FrameworkConfiguration, StaticConfigurationSource } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, modelDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import fsAclConnection from '../src/config/db.js';
import { AuthzFsAcl_2026_10_17_00_00_00, FS_ACL_CONNECTION, FsAclRecord, OrmFileAclStore } from '../src/index.js';
import { ALICE } from './support/acl-contract.js';
import { sqlite } from './support/acl-orm.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

// The package layer first, as the configuration merges lib/config/db.js of an installed package below the app's files.
const PackageLayer = StaticConfigurationSource(fsAclConnection, 0);
// A 3.x app that keeps fs_acl on its own connection: the one key it always set, no db.Aliases line of its own.
const AppLayer = StaticConfigurationSource({ db: { DefaultConnection: 'main', MigrationCheck: 'off', StrictTableCheck: false, Connections: [sqlite('main'), sqlite('files')] }, authz: { fsAcl: { connection: 'files' } } }, 10);

class AppConfiguration extends FrameworkConfiguration {}

const NOT_READ = Symbol('not read');

describe('authz-fs: the alias authz-fs-acl follows authz.fsAcl.connection', function () {
  this.timeout(30000);
  let orm: Orm | undefined;
  let undoLog: (() => void) | undefined;
  let early: unknown = NOT_READ;

  before(async () => {
    undoLog = installQuietLog();
    // A read before the root Configuration is cached, as a configuration source that spreads db.Aliases in its own
    // resolve() makes one. Skipped when an earlier file of the suite left a Configuration cached.
    if (DI.get(Configuration) === undefined) early = fsAclConnection.db.Aliases[FS_ACL_CONNECTION].get();
    DI.register(PackageLayer).as(ConfigurationSource);
    DI.register(AppLayer).as(ConfigurationSource);
    DI.register(AppConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Configuration);
    orm = await DI.resolve(Orm);
    await new AuthzFsAcl_2026_10_17_00_00_00().up(orm.Connections.get('files')!);
    // The table was made after the boot, by hand: the model has no columns until the ORM reads it.
    await orm.reloadTableInfo({ models: [FsAclRecord] });
  });

  after(async () => {
    for (const c of new Set(orm?.Connections.values() ?? [])) await c.disconnect().catch(() => undefined);
    DI.uncache(Orm);
    DI.uncache(Configuration);
    DI.unregister(AppConfiguration);
    DI.unregister(PackageLayer);
    DI.unregister(AppLayer);
    DI.unregister(SqliteOrmDriver);
    undoLog?.();
  });

  it('reads and writes fs_acl on files for an app that set only authz.fsAcl.connection', async () => {
    const files = orm!.Connections.get('files')!;
    expect(orm!.Connections.get(FS_ACL_CONNECTION)).to.equal(files);
    expect(modelDriver(FsAclRecord)).to.equal(files);

    const store = new OrmFileAclStore();
    await store.grant({ fs: 'alias', path: 'a.txt', subject: ALICE, relation: 'viewer' });
    expect(await store.list('alias', 'a.txt')).to.have.length(1);
    expect(await files.select().from('fs_acl').where({ fs: 'alias' })).to.have.length(1);
    expect(await orm!.Connections.get('main')!.schema().tableExists('fs_acl')).to.equal(false);
  });

  it('answers nothing to a read before the Configuration is cached, so that read pins no default', function () {
    if (early === NOT_READ) return this.skip();
    expect(early).to.equal(undefined);
  });
});
