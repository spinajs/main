// LEDGER actions-fundamentals rows 23 and 24, moved by C1 task 11: confirmPasswordReset now redeems through
// PasswordService, and passwordChangeRequest stores no token in metadata. Excluded by .mocharc.json; T1 deletes it.
import { BasicPasswordProvider } from '../../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserChanged, USER_COMMON_METADATA } from '../../src/index.js';
import { getUser, getUserUnsafe, getUsersByRole, setUserMeta, getUserMeta, updateUser, verifyPassword, roleList, assertNoProtectedMetadata, assertUserUnique, create, ban, passwordChangeRequest, confirmPasswordReset } from '../../src/actions.js';
import { MetadataNotFound, TokenInvalid, UserAlreadyExists } from '../../src/exceptions.js';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from '../common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import '../migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { UserMetadataChange } from '../../src/events/UserMetadataChange.js';
import { UserCreated } from '../../src/events/UserCreated.js';
import { DateTime } from 'luxon';
import { registerAuthzHost } from '../support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('actions fundamentals ( imperative helpers )', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    DI.clearCache();
  });

  describe('audit finding regressions', () => {
    // Regression for R1 ( fixed, same root cause ): an expired ban no longer
    // blocks completing a password reset.
    it('R1: confirmPasswordReset() accepts a user whose ban has expired', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await ban('test@spinajs.pl', 'expired', 10);
      let u = await getUser('test@spinajs.pl');
      u.Metadata[USER_COMMON_METADATA.USER_BAN_START_DATE] = DateTime.now().minus({ hours: 1 });
      await u.Metadata.update();

      await passwordChangeRequest('test@spinajs.pl');
      u = await getUser('test@spinajs.pl');
      const token = u.Metadata[USER_COMMON_METADATA.USER_PWD_RESET_TOKEN] as string;

      await expect(confirmPasswordReset('test@spinajs.pl', 'brandNew123', token)).to.be.fulfilled;
    });

    // Regression for R3 ( fixed ): exception payloads carry the user uuid
    // only - never the stored reset token or the full model.
    it('R3: TokenInvalid does not leak the stored reset token', async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      await passwordChangeRequest('test@spinajs.pl');

      const err = await confirmPasswordReset('test@spinajs.pl', 'brandNew123', 'not-the-token').catch((e) => e);

      expect(err).to.be.instanceOf(TokenInvalid);
      const u = await getUser('test@spinajs.pl');
      expect((err as TokenInvalid).data).to.deep.eq({ user: u.Uuid });
    });

  });
});
