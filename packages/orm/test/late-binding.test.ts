import { useTestApp } from '@spinajs/testing';
import * as chai from 'chai';
import 'mocha';
import { ormApp, registerRelationHydrators } from './misc.js';
import { Orm } from '../src/orm.js';
import { RelationType } from '../src/interfaces.js';
import { OrmException } from '../src/exceptions.js';
import { BelongsToRecursiveRelation, BelongsToRelation, ManyToManyRelation, OneToManyRelation, QueryRelation, VirtualRelation } from '../src/relations.js';
import { relationOf } from '../src/relation-registry.js';
import { isModel } from '../src/model-registry.js';
import { isSelectQuery } from '../src/builders/internal.js';
import { DeleteQueryBuilder, createQuery } from '../src/builders.js';
import { RawModel } from './mocks/models/RawModel.js';
import { RelationModel1 } from './mocks/models/RelationModel1.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

describe('late-bound references that keep @spinajs/orm free of import cycles', () => {
  it('relationOf() returns the class relations.ts registered for each kind', () => {
    expect(relationOf('recursive')).to.equal(BelongsToRecursiveRelation);
    expect(relationOf(RelationType.One)).to.equal(BelongsToRelation);
    expect(relationOf(RelationType.Many)).to.equal(OneToManyRelation);
    expect(relationOf(RelationType.ManyToMany)).to.equal(ManyToManyRelation);
    expect(relationOf(RelationType.Query)).to.equal(QueryRelation);
    expect(relationOf(RelationType.Virtual)).to.equal(VirtualRelation);
  });

  it('relationOf() names a kind nothing registered', () => {
    expect(() => relationOf(99 as RelationType)).to.throw(OrmException, 'no relation class is registered for 99');
  });

  describe('with a resolved Orm', () => {
    useTestApp(() => ormApp({ register: registerRelationHydrators, resolve: [Orm] }));

    it('isModel() tells model instances from plain objects', () => {
      expect(isModel(new RawModel())).to.equal(true);
      expect(isModel({ PrimaryKeyValue: 1 })).to.equal(false);
      expect(isModel(undefined)).to.equal(false);
    });

    it('isSelectQuery() is true for a select builder only', () => {
      expect(isSelectQuery(RawModel.select())).to.equal(true);
      expect(isSelectQuery(createQuery(RawModel, DeleteQueryBuilder).query)).to.equal(false);
      expect(isSelectQuery([1, 2])).to.equal(false);
    });

    it('populate() builds the relation class the registry holds', () => {
      const query = RelationModel1.select().populate('Owner');
      expect(query.Relations[0]).to.be.instanceOf(BelongsToRelation);
    });
  });
});
