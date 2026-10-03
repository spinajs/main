import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { join, normalize, resolve } from 'path';

import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, passwordMatch } from '../src/index.js';
import { ChangeUserPassword } from '../src/cli/ChangeUserPassword.js';
import { FindUser } from '../src/cli/FindUser.js';
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

  it('rbac:user-change-password brings the Orm up and changes the password', async () => {
    const cmd = await DI.resolve(ChangeUserPassword);
    expect(DI.get(Orm), 'resolving the command boots the Orm').to.not.be.undefined;

    await cmd.execute('test@spinajs.pl', 'NewPassword123');

    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(await passwordMatch('NewPassword123')(user)).to.eq(true);
  });

  it('rbac:user-find brings the Orm up and reports the user', async () => {
    const cmd = await DI.resolve(FindUser);
    const info = sinon.spy((cmd as unknown as { Log: { info: (m: string) => void } }).Log, 'info');

    await cmd.execute({ identifier: 'test@spinajs.pl' });

    expect(info.calledOnce).to.eq(true);
    expect(info.firstCall.args[0]).to.contain('test@spinajs.pl');
  });
});
