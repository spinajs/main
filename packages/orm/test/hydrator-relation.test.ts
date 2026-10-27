/* eslint-disable prettier/prettier */
import './../src/bootstrap.js';
import '@spinajs/log';
import { OneToOneRelationHydrator, ModelHydrator } from './../src/hydrators.js';
import { Model1 } from './mocks/models/Model1.js';
import { Model4 } from './mocks/models/Model4.js';
import { SingleRelation } from './../src/relation-objects.js';
import { Orm } from '../src/index.js';
import { ormApp, FakeServerResponseMapper } from './misc.js';
import { ServerResponseMapper } from '../src/interfaces.js';
import { useTestApp } from '@spinajs/testing';
import * as chai from 'chai';
import 'mocha';

const expect = chai.expect;

describe('Hydrator relation translation', () => {
  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(OneToOneRelationHydrator).as(ModelHydrator);
        c.register(FakeServerResponseMapper).as(ServerResponseMapper);
      },
      resolve: [Orm], // populates model descriptors' Columns from table info
    }),
  );

  it('translates a model instance on a FK column to its primary key value', () => {
    const owner = new Model4();
    owner.Id = 42;

    const m = new Model1();
    m.hydrate({ OwnerId: owner } as any);

    expect((m as any).OwnerId).to.equal(42);
  });

  it('still assigns a raw scalar FK value unchanged', () => {
    const m = new Model1();
    m.hydrate({ OwnerId: 7 } as any);

    expect((m as any).OwnerId).to.equal(7);
  });

  it('accepts a model instance under the relation name and sets the FK + relation', () => {
    const owner = new Model4();
    owner.Id = 9;

    const m = new Model1();
    m.hydrate({ Owner: owner } as any);

    expect((m.Owner as unknown as SingleRelation<Model4>).Value).to.equal(owner);
    expect((m as any).OwnerId).to.equal(9);
  });
});
