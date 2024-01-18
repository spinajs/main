/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from './../src/index.js';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);
describe('Sqlite - relations test', function () {
  this.timeout(10000);
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
  });

  
  it('should find diff  in oneToMany', async () => {
    await db();

     

    await setA.diff(setB);
    expect(setA.length).to.eq(3);
    expect(setA[0].Id).to.eq(3);
    expect(setA[1].Id).to.eq(4);
    expect(setA[2].Id).to.eq(2);
  });

  it('should set  in oneToMany', async () => {
    await db();
 

    await setA.set(setB);
    expect(setA.length).to.eq(3);
    expect(setA[0].Id).to.eq(1);
    expect(setA[1].Id).to.eq(3);
    expect(setA[2].Id).to.eq(4);
  });

  it('should find intersection in oneToMany', async () => {
    await db();

    

    await setA.intersection(setB);
    expect(setA.length).to.eq(1);
    expect(setA[0].Id).to.eq(1);
  });

  it('Should union two relations  in oneToMany', async () => {
    await db();

  

    await setA.union(setB);
    expect(setA.length).to.eq(4);
    expect(setA[0].Id).to.eq(1);
    expect(setA[1].Id).to.eq(2);
    expect(setA[2].Id).to.eq(3);
    expect(setA[3].Id).to.eq(4);
  });

});