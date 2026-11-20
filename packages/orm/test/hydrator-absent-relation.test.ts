import './../src/bootstrap.js';
import '@spinajs/log';
import { OneToOneRelationHydrator, ModelHydrator } from './../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { Orm } from '../src/index.js';
import { ormApp, FakeServerResponseMapper } from './misc.js';
import { ServerResponseMapper } from '../src/interfaces.js';
import { useTestApp } from '@spinajs/testing';
import * as chai from 'chai';
import 'mocha';

const expect = chai.expect;

// The relation hydrator itself: a row read from the database is not a Partial<Model1>.
function hydrated(row: object): Model4 | null | undefined {
  const m = new Model1();
  new OneToOneRelationHydrator().hydrate(m, row);
  return m.Owner.Value;
}

describe('Hydrator: when a belongsTo row counts as absent', () => {
  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(OneToOneRelationHydrator).as(ModelHydrator);
        c.register(FakeServerResponseMapper).as(ServerResponseMapper);
      },
      resolve: [Orm],
    }),
  );

  it('a row of nulls is absent', () => {
    expect(hydrated({ Owner: { Id: null, Data: null } })).to.equal(undefined);
  });

  it('a parsed JSON object is data, even when its own members are null', () => {
    const value = hydrated({ Owner: { Id: null, Data: { note: null } } });

    expect(value).to.be.instanceOf(Model4);
    expect(value).to.have.deep.property('Data', { note: null });
  });
});
