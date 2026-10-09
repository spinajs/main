import 'mocha';
import { Readable } from 'node:stream';
import { join, normalize, resolve } from 'path';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { IdentityStore, PasswordService } from '@spinajs/authn/contracts';
import { expect } from 'chai';
import * as sinon from 'sinon';

// The package entry does not export the cli commands; the built file is the module `@spinajs/authn-local` resolves to.
import { SetUserPassword } from '../../../authn-local/lib/mjs/cli/SetUserPassword.js';

import { UserPasswordAgeSource, UserPasswordStore } from '../../src/index.js';
import { TEST_USER_UUID } from '../migration/rbac.migration.js';
import { passwordCalls, resetPasswordCalls } from '../support/password-service.js';
import { testHasher } from '../support/hasher.js';
import { registerUsersTestHost, releaseUsersHost, storedUser } from '../support/users-db.js';

const PIPED = 'Piped-Password-3';

class PipedSetUserPassword extends SetUserPassword {
  protected input(): NodeJS.ReadableStream {
    return Readable.from([`${PIPED}\n`]);
  }
}

// Ported from legacy-v2/cli.test.ts row 1 (A03). A cli process resolves only the command it runs; nothing else boots the
// Orm, so the store must, or the login lookup runs against bare models whose statics throw "Not implemented". Like
// cli.test.ts, these never resolve the Orm themselves. Run alone, the file is the fresh process the bug needs.
describe('a cli command that resolves only the IdentityStore', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    resetPasswordCalls();
    releaseUsersHost();
    DI.uncache(IdentityStore);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration, [null, null, [resolve(normalize(join(process.cwd(), 'test', './config')))]]);

    expect(DI.get(Orm), 'nothing booted the Orm yet').to.be.undefined;
  });

  afterEach(() => {
    sinon.restore();
    releaseUsersHost();
    DI.uncache(IdentityStore);
    DI.uncache(PasswordService);
    DI.uncache(PipedSetUserPassword);
  });

  it('brings the Orm up through it, so the login lookup does not run against bare models', async () => {
    const ref = await DI.resolve(IdentityStore).findByLogin('test@spinajs.pl');

    expect(DI.get(Orm)).to.not.be.undefined;
    expect(ref).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
  });

  it('authn:password finds the user and sets the piped password', async () => {
    const command = await DI.resolve(PipedSetUserPassword);

    await command.execute('test@spinajs.pl', {});

    expect(DI.get(Orm)).to.not.be.undefined;
    expect(passwordCalls.map((c) => [c.method, c.id])).to.deep.eq([['set', { type: 'user', id: TEST_USER_UUID }]]);
    expect(await testHasher.verify((await storedUser(TEST_USER_UUID)).Password, PIPED)).to.eq(true);
  });

  // authn:password-expire resolves only PasswordExpirationJob, which reads the age source first.
  it('the password age source brings the Orm up too', async () => {
    const ids = await new UserPasswordAgeSource().passwordsSetBefore(new Date(Date.now() + 86_400_000));

    expect(DI.get(Orm)).to.not.be.undefined;
    expect(ids).to.deep.include({ type: 'user', id: TEST_USER_UUID });
  });

  it('the password store brings the Orm up too', async () => {
    const stored = await new UserPasswordStore().get({ type: 'user', id: TEST_USER_UUID });

    expect(DI.get(Orm)).to.not.be.undefined;
    expect(stored).to.be.a('string');
  });
});
