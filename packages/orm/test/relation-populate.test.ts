/* eslint-disable prettier/prettier */
import { useTestApp } from '@spinajs/testing';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';

import { FakeSqliteDriver, ormApp, registerRelationHydrators } from './misc.js';
import { RelationType, IRelationDescriptor } from '../src/interfaces.js';
import { OneToManyRelationList } from '../src/relation-objects.js';
import { Orm } from '../src/orm.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { ModelDiscBase } from './mocks/models/ModelDiscBase.js';
import { ModelDisc1 } from './mocks/models/ModelDisc1.js';
import { ModelDisc2 } from './mocks/models/ModelDisc2.js';
import { DualRelationModel } from './mocks/models/DualRelationModel.js';
import '../src/bootstrap.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

async function db() {
  return await DI.resolve(Orm);
}

describe('OneToMany populate', () => {
  useTestApp(() => ormApp({ register: registerRelationHydrators }));

  afterEach(() => {
    sinon.restore();
  });

  function listFor<T extends import('../src/model.js').ModelBase, O extends import('../src/model.js').ModelBase>(owner: O, target: any, foreignKey: string, name = 'Items'): OneToManyRelationList<T, O> {
    return new OneToManyRelationList<T, O>(owner, {
      TargetModel: target,
      TargetModelType: target,
      Name: name,
      Type: RelationType.Many,
      SourceModel: owner.constructor as any,
      ForeignKey: foreignKey,
      PrimaryKey: 'Id',
      Recursive: false,
    } as IRelationDescriptor);
  }

  it('does not mark the owner dirty', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(
      Promise.resolve([
        { Id: 1, Bar: 'a' },
        { Id: 2, Bar: 'b' },
      ]),
    );

    const owner = new Model4({ Id: 1 });
    owner.takeSnapshot();

    const list = listFor<Model1, Model4>(owner, Model1, 'OwnerId');
    await list.populate();

    expect(list.length).to.eq(2);
    expect(owner.IsDirty, 'loading a relation is a read and must not flag unsaved changes').to.be.false;
  });

  it('fills the relation instance populate was called on', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(Promise.resolve([{ Id: 7, Bar: 'x' }]));

    const owner = new Model4({ Id: 1 });
    const list = listFor<Model1, Model4>(owner, Model1, 'OwnerId');

    await list.populate();

    expect(list.map((m) => m.Id)).to.deep.eq([7]);
    expect(list.Populated).to.be.true;
  });

  it('sets the back-reference of each loaded member to the owner', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(Promise.resolve([{ Id: 7, Bar: 'x' }]));

    const owner = new Model4({ Id: 1 });
    const list = listFor<Model1, Model4>(owner, Model1, 'OwnerId');

    await list.populate();

    expect(list[0].Owner.Value).to.eq(owner);
  });

  it('keeps discriminated subclass rows instead of silently dropping them', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(
      Promise.resolve([
        { Id: 1, disc_key: 'one', Value: 'a' },
        { Id: 2, disc_key: 'two', Value: 'b' },
      ]),
    );

    const owner = new Model4({ Id: 1 });
    const list = listFor<ModelDiscBase, Model4>(owner, ModelDiscBase, 'owner_id');

    await list.populate();

    expect(list.length, 'discriminated rows must stay in the relation').to.eq(2);
    expect(list[0]).to.be.instanceOf(ModelDisc1);
    expect(list[1]).to.be.instanceOf(ModelDisc2);
  });

  it('does not push loaded rows into a sibling relation with the same target model', async () => {
    await db();

    sinon.stub(FakeSqliteDriver.prototype, '_execute_for_test').returns(Promise.resolve([{ Id: 7, Bar: 'x' }]));

    const owner = new DualRelationModel({ Id: 1 });

    await owner.Many.populate();

    expect(owner.Many.length).to.eq(1);
    expect(owner.OtherMany.length, 'sibling relation must stay untouched').to.eq(0);
  });
});
