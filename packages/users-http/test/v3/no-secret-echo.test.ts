import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Log, MemoryTarget } from '@spinajs/log';
import { DefaultQueueService } from '@spinajs/queue';
import { User } from '@spinajs/users';

import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Users } from '../../src/admin/controllers/Users/Users.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { RoleDefs, Res, UsersHttpApp } from '../support/http-app.js';
import { REAUTH_STRATEGIES } from '../support/reauth-strategy.js';

const MEMORY = 'UsersHttpNoSecretEcho';

function logLines(): string[] {
  return ((DI.get(MemoryTarget) as MemoryTarget | undefined)?.getRecords() ?? []).map((r) => JSON.stringify(r));
}

/**
 * A route body failing schema validation answers 400 with the path, the rule and the message of each failure, never a
 * value: `reauthPassword` rides in the same body as the field that failed.
 */
describe('users-http v3: no password in validation 400s', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let admin: User;
  let seq = 0;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [Users, Security],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        member: {},
        'echo-admin': { grants: ['users:read', 'users:update', 'users:delete', 'users:credentials'] },
      }),
      config: { 'authn.strategies': REAUTH_STRATEGIES },
    });

    admin = await app.seedUser({ login: 'echo-admin', roles: ['echo-admin'] });

    // Loggers are cached by name for the whole process: attach to the live ones rather than configure a target.
    for (const logger of Log.Loggers.values()) {
      logger.addTarget({ name: MEMORY, type: 'MemoryTarget', limit: 100000 } as any);
    }
  });

  beforeEach(() => {
    (DI.get(MemoryTarget) as MemoryTarget | undefined)?.clear();
  });

  after(async () => {
    for (const logger of Log.Loggers.values()) {
      await logger.removeTarget(MEMORY);
    }
    await stopUsersHttpApp();
    sinon.restore();
  });

  const target = () => app.seedUser({ login: `echo-target-${++seq}`, roles: ['member'] });

  function expectNowhere(res: Res, secrets: string[]): void {
    const lines = logLines();
    expect(lines, 'the error handler logged nothing').to.not.be.empty;
    for (const secret of secrets) {
      expect(res.text.includes(secret), `response holds ${secret}: ${res.text}`).to.eq(false);
      for (const line of lines) {
        expect(line.includes(secret), `log holds ${secret}: ${line}`).to.eq(false);
      }
    }
  }

  it('PATCH /users/:uuid with reauthPassword and an invalid Email: 400, the password nowhere', async () => {
    const t = await target();
    const reauthPassword = 'Zq7usrReauthWk4Pn';
    const email = 'not-an-email-Zq7usrMail';

    const res = await (await app.signIn(admin.Uuid)).patch(`/users/${t.Uuid}`, { Email: email, reauthPassword });

    expect(res.status, res.text).to.eq(400);
    expect(res.body.details.map((d: { field: string }) => d.field), res.text).to.include('/Email');
    expectNowhere(res, [reauthPassword, email]);
  });

  it('POST /users/security/ban/:uuid with reauthPassword and an invalid duration: 400, the password nowhere', async () => {
    const t = await target();
    const reauthPassword = 'Zq7banReauthHv6Ty';

    const res = await (await app.signIn(admin.Uuid)).post(`/users/security/ban/${t.Uuid}`, { duration: 'forever', reason: 'spam', reauthPassword });

    expect(res.status, res.text).to.eq(400);
    expect(res.body.details.map((d: { field: string }) => d.field), res.text).to.include('/duration');
    expectNowhere(res, [reauthPassword]);
  });
});
