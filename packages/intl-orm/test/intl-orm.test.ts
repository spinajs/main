import { BasicPasswordProvider } from '../src/password';
import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common';
import { Test } from './models/Test';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

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

  it('Should load translation for model', async () => {
    const result = await Test.query().where('Id', 1).translate('en_GB').first();
    expect(result).to.be.not.null;
  });
});
