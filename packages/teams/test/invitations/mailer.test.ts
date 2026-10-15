import * as chai from 'chai';
import 'mocha';

import type { EmailService, IEmail } from '@spinajs/email';
import { IOFail } from '@spinajs/exceptions';

import { EmailInvitationMailer } from '../../src/invitations/mailer.js';
import type { InvitationMail } from '../../src/index.js';
import { failure } from '../support/people.js';

const expect = chai.expect;
const at = new Date('2026-10-21T12:00:00.000Z');

const mail = (token: string): InvitationMail => ({
  to: 'ann@example.com',
  team: { id: 't', parentId: null, slug: 'core', name: 'Core', description: null, archivedAt: null, deletedAt: null, createdBy: null, createdAt: at, updatedAt: at },
  group: null,
  role: 'team.member',
  token,
  expiresAt: at,
  invitedBy: { type: 'user', id: 'boss' },
});

describe('EmailInvitationMailer', () => {
  it('sends at once with the token and the link marked for redaction', async () => {
    const sent: IEmail[] = [];
    const email = { send: async (e: IEmail) => void sent.push(e) } as unknown as EmailService;
    await new EmailInvitationMailer({ email, options: { url: 'https://app.example/join', subject: 'Join' }, defaultConnection: 'smtp' }).send(mail('TOKEN'));
    expect(sent).to.have.length(1);
    const e = sent[0];
    expect(e).to.include({ connection: 'smtp', subject: 'Join', tag: 'teams-invitation' });
    expect(e.to).to.deep.equal(['ann@example.com']);
    expect(e.model).to.include({ Team: 'Core', Role: 'team.member', Token: 'TOKEN', AcceptUrl: 'https://app.example/join?token=TOKEN' });
    expect(e.redact).to.deep.equal(['TOKEN', 'https://app.example/join?token=TOKEN']);
    expect(e.text).to.match(/Core as team\.member/);
  });

  it('uses the configured template; without a url the mail carries the code', async () => {
    const sent: IEmail[] = [];
    const email = { send: async (e: IEmail) => void sent.push(e) } as unknown as EmailService;
    await new EmailInvitationMailer({ email, options: { template: './invite.pug' }, defaultConnection: 'smtp' }).send(mail('CODE'));
    expect(sent[0]).to.include({ template: './invite.pug', subject: 'You are invited to join a team' });
    expect(sent[0].text).to.equal(undefined);
    expect(sent[0].redact).to.deep.equal(['CODE']);
  });

  it('never lets the token reach the error', async () => {
    const email = {
      send: async () => {
        throw new Error('rejected SECRET-TOKEN');
      },
    } as unknown as EmailService;
    const e = await failure(new EmailInvitationMailer({ email, defaultConnection: 'smtp' }).send(mail('SECRET-TOKEN')));
    expect(e).to.be.instanceOf(IOFail);
    expect(e.message).to.not.include('SECRET-TOKEN');
  });
});
