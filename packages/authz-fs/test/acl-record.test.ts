import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { extractModelDescriptor, modelDriver } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AuthzFsAcl_2026_10_17_00_00_00, FS_ACL_CONNECTION, FS_ACL_TABLE, FsAclRecord } from '../src/index.js';
import { aclPathHash } from '../src/acl/shared.js';
import { bootAclOrm, sqlite } from './support/acl-orm.js';
import type { AclOrm } from './support/acl-orm.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

describe('authz-fs FsAclRecord', function () {
  this.timeout(30000);

  let env: AclOrm | undefined;
  let db: OrmDriver;

  before(async () => {
    env = await bootAclOrm({ DefaultConnection: 'main', Connections: [sqlite('main')], Aliases: { [FS_ACL_CONNECTION]: 'default' } });
    db = env.orm.Connections.get('default')!;
    await new AuthzFsAcl_2026_10_17_00_00_00().up(db);
    // The table was made after the boot, by hand: the model has no columns until the ORM reads it.
    await env.orm.reloadTableInfo({ models: [FsAclRecord] });
  });

  after(async () => {
    await env?.close();
  });

  it('is the model of fs_acl on the connection alias authz-fs-acl', () => {
    const d = extractModelDescriptor(FsAclRecord);
    expect(FS_ACL_CONNECTION).to.equal('authz-fs-acl');
    expect(d?.TableName).to.equal(FS_ACL_TABLE);
    expect(d?.Connection).to.equal(FS_ACL_CONNECTION);
    expect(modelDriver(FsAclRecord)).to.equal(db);
  });

  it('has one key column, id, which the caller assigns', async () => {
    const d = extractModelDescriptor(FsAclRecord);
    expect(d?.PrimaryKey).to.deep.equal(['id']);
    expect(d?.PrimaryKeyGeneration.get('id')).to.equal('assigned');
    await expect(FsAclRecord.insert({ fs: 'rec', path: 'a.txt', path_hash: aclPathHash('a.txt'), subject_key: 'user:alice', relation: 'viewer' })).to.be.rejectedWith('must be assigned before insert');
  });

  it('declares the columns of the migration; only the two datetimes are converted', () => {
    const d = extractModelDescriptor(FsAclRecord);
    expect(d?.Columns.map((c) => c.Name).sort()).to.deep.equal(['created_at', 'expires_at', 'fs', 'granted_by', 'id', 'path', 'path_hash', 'relation', 'subject_key']);
    expect([...(d?.Converters.keys() ?? [])].sort()).to.deep.equal(['created_at', 'expires_at']);
  });
});
