import * as chai from 'chai';
import _ from 'lodash';
import 'mocha';
import { MetaTest } from './mocks/models/MetaTest.js';
import { Meta } from './mocks/models/Meta.js';

/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import { useTestApp } from '@spinajs/testing';
import { ormApp } from './misc.js';
import * as sinon from 'sinon';
import { _modelProxyFactory } from './../src/model.js';
import './../src/bootstrap.js';
import { Orm } from '../src/orm.js';

const expect = chai.expect;

async function db() {
  return await DI.resolve(Orm);
}

describe('Metadata', () => {
  useTestApp(() => ormApp({ resolve: [Orm] }));

  afterEach(() => {
    sinon.restore();
  });

  it('Should model convert value', async () => {});

  it('Should set meta in relation', async () => {
    await db();

    const m = new MetaTest();
    m.Metadata['test:meta'] = 1234;
    expect(m.Metadata['test:meta']).to.eq(1234);
  });

  it('Should delete meta in relation', async () => {

    await db();

    const m = new MetaTest();
    m.Metadata['test:meta'] = 1234;
    expect(m.Metadata['test:meta']).to.eq(1234);

    m.Metadata["test:meta"] = null;
    expect(m.Metadata['test:meta']).to.be.null;

  });

  it('Should set multiple meta', async () => {

    await db();

    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    m.Metadata['test:meta:*'] = 999;

    expect(m.Metadata['test:meta:aa']).to.eq(999);
    expect(m.Metadata['test:meta:a']).to.eq(999);
    expect(m.Metadata['test:meta:b']).to.eq(999);
    expect(m.Metadata['test:meta:c']).to.eq(999);
    expect(m.Metadata['test:meta:d']).to.eq(999);


  });

  it('Should delete multiple meta in relation', () => {

    
    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    m.Metadata['test:meta:*'] = null;

    expect(m.Metadata['test:meta:aa']).to.be.null;
    expect(m.Metadata['test:meta:a']).to.be.null;
    expect(m.Metadata['test:meta:b']).to.be.null;
    expect(m.Metadata['test:meta:c']).to.be.null;
    expect(m.Metadata['test:meta:d']).to.be.null;

    expect(m.Metadata.length).to.eq(0);

  });

  it('Should get multiple meta', () => {

    const m = new MetaTest();
    m.Metadata['test:meta:aa'] = 1;
    m.Metadata['test:meta:a'] = 2;
    m.Metadata['test:meta:b'] = 3;
    m.Metadata['test:meta:c'] = 4;
    m.Metadata['test:meta:d'] = 5;

    expect(m.Metadata['test:meta:aa']).to.eq(1);

    const ms = m.Metadata['test:meta:*'] as number[];
    expect(ms.length).to.equal(5);
    expect(ms[4]).to.equal(5);
  });

  it('MetadataModel getType classifies null as string not json', async () => {
    await db();

    const meta = new Meta();
    meta.Value = null;

    expect(meta.Type).to.eq('string');
  });

  it('MetadataRelation.delete uses the relation foreign key not a hardcoded column', async () => {
    await db();

    const m = new MetaTest({ Id: 42 });
    const fk = (m.Metadata as any).Relation.ForeignKey;

    // sanity - this relation's FK is not the hardcoded 'user_id'
    expect(fk).to.eq('metatest_id');

    const firstStub = sinon.stub().resolves(null);
    const whereStub = sinon.stub(Meta, 'where').returns({ first: firstStub } as any);

    await m.Metadata.delete('somekey');

    expect(whereStub.calledOnce).to.be.true;
    const arg = whereStub.firstCall.args[0] as any;
    expect(arg).to.have.property(fk, 42);
    expect(arg).to.not.have.property('user_id');
  });
});
