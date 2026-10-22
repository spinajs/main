import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { DefaultQueueService } from '@spinajs/queue';
import { EmailSend } from '@spinajs/email';
import { renderTemplate } from '@spinajs/log';
import { ActionHook } from '@spinajs/hooks';

import { User, UserLifecycleMailHook } from '../../src/index.js';
import { activate, ban, create, deactivate, deleteUser, expirePassword, notifyPasswordWillExpire, unban } from '../../src/actions.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost, storedUser } from '../support/users-db.js';
import { freshHooks } from './support.js';

const PASSWORD = 'passw0rd123';

type Mail = EmailSend & { to: string[]; template: string; subject: string; tag: string; model: Record<string, unknown> };

describe('UserLifecycleMailHook (HOOK-4, R1)', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;
  const mails = () => emit.args.map((a) => a[0] as unknown).filter((e): e is Mail => e instanceof EmailSend);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
  });

  afterEach(() => {
    sinon.restore();
    releaseUsersHost();
    DI.clearCache();
  });

  async function made(login: string, password: string | undefined = PASSWORD): Promise<User> {
    const { User: u } = await create({ Email: `${login}@spinajs.pl`, Login: login, ...(password ? { Password: password } : {}) });
    emit.resetHistory();
    return storedUser(u.Uuid);
  }

  /** The mail as users.email.<name> describes it: today's template, subject, tag and recipient, the user in its model. */
  function expectMail(mail: Mail | undefined, name: string, u: User): void {
    const cfg = DI.get(Configuration)!.get<{ template: string; subject: string }>(`users.email.${name}`);
    expect(mail, `the ${name} mail`).to.exist;
    expect(mail!.tag).to.eq(`rbac-user-${name}`);
    expect(mail!.template).to.eq(cfg.template);
    expect(mail!.subject).to.eq(cfg.subject);
    expect(mail!.to).to.deep.eq([u.Email]);
    expect(mail!.model).to.include({ Uuid: u.Uuid, Email: u.Email, Login: u.Login });
    expect(mail!.model).to.not.have.property('Password');
  }

  it('is a registered ActionHook', async () => {
    const hooks = await DI.resolve(Array.ofType(ActionHook));
    expect(hooks.some((h) => h instanceof UserLifecycleMailHook)).to.eq(true);
  });

  it('create with a password sends one created mail', async () => {
    const { User: u } = await create({ Email: 'mail-created@spinajs.pl', Login: 'mail-created', Password: PASSWORD });

    expect(mails()).to.have.lengthOf(1);
    expectMail(mails()[0], 'created', u);
  });

  it('create without a password (the invite path) sends no created mail', async () => {
    await create({ Email: 'mail-invited@spinajs.pl', Login: 'mail-invited' });

    expect(mails()).to.deep.eq([]);
  });

  for (const [name, act, prepare] of [
    ['activated', (u: User) => activate(u), undefined],
    ['deactivated', (u: User) => deactivate(u), (u: User) => activate(u)],
    ['banned', (u: User) => ban(u, 'spam', 60), undefined],
    ['unbanned', (u: User) => unban(u), (u: User) => ban(u, 'spam', 60)],
    ['deleted', (u: User) => deleteUser(u), undefined],
    ['passwordExpired', (u: User) => expirePassword(u), undefined],
  ] as const) {
    it(`sends one ${name} mail, with the template and model of the users.email.${name} entry`, async () => {
      let u = await made(`mail-${name.toLowerCase()}`);
      if (prepare) {
        await prepare(u);
        u = await storedUser(u.Uuid);
        emit.resetHistory();
      }

      await act(u);

      expect(mails().map((m) => m.tag)).to.deep.eq([`rbac-user-${name}`]);
      expectMail(mails()[0], name, u);
    });
  }

  it('the banned mail carries the attachments users.email.banned names', async () => {
    const u = await made('mail-attached');

    await ban(u, 'spam', 60);

    expect((mails()[0] as unknown as { attachements: unknown }).attachements).to.deep.eq([{ provider: 'fs', path: '/tmp/logo.png', name: 'logo.png', cid: 'logo' }]);
  });

  it('activating an active account sends nothing', async () => {
    const u = await made('mail-already-active');
    await activate(u);
    emit.resetHistory();

    await activate(await storedUser(u.Uuid));

    expect(mails()).to.deep.eq([]);
  });

  it('notifyPasswordWillExpire still sends its own mail', async () => {
    const u = await made('mail-will-expire');

    await notifyPasswordWillExpire(u);

    expect(mails().map((m) => m.tag)).to.deep.eq(['rbac-user-passwordWillExpire']);
  });

  it('with users.email.banned unset, ban succeeds and the failure is logged by its class', async () => {
    const u = await made('mail-unset');
    DI.get(Configuration)!.set('users.email.banned', undefined);
    const hook = (await DI.resolve(UserLifecycleMailHook)) as unknown as { Log: { warn: (fields: Record<string, unknown>, template: string) => void } };
    const warn = sinon.stub(hook.Log, 'warn');

    const banned = await ban(u, 'spam', 60);

    expect(banned.IsBanned).to.eq(true);
    expect((await storedUser(u.Uuid)).IsBanned).to.eq(true);
    expect(mails()).to.deep.eq([]);
    expect(warn.callCount).to.eq(1);
    const [fields, template] = warn.args[0];
    expect(renderTemplate(template, fields)).to.contain('banned').and.to.contain('users.ban').and.to.contain('EmailTemplateNotConfigured');
  });

  it('a mail that cannot be queued does not fail the action', async () => {
    const u = await made('mail-queue-down');
    // Only the mail: the user events of the action are not the hook's.
    emit.callsFake(async (e: unknown) => {
      if (e instanceof EmailSend) throw new Error('queue down');
    });

    await deactivate(u);

    expect(Boolean((await storedUser(u.Uuid)).IsActive)).to.eq(false);
  });

  it('DI.unregister(UserLifecycleMailHook) before Hooks resolves sends nothing', async () => {
    const u = await made('mail-unregistered');
    DI.unregister(UserLifecycleMailHook);
    freshHooks();
    try {
      await ban(u, 'spam', 60);
      await unban(await storedUser(u.Uuid));
      await create({ Email: 'mail-unregistered-2@spinajs.pl', Login: 'mail-unregistered-2', Password: PASSWORD });

      expect(mails()).to.deep.eq([]);
    } finally {
      DI.register(UserLifecycleMailHook).as(ActionHook);
      freshHooks();
    }
  });
});
