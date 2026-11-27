import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

import { AuthzFsAcl_2026_10_17_00_00_00, FS_ACL_CONNECTION, FsAclRecord, OrmFileAclStore } from '../src/index.js';
import { ALICE, BOB } from './support/acl-contract.js';
import { bootAclOrm, sqlite } from './support/acl-orm.js';
import type { AclOrm } from './support/acl-orm.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// As MySQL's or MSSQL's default collation would make the table; SQLite's LIKE also ignores ASCII case.
const NOCASE_TABLE =
  'CREATE TABLE fs_acl (id varchar(36) PRIMARY KEY, fs varchar(64) COLLATE NOCASE NOT NULL, path varchar(512) COLLATE NOCASE NOT NULL, path_hash varchar(64) COLLATE NOCASE NOT NULL, subject_key varchar(200) COLLATE NOCASE NOT NULL, relation varchar(64) COLLATE NOCASE NOT NULL, expires_at datetime, granted_by varchar(100), created_at datetime NOT NULL)';

describe('authz-fs OrmFileAclStore: the connection of fs_acl', function () {
  this.timeout(30000);

  let env: AclOrm | undefined;
  let main: OrmDriver;
  let files: OrmDriver;
  const store = new OrmFileAclStore();

  before(async () => {
    env = await bootAclOrm({ DefaultConnection: 'main', Connections: [sqlite('main'), sqlite('files')], Aliases: { [FS_ACL_CONNECTION]: 'files' } });
    main = env.orm.Connections.get('main')!;
    const other = env.orm.Connections.get('files');
    if (!(other instanceof SqliteOrmDriver)) throw new Error('the connection files is not SQLite');
    files = other;
    await new AuthzFsAcl_2026_10_17_00_00_00().up(main);
    await other.executeOnDb(NOCASE_TABLE, [], QueryContext.Schema);
    await env.orm.reloadTableInfo({ models: [FsAclRecord] });
  });

  after(async () => {
    await env?.close();
  });

  beforeEach(() => {
    env?.config.set(['authz', 'fsAcl'], { connection: 'files' });
  });

  it("reads and writes on the connection db.Aliases['authz-fs-acl'] names", async () => {
    await store.setOwnerIfAbsent('conn', 'a.txt', BOB);
    expect(await files.select().from('fs_acl').where({ fs: 'conn' })).to.have.length(1);
    expect(await main.select().from('fs_acl').where({ fs: 'conn' })).to.have.length(0);
    expect(await store.ownerOf('conn', 'a.txt')).to.deep.equal(BOB);
  });

  it('accepts a connection option that names the same connection, by its name or by the alias', async () => {
    expect(await new OrmFileAclStore({ connection: 'files' }).ownerOf('conn', 'none.txt')).to.equal(null);
    expect(await new OrmFileAclStore({ connection: FS_ACL_CONNECTION }).ownerOf('conn', 'none.txt')).to.equal(null);
  });

  it('refuses a configured connection that is not the one of FsAclRecord, and writes nothing', async () => {
    env?.config.set(['authz', 'fsAcl', 'connection'], 'main');
    const refused = store.grant({ fs: 'refused', path: 'a.txt', subject: ALICE, relation: 'viewer' });
    await expect(refused).to.be.rejectedWith(AuthzConfigError, 'authz.fsAcl.connection');
    await expect(refused).to.be.rejectedWith(`db.Aliases['${FS_ACL_CONNECTION}']`);
    await expect(new OrmFileAclStore({ connection: 'main' }).list('refused', 'a.txt')).to.be.rejectedWith(AuthzConfigError);
    expect(await main.select().from('fs_acl').where({ fs: 'refused' })).to.have.length(0);
    expect(await files.select().from('fs_acl').where({ fs: 'refused' })).to.have.length(0);
  });

  it('refuses a connection the ORM does not have, naming authz.fsAcl.connection', async () => {
    env?.config.set(['authz', 'fsAcl', 'connection'], 'nope');
    await expect(store.ownerOf('conn', 'a.txt')).to.be.rejectedWith(AuthzConfigError, 'authz.fsAcl.connection');
  });

  it('on a case-insensitive table matches rows exactly in code', async () => {
    await store.grant({ fs: 'ci', path: 'Docs/A.txt', subject: ALICE, relation: 'viewer' });
    expect(await store.holds('ci', ['docs/a.txt'], ['user:alice'], 'viewer', new Date())).to.equal(false);
    expect(await store.list('ci', 'docs/a.txt')).to.deep.equal([]);
    await store.deleteTree('ci', 'docs');
    expect(await store.list('ci', 'Docs/A.txt')).to.have.length(1);
  });

  it('on a case-insensitive table movePath moves only the rows of its own filesystem', async () => {
    await store.grant({ fs: 'ci-move', path: 'p.txt', subject: ALICE, relation: 'viewer' });
    await store.grant({ fs: 'CI-MOVE', path: 'p.txt', subject: ALICE, relation: 'viewer' });
    await store.movePath('ci-move', 'p.txt', 'ci-move', 'q.txt');
    expect(await store.list('CI-MOVE', 'p.txt')).to.have.length(1);
    expect(await store.list('ci-move', 'q.txt')).to.have.length(1);
  });
});

describe('authz-fs OrmFileAclStore: without the alias', function () {
  this.timeout(30000);

  let env: AclOrm | undefined;

  before(async () => {
    env = await bootAclOrm({ DefaultConnection: 'main', Connections: [sqlite('main')] });
    await new AuthzFsAcl_2026_10_17_00_00_00().up(env.orm.Connections.get('default')!);
  });

  after(async () => {
    await env?.close();
  });

  it('fails closed, naming the alias to map', async () => {
    const store = new OrmFileAclStore();
    await expect(store.list('fs', 'a.txt')).to.be.rejectedWith(AuthzConfigError, `db.Aliases['${FS_ACL_CONNECTION}']`);
    await expect(store.grant({ fs: 'fs', path: 'a.txt', subject: ALICE, relation: 'viewer' })).to.be.rejectedWith(AuthzConfigError);
    expect(await env?.orm.Connections.get('default')?.select().from('fs_acl')).to.have.length(0);
  });
});
