import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';
import { jobOptions } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';

import { AuthnMailJob, QueueAuthnMailDispatcher } from '../../src/queue/index.js';
import type { LocalPasswordService } from '../../src/service.js';
import { LOGIN, RESET_URL, ctx, setup } from './support.js';

const NEW = 'New-Password-2';

/** The QueueMessage and QueueJob envelope; everything else in a payload is the job's own. */
const ENVELOPE = new Set(['CreatedAt', 'Name', 'Type', 'Persistent', 'Priority', 'RetryCount', 'JobId', 'Initiator', 'ScheduleDelay', 'SchedulePeriod', 'ScheduleRepeat', 'ScheduleCron']);

/** What a broker would hold. */
class CapturingQueue {
  public readonly emitted: IQueueMessage[] = [];
  public async emit(message: IQueueMessage): Promise<string | undefined> {
    this.emitted.push(message);
    return undefined;
  }
}

async function queued() {
  const queue = new CapturingQueue();
  const x = await setup({}, () => new QueueAuthnMailDispatcher(queue));
  return { ...x, queue };
}

/** The job as a consumer builds it from the stored payload. */
function consumed(payload: unknown): AuthnMailJob {
  const job = new AuthnMailJob();
  job.hydrate(payload);
  return job;
}

const serialized = (m: IQueueMessage): Record<string, unknown> => JSON.parse(JSON.stringify(m)) as Record<string, unknown>;

describe('authn mail, queue delivery (MAIL-1, D12, D13, SR-09)', function () {
  this.timeout(60_000);

  let registered: (() => LocalPasswordService) | undefined;
  /** AuthnMailJob resolves the PasswordService of the container it runs in. */
  const runWith = (service: LocalPasswordService) => {
    registered = () => service;
    DI.register(registered).as(PasswordService);
    DI.uncache(PasswordService);
  };

  afterEach(() => {
    if (registered) {
      // By identity: unregister(factory) alone drops a factory under every other token too.
      DI.unregister(PasswordService, registered);
      registered = undefined;
    }
    DI.uncache(PasswordService);
  });

  it('dispatch emits one AuthnMailJob whose payload holds exactly the D13 fields and no secret, link or address', async () => {
    const x = await queued();
    expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
    await x.service.drain();

    expect(x.queue.emitted).to.have.length(1);
    expect(x.queue.emitted[0]).to.be.instanceOf(AuthnMailJob);
    const payload = serialized(x.queue.emitted[0]);
    expect(Object.keys(payload).filter((k) => !ENVELOPE.has(k)).sort()).to.deep.equal(['identityId', 'identityType', 'purpose', 'requestedAt', 'ttlSeconds']);
    expect(payload).to.include({ identityType: x.alice.type, identityId: x.alice.id, purpose: 'reset', ttlSeconds: 3600 });
    expect(new Date(payload.requestedAt as string).toISOString()).to.equal(payload.requestedAt);
    expect(x.secrets.rows(), 'no secret exists while the job waits').to.have.length(0);
    expect(x.mailer.mails).to.have.length(0);

    runWith(x.service);
    expect(await consumed(payload).execute()).to.deep.equal({ result: true });
    const [mail] = x.mailer.mails;
    const text = JSON.stringify(payload);
    for (const value of [mail.secret, encodeURIComponent(mail.secret), RESET_URL, LOGIN, encodeURIComponent(LOGIN)]) {
      expect(text).to.not.contain(value);
    }
  });

  it('a lang of the request travels in the payload', async () => {
    const queue = new CapturingQueue();
    await new QueueAuthnMailDispatcher(queue).dispatch({ identity: { type: 'user', id: 'u-1' }, purpose: 'invite', ttlSeconds: 900, requestedAt: new Date(), lang: 'pl' });
    expect(serialized(queue.emitted[0])).to.include({ lang: 'pl', purpose: 'invite', identityId: 'u-1' });
  });

  it('AuthnMailJob.execute issues the secret and sends at once, queueing nothing', async () => {
    const x = await queued();
    const job = AuthnMailJob.of({ identity: x.alice, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date() });
    runWith(x.service);

    expect(await job.execute()).to.deep.equal({ result: true });
    // Sent inside execute: a deferred send would leave the mail out here and put a payload on the queue.
    expect(x.mailer.mails).to.have.length(1);
    expect(x.secrets.rows()).to.have.length(1);
    expect(x.queue.emitted).to.have.length(0);
    expect(await x.service.redeemReset(LOGIN, x.mailer.mails[0].secret, NEW, ctx())).to.deep.equal({ status: 'reset', purpose: 'reset' });
  });

  it('a retry issues a fresh secret: only the secret of the second run redeems', async () => {
    const x = await queued();
    const payload = serialized(AuthnMailJob.of({ identity: x.alice, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date() }));
    runWith(x.service);

    await consumed(payload).execute();
    await consumed(payload).execute();
    const [first, second] = x.mailer.mails.map((m) => m.secret);
    expect(second).to.not.equal(first);
    expect(await x.service.redeemReset(LOGIN, first, NEW, ctx())).to.deep.equal({ status: 'invalid' });
    expect(await x.service.redeemReset(LOGIN, second, NEW, ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'reset', purpose: 'reset' });
  });

  it('a job past requestedAt + ttlSeconds drops itself with result false and issues nothing', async () => {
    const x = await queued();
    const job = AuthnMailJob.of({ identity: x.alice, purpose: 'reset', ttlSeconds: 60, requestedAt: new Date(Date.now() - 61_000) });
    runWith(x.service);

    expect(await job.execute()).to.deep.equal({ result: false });
    expect(x.mailer.mails).to.have.length(0);
    expect(x.secrets.rows()).to.have.length(0);
  });

  it('runs as system (@Job metadata)', () => {
    expect(jobOptions(new AuthnMailJob())).to.deep.equal({ runAs: 'system' });
  });

  it('drain resolves once every dispatched job was handed to the queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handed: IQueueMessage[] = [];
    const dispatcher = new QueueAuthnMailDispatcher({
      emit: async (m: IQueueMessage) => {
        await gate;
        handed.push(m);
        return undefined;
      },
    });
    const pending = dispatcher.dispatch({ identity: { type: 'user', id: 'u-1' }, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date() });
    let drained = false;
    const draining = dispatcher.drain().then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).to.equal(false);
    release();
    await Promise.all([pending, draining]);
    expect(handed).to.have.length(1);
  });
});
