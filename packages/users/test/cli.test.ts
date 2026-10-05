import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { join, normalize, resolve } from 'path';

import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User } from '../src/index.js';
import { FindUser } from '../src/cli/FindUser.js';
import { CreateUser } from '../src/cli/CreateUser.js';
import { SYSTEM } from '@spinajs/authz';
import { globalRolesOf, registerAuthzHost, rootAuthz } from './support/authz-host.js';
import { TestConfiguration } from './common.test.js';
import './migration/rbac.migration.js';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The cli resolves only the command it runs, and nothing resolves the Orm for it - unlike every
 * other test here, these deliberately never call `DI.resolve(Orm)` themselves. A command that
 * does not bring the Orm up runs against bare models, whose statics throw "Not implemented".
 */
describe('rbac cli commands', function () {
  this.timeout(15000);

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('rbac:user-find brings the Orm up and reports the user', async () => {
    const cmd = await DI.resolve(FindUser);
    const info = sinon.spy((cmd as unknown as { Log: { info: (m: string) => void } }).Log, 'info');

    await cmd.execute({ identifier: 'test@spinajs.pl' });

    expect(info.calledOnce).to.eq(true);
    expect(info.firstCall.args[0]).to.contain('test@spinajs.pl');
  });

  it('rbac:user-create grants its roles through AuthzAdmin as SYSTEM, under runAs(SYSTEM, cli)', async () => {
    const cmd = await DI.resolve(CreateUser);
    const runAs = sinon.spy(await rootAuthz(), 'runAs');

    await cmd.execute({ email: 'cli@spinajs.pl', login: 'cli', roles: 'user,editor', password: 'passw0rd123' });

    expect(runAs.calledOnce).to.eq(true);
    expect(runAs.firstCall.args.slice(0, 2)).to.deep.eq([SYSTEM, 'cli']);
    const user = await User.query().whereLogin('cli').firstOrFail();
    expect(await globalRolesOf(user.Uuid)).to.have.members(['user', 'editor']);
  });

  it('rbac:user-create reports a refused role and creates nothing', async () => {
    const cmd = await DI.resolve(CreateUser);
    const error = sinon.spy((cmd as unknown as { Log: { error: (m: string) => void } }).Log, 'error');

    await cmd.execute({ email: 'cli-bad@spinajs.pl', login: 'cli-bad', roles: 'not-a-role', password: 'passw0rd123' });

    expect(error.calledOnce).to.eq(true);
    expect(await User.query().whereLogin('cli-bad').first()).to.not.exist;
  });
});
