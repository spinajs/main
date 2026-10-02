import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';

import './migration/rbac.migration.js';
import { ResourceModel } from './models/ResourceModel.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('Model ownership helpers', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  async function seed() {
    const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    const owned = new ResourceModel({ UserId: owner.Id });
    await owned.insert();

    const foreign = new ResourceModel({ UserId: owner.Id + 999 });
    await foreign.insert();

    return { owner, owned, foreign };
  }

  it('checkOwnership(primaryKey) returns true for an owned resource', async () => {
    const { owner, owned } = await seed();
    expect(await (ResourceModel as any).checkOwnership(owned.Id, owner)).to.be.true;
  });

  it('checkOwnership(primaryKey) returns false for a resource owned by someone else', async () => {
    const { owner, foreign } = await seed();
    expect(await (ResourceModel as any).checkOwnership(foreign.Id, owner)).to.be.false;
  });

  it('checkOwnership(model) returns true when the model instance is owned', async () => {
    const { owner, owned } = await seed();
    expect(await (ResourceModel as any).checkOwnership(owned, owner)).to.be.true;
  });

  it('checkOwnership(model) returns false when the model instance is not owned', async () => {
    const { owner, foreign } = await seed();
    expect(await (ResourceModel as any).checkOwnership(foreign, owner)).to.be.false;
  });

  it('ensureOwnership restricts a query to rows owned by the user', async () => {
    const { owner } = await seed();

    const rows = await (ResourceModel as any).ensureOwnership(ResourceModel.select(), owner);

    expect(rows).to.be.an('array').with.length(1);
    expect(rows[0].UserId).to.eq(owner.Id);
  });

  it('throws when the model has no @ResourceOwner() field', async () => {
    const owner = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(() => (User as any).ensureOwnership(User.select(), owner)).to.throw();
  });
});
