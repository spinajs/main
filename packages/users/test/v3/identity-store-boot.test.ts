import 'mocha';
import { Readable } from 'node:stream';
import { join, normalize, resolve } from 'path';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, OrmMigrator } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { IdentityStore, PasswordCredentialStore, PasswordService } from '@spinajs/authn/contracts';
import type { PasswordAgeSource } from '@spinajs/authn-local';
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

// A03: a cli process resolves only the command it runs; nothing else boots the
// Orm, so the store must, or the login lookup runs against bare models whose statics throw "Not implemented". Like
// cli.test.ts, these never resolve the Orm themselves. Run alone, the file is the fresh process the bug needs.
// The test database is created by OrmMigrator once the store booted the Orm, as a deploy would have migrated it.
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
    // Drops the connection lookups an earlier suite's Orm registered, to be the fresh process this describes.
    for (const lookup of [...(DI.getRegisteredTypes('OrmConnection') ?? [])]) {
      DI.unregister('OrmConnection', lookup);
    }

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
    DI.uncache(PasswordCredentialStore);
    DI.uncache(UserPasswordStore);
    DI.uncache(UserPasswordAgeSource);
    DI.uncache(OrmMigrator);
  });

  async function migrate(): Promise<void> {
    expect(DI.get(Orm), 'the store booted the Orm').to.not.be.undefined;
    await (await DI.resolve(Orm)).Migrator.ready();
  }

  it('brings the Orm up through it, so the login lookup does not run against bare models', async () => {
    const store = await DI.resolve(IdentityStore);
    await migrate();
    const ref = await store.findByLogin('test@spinajs.pl');

    expect(ref).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
  });

  it('authn:password finds the user and sets the piped password', async () => {
    // The command injects OrmMigrator, which boots the Orm and migrates the test database on its way in.
    const command = await DI.resolve(PipedSetUserPassword);
    expect(DI.get(Orm), 'the command booted the Orm').to.not.be.undefined;

    await command.execute('test@spinajs.pl', {});

    expect(passwordCalls.map((c) => [c.method, c.id])).to.deep.eq([['set', { type: 'user', id: TEST_USER_UUID }]]);
    expect(await testHasher.verify((await storedUser(TEST_USER_UUID)).Password, PIPED)).to.eq(true);
  });

  // authn:password-expire resolves only PasswordExpirationJob, which reads the age source first.
  it('the password age source brings the Orm up too', async () => {
    const source: PasswordAgeSource = await DI.resolve(UserPasswordAgeSource);
    await migrate();
    const ids = await source.passwordsSetBefore(new Date(Date.now() + 86_400_000));

    expect(ids).to.deep.include({ type: 'user', id: TEST_USER_UUID });
  });

  it('the password store brings the Orm up too', async () => {
    const store = await DI.resolve(UserPasswordStore);
    await migrate();
    const stored = await store.get({ type: 'user', id: TEST_USER_UUID });

    expect(stored).to.be.a('string');
  });
});
