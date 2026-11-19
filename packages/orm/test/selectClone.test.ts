import { NewInstance } from '@spinajs/di';
import { useTestApp } from '@spinajs/testing';
import { expect } from 'chai';
import 'mocha';
import { ormApp, registerRelationHydrators } from './misc.js';
import { Orm } from '../src/orm.js';
import { SelectQueryBuilder } from '../src/builders.js';
import { RawModel } from './mocks/models/RawModel.js';
import '../src/bootstrap.js';
import '@spinajs/log';

@NewInstance()
class MarkedSelectQueryBuilder<T = unknown> extends SelectQueryBuilder<T> {}

function select(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
}

describe('SelectQueryBuilder.clone()', () => {
  describe('with a subclass registered for SelectQueryBuilder', () => {
    useTestApp(() =>
      ormApp({
        register: (c) => {
          registerRelationHydrators(c);
          c.register(MarkedSelectQueryBuilder).as(SelectQueryBuilder);
        },
        resolve: [Orm],
      }),
    );

    it('a model query is built from the registered class', () => {
      expect(RawModel.query()).to.be.instanceOf(MarkedSelectQueryBuilder);
    });

    it('a clone is built from the registered class too', () => {
      expect(RawModel.query().clone()).to.be.instanceOf(MarkedSelectQueryBuilder);
    });

    it('a clone is a new builder on the table of its source', () => {
      const source = select(RawModel.query());
      const clone = source.clone();

      expect(clone).to.not.equal(source);
      expect(clone.Table).to.equal(source.Table);
    });
  });

  describe('groupWhere()', () => {
    useTestApp(() => ormApp({ register: registerRelationHydrators, resolve: [Orm] }));

    it('wraps the where statements so far into one group', () => {
      const query = select(RawModel.where('Id', 1).orWhere('Id', 2));

      expect(query.groupWhere()).to.equal(query);
      expect(query.Statements).to.have.length(1);
    });

    it('leaves a query without conditions as it is', () => {
      const query = select(RawModel.query());
      const statements = query.Statements.length;

      expect(query.groupWhere().Statements).to.have.length(statements);
    });
  });
});
