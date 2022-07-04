import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration } from './common';
//import { Test } from './models/Test';
import '../src/index';
//import { DbTranslationSource } from '../src/index';
import { AsyncLocalStorage } from 'async_hooks';
import { Test2 } from './models/Test2';

chai.use(chaiAsPromised);

describe('ORM intl tests', () => {
  before(async () => {
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  // it('Should load translation for model', async () => {
  //   const result = await Test.where('Id', 1).translate('en_GB').first();
  //   expect(result).to.be.not.null;
  //   expect(result.Text).to.eq('hello');
  // });

  // it('Should load translation for multiple models', async () => {
  //   const result = await Test.where('Id', '>', 0).translate('en_GB');
  //   expect(result).to.be.not.null;
  //   expect(result).to.be.an('array');
  //   expect(result[0].Text).to.eq('hello');
  //   expect(result[1].Text).to.eq('world');
  // });

  // it('Should translate populated one to many data', async () => {
  //   const result = await Test.where('Id', '>', 0).populate('Data').translate('en_GB');

  //   expect(result).to.be.not.null;
  //   expect(result).to.be.an('array');
  //   expect(result[0].Text).to.eq('hello');
  //   expect(result[1].Text).to.eq('world');

  //   expect(result[0].Data[0].Text).to.eq('one');
  //   expect(result[1].Data[0].Text).to.eq('two');
  // });

  // it('Should translate when using async storage', async () => {
  //   const store = DI.resolve(AsyncLocalStorage);
  //   const result = await store.run(
  //     {
  //       language: 'en_GB',
  //     },
  //     async () => {
  //       return await Test.where('Id', '>', 0).populate('Data');
  //     },
  //   );

  //   expect(result).to.be.not.null;
  //   expect(result).to.be.an('array');
  //   expect(result[0].Text).to.eq('hello');
  //   expect(result[1].Text).to.eq('world');

  //   expect(result[0].Data[0].Text).to.eq('one');
  //   expect(result[1].Data[0].Text).to.eq('two');
  // });

  // it('Should save translations', async () => {
  //   let result = await Test.where('Id', 1).first();

  //   result.Language = 'en_US';
  //   result.Text = 'hello from us';

  //   await result.update();

  //   result.Text = 'hello from us 1';
  //   await result.update();

  //   result = await Test.where('Id', 1).translate('en_US').first();

  //   expect(result.Text).to.eq('hello from us 1');

  //   result = await Test.where('Id', 1).first();
  //   expect(result.Text).to.eq('witaj');
  // });

  // it('Should save translations automatically', async () => {
  //   let result = await Test.where('Id', 1).first();

  //   const store = DI.resolve(AsyncLocalStorage);
  //   await store.run(
  //     {
  //       language: 'en_US',
  //     },
  //     async () => {
  //       result.Text = 'hello from us';
  //       await result.update();

  //       result.Text = 'hello from us 1';
  //       await result.update();
  //     },
  //   );

  //   result = await Test.where('Id', 1).translate('en_US').first();

  //   expect(result.Text).to.eq('hello from us 1');

  //   result = await Test.where('Id', 1).first();
  //   expect(result.Text).to.eq('witaj');
  // });

  it('Should translate belongsTo relation automatically', async () => {
    const store = DI.resolve(AsyncLocalStorage);
    const result = await store.run(
      {
        language: 'en_GB',
      },
      async () => {
        return await Test2.where('Id', '>', 0).populate('Owner');
      },
    );

    expect(result).to.be.not.null;
    expect(result).to.be.an('array');

    expect(result[0].Owner.Text).to.eq('owner hello');
  });


  // it('Should load translations for entity', async () => {
  //   const result = await Test.where('Id', 1).first();
  //   await result.translate('en_GB');

  //   expect(result.Text).to.eq('hello');
  // });

  // it('Should load from translations source', async () => {
  //   const source = DI.resolve(DbTranslationSource);
  //   const result = await source.load();

  //   expect(result['en_US']['hello world']).to.be.eq('bla bla');
  //   expect(result['de_DE']['hello world']).to.be.eq('bla bla german');
  // });
});
