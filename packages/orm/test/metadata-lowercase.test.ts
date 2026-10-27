import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { useTestApp } from '@spinajs/testing';
import { ormApp } from './misc.js';
import { Orm } from '../src/orm.js';
import { LowercaseMeta } from './mocks/models/LowercaseMeta.js';
import { LowercaseMetaOwner } from './mocks/models/LowercaseMetaOwner.js';
import './../src/bootstrap.js';

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('MetadataRelation lowercase columns', () => {
  useTestApp(() => ormApp());

  it('Should report the value as changed when it is set through the metadata proxy', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'old', owner_id: 13276 } as any);
    existing.takeSnapshot();
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'new';

    expect(existing.value).to.eq('new');
    expect(existing.IsDirty).to.be.true;
    expect(existing.changeSet()).to.deep.equal([{ Column: 'value', OldValue: 'old', NewValue: 'new' }]);
  });

  it('Should NOT report a change when the value is unchanged', async () => {
    await db();

    const owner = new LowercaseMetaOwner();
    const existing = new LowercaseMeta({ key: 'foo', value: 'same', owner_id: 13276 } as any);
    existing.takeSnapshot();
    (owner.Metadata as any).push(existing);

    owner.Metadata['foo'] = 'same';

    expect(existing.IsDirty).to.be.false;
  });

  it('Should emit FK in toSql when BelongsTo.Value is null', async () => {
    await db();

    const meta = new LowercaseMeta({ key: 'foo', value: 'bar', owner_id: 13276 } as any);
    const sql = meta.toSql() as Record<string, unknown>;

    expect(sql.owner_id).to.eq(13276);
  });

  it('Should prefer BelongsTo.Value over raw FK in toSql', async () => {
    await db();

    const newOwner = new LowercaseMetaOwner({ id: 999 } as any);
    const meta = new LowercaseMeta({ key: 'foo', value: 'bar', owner_id: 1 } as any);
    (meta as any).Owner.Value = newOwner;

    const sql = meta.toSql() as Record<string, unknown>;

    expect(sql.owner_id).to.eq(999);
  });
});
