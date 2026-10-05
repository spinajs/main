// LEDGER cli row 1, moved by C1 task 11: the users command rbac:user-change-password is deleted; authn-local
// ships authn:password (SetUserPassword). Excluded by .mocharc.json; T1 deletes it.
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { User, passwordMatch } from '../../src/index.js';
import { ChangeUserPassword } from '../../src/cli/ChangeUserPassword.js';

describe('rbac cli commands', () => {
  it('rbac:user-change-password brings the Orm up and changes the password', async () => {
    const cmd = await DI.resolve(ChangeUserPassword);
    expect(DI.get(Orm), 'resolving the command boots the Orm').to.not.be.undefined;

    await cmd.execute('test@spinajs.pl', 'NewPassword123');

    const user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(await passwordMatch('NewPassword123')(user)).to.eq(true);
  });
});
