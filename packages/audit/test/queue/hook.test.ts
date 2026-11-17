import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createHash } from 'node:crypto';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import type { Log } from '@spinajs/log-common';
import { Job, PermanentJobFailure, QueueJob, QueueMessageHook, QueueService, SystemTask } from '@spinajs/queue';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { AuditConfigError, AuditWriteFailed, audit } from '../../src/index.js';
import type { AuditEvent, AuditInput, AuditService } from '../../src/index.js';
import { Audited, QueueAuditHook } from '../../src/queue/index.js';
import { MemoryAuditStore } from '../../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

@Job()
@SystemTask('a fixture of the audit hook suite')
@Audited('report.send', { trail: 'actions', fields: ['ReportId'] })
class SendReport extends QueueJob {
  public ReportId = 7;
  public Secret = 'hunter2';

  public async execute() {
    return 1;
  }
}

@Job()
@SystemTask('a fixture of the audit hook suite')
@Audited('payout.run', { trail: 'restricted' })
class RunPayout extends QueueJob {
  public async execute() {
    return 1;
  }
}

@Job()
@SystemTask('a fixture of the audit hook suite')
@Audited('patient.export', { trail: 'actions', fields: ['Email', 'Token', 'Ssn'], mask: ['data.fields.Email'], omit: ['data.fields.Token'], hash: ['data.fields.Ssn'] })
class ExportPatient extends QueueJob {
  public Email = 'jan@example.com';
  public Token = 't0ken';
  public Ssn = '80010112345';

  public async execute() {
    return 1;
  }
}

@Job()
@SystemTask('a fixture of the audit hook suite')
@Audited('lost.job', { trail: 'broken' })
class Misrouted extends QueueJob {
  public async execute() {
    return 1;
  }
}

@Job()
@SystemTask('a fixture of the audit hook suite')
class Plain extends QueueJob {
  public async execute() {
    return 1;
  }
}

class RecordingHook extends QueueAuditHook {
  public readonly errors: unknown[] = [];

  protected override log(): Pick<Log, 'error'> {
    return {
      error: (fields: unknown) => {
        this.errors.push(fields);
      },
    };
  }
}

class BrokenLogHook extends QueueAuditHook {
  protected override log(): Pick<Log, 'error'> {
    throw new Error('no logger');
  }
}

function twin() {
  @SystemTask('a fixture of the audit hook suite')
  class Twin extends QueueJob {
    public async execute() {
      return 1;
    }
  }
  return Twin;
}

const shape = (e: AuditEvent) => [e.kind, e.action, e.outcome];
const dataOf = (e: AuditEvent) => e.data as Record<string, unknown>;
const stored = (trail: string): readonly AuditEvent[] => MemoryAuditStore.events(trail);
const isList = (input: AuditInput | readonly AuditInput[]): input is readonly AuditInput[] => Array.isArray(input);
const outcomeOf = (input: AuditInput | readonly AuditInput[]): string | undefined => (isList(input) ? undefined : input.outcome);

async function recorded(trail: string): Promise<readonly AuditEvent[]> {
  await audit().flush();
  return stored(trail);
}

/** Makes the audit service reject every write of one outcome, whatever the store or the trail would do. */
function refuse(outcome: string): () => void {
  const service: AuditService = audit();
  const record = service.record.bind(service);
  service.record = (input, options) => (outcomeOf(input) === outcome ? Promise.reject(new AuditWriteFailed('audit: refused by the test')) : record(input, options));
  return () => {
    service.record = record;
  };
}

describe('QueueAuditHook', function () {
  this.timeout(20000);

  let app: TestApp;
  let hook: RecordingHook;

  before(async () => {
    app = await createTestApp({
      bootstrap: false,
      config: {
        logger: SILENT,
        queue: { default: 'nowhere', routing: {}, connections: [{ name: 'nowhere', service: 'BlackHoleQueueClient' }] },
        audit: {
          trails: {
            actions: { store: 'MemoryAuditStore' },
            restricted: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
            broken: { store: 'NoSuchStore' },
          },
        },
      },
    });
  });

  after(() => app.dispose());

  beforeEach(() => {
    MemoryAuditStore.clear();
    hook = new RecordingHook();
  });

  it('is a queue message hook', () => {
    expect(DI.getRegisteredTypes(QueueMessageHook)).to.include(QueueAuditHook);
  });

  describe('publish', () => {
    it('records a publish with the id the message is sent with', async () => {
      const message = new SendReport();

      await hook.beforeEmit(message);

      expect(message.MessageId).to.be.a('string');
      const [event] = await recorded('actions');
      expect(shape(event)).to.deep.eq(['action', 'queue.publish', 'attempt']);
      expect(event.subject).to.deep.eq({ type: 'SendReport', id: message.MessageId });
      expect(event.data).to.deep.include({ message: 'SendReport', fields: { ReportId: 7 } });
      expect(JSON.stringify(event)).to.not.contain('hunter2');
    });

    it('writes a publish on a reject trail before emit() goes on, and refuses the publish when the write fails', async () => {
      await hook.beforeEmit(new RunPayout());
      expect(stored('restricted').map(shape)).to.deep.eq([['action', 'queue.publish', 'attempt']]);

      MemoryAuditStore.failNext(2);
      await expect(hook.beforeEmit(new RunPayout())).to.be.rejectedWith(AuditWriteFailed);
    });

    it('records a publish made with QueueJob.emit(), with the job id emit() derives', async () => {
      const jobId = await SendReport.emit({ ReportId: 9 });

      const events = await recorded('actions');
      expect(events.map(shape)).to.deep.eq([['action', 'queue.publish', 'attempt']]);
      expect(events[0].subject).to.deep.eq({ type: 'SendReport', id: jobId });
      expect(events[0].data).to.deep.include({ message: 'SendReport', jobId, fields: { ReportId: 9 } });
    });

    it('refuses a publish made with QueueJob.emit() on a reject trail whose write fails', async () => {
      MemoryAuditStore.failNext(2);

      await expect(RunPayout.emit({})).to.be.rejectedWith(AuditWriteFailed);
    });

    it('records a publish of a message instance through QueueService.emit() once', async () => {
      const queue = await DI.resolve(QueueService);

      await queue.emit(new SendReport());

      expect((await recorded('actions')).map(shape)).to.deep.eq([['action', 'queue.publish', 'attempt']]);
    });
  });

  describe('execution', () => {
    it('records an execution after the handler, deferred on a continue trail', async () => {
      const message = Object.assign(new SendReport(), { MessageId: 'm-1', JobId: 'j-1' });

      expect(await hook.aroundHandle(message, async () => 'done')).to.eq('done');
      expect(stored('actions')).to.deep.eq([]);

      const [event] = await recorded('actions');
      expect(shape(event)).to.deep.eq(['action', 'report.send', 'ok']);
      expect(event.subject).to.deep.eq({ type: 'SendReport', id: 'm-1' });
      expect(dataOf(event).ms).to.be.a('number');
      expect(dataOf(event).jobId).to.eq('j-1');
    });

    it('records a failed handler once: the onFailed pass of the same delivery is not an execution', async () => {
      const message = Object.assign(new SendReport(), { MessageId: 'm-2' });

      await expect(hook.aroundHandle(message, () => Promise.reject(new TypeError('boom')))).to.be.rejectedWith(TypeError);
      await hook.aroundHandle(message, async () => undefined);

      const events = await recorded('actions');
      expect(events.map(shape)).to.deep.eq([['action', 'report.send', 'failed']]);
      expect(dataOf(events[0]).error).to.eq('TypeError');
    });

    it('records a job consumed with a callback once: the callback pass is not another execution', async () => {
      const message = Object.assign(new RunPayout(), { MessageId: 'm-6' });

      await hook.aroundHandle(message, async () => 1);
      await hook.aroundHandle(message, async () => undefined);

      expect((await recorded('restricted')).map(shape)).to.deep.eq([
        ['action', 'payout.run', 'attempt'],
        ['action', 'payout.run', 'ok'],
      ]);
    });

    it('records a refused job as denied when it sees the refusal', async () => {
      const message = Object.assign(new SendReport(), { MessageId: 'm-3' });

      await expect(hook.aroundHandle(message, () => Promise.reject(new PermanentJobFailure('access_denied', 'no')))).to.be.rejectedWith(PermanentJobFailure);

      expect((await recorded('actions')).map(shape)).to.deep.eq([['action', 'report.send', 'denied']]);
    });

    it('records a handler that throws AuditWriteFailed itself as failed', async () => {
      const message = Object.assign(new RunPayout(), { MessageId: 'm-7' });
      const thrown = new AuditWriteFailed('audit: the job could not record its own rows');

      await expect(hook.aroundHandle(message, () => Promise.reject(thrown))).to.be.rejectedWith(thrown);

      const events = await recorded('restricted');
      expect(events.map(shape)).to.deep.eq([
        ['action', 'payout.run', 'attempt'],
        ['action', 'payout.run', 'failed'],
      ]);
      expect(dataOf(events[1]).error).to.eq('AuditWriteFailed');
    });

    it('records a long message id by its digest and keeps the id in data.messageId', async () => {
      const id = 'x'.repeat(300);
      const message = Object.assign(new SendReport(), { MessageId: id });

      await hook.aroundHandle(message, async () => undefined);

      const [event] = await recorded('actions');
      expect(event.subject).to.deep.eq({ type: 'SendReport', id: createHash('sha256').update(id).digest('hex') });
      expect(dataOf(event).messageId).to.eq(id);
    });

    it('applies omit, mask and hash paths written data.fields.<name>', async () => {
      await hook.aroundHandle(Object.assign(new ExportPatient(), { MessageId: 'm-8' }), async () => undefined);

      const fields = dataOf((await recorded('actions'))[0]).fields as Record<string, unknown>;
      expect(fields.Email).to.eq('***');
      expect(fields).to.not.have.property('Token');
      expect(fields.Ssn).to.be.a('string').and.not.eq('80010112345');
    });
  });

  describe('reject trail', () => {
    it('gets a confirmed attempt before the handler, and the handler does not run without it', async () => {
      const message = Object.assign(new RunPayout(), { MessageId: 'm-4' });
      let before: readonly AuditEvent[] = [];

      await hook.aroundHandle(message, async () => {
        before = [...stored('restricted')];
      });

      expect(before.map(shape)).to.deep.eq([['action', 'payout.run', 'attempt']]);
      expect((await recorded('restricted')).map(shape)).to.deep.eq([
        ['action', 'payout.run', 'attempt'],
        ['action', 'payout.run', 'ok'],
      ]);

      MemoryAuditStore.failNext(2);
      let ran = false;
      const second = Object.assign(new RunPayout(), { MessageId: 'm-5' });
      await expect(
        hook.aroundHandle(second, async () => {
          ran = true;
        }),
      ).to.be.rejectedWith(AuditWriteFailed);
      expect(ran).to.eq(false);
    });

    it('records a handler that throws as failed and rethrows its error unchanged', async () => {
      const message = Object.assign(new RunPayout(), { MessageId: 'm-9' });
      const thrown = new RangeError('no funds');

      await expect(hook.aroundHandle(message, () => Promise.reject(thrown))).to.be.rejectedWith(thrown);

      const events = await recorded('restricted');
      expect(events.map(shape)).to.deep.eq([
        ['action', 'payout.run', 'attempt'],
        ['action', 'payout.run', 'failed'],
      ]);
      expect(dataOf(events[1]).error).to.eq('RangeError');
    });
  });

  describe('a failed write after the handler ran', () => {
    it('keeps the result of a job whose outcome write is refused, and logs the loss once', async () => {
      const restore = refuse('ok');
      try {
        expect(await hook.aroundHandle(Object.assign(new RunPayout(), { MessageId: 'm-10' }), async () => 'paid')).to.eq('paid');
      } finally {
        restore();
      }

      expect(hook.errors).to.have.length(1);
      expect(hook.errors[0]).to.deep.include({ messageName: 'RunPayout', messageId: 'm-10', outcome: 'ok' });
      expect((await recorded('restricted')).map(shape)).to.deep.eq([['action', 'payout.run', 'attempt']]);
    });

    it('rethrows the handler error, not the error of its failed outcome write', async () => {
      const thrown = new TypeError('boom');
      const restore = refuse('failed');
      try {
        await expect(hook.aroundHandle(Object.assign(new SendReport(), { MessageId: 'm-11' }), () => Promise.reject(thrown))).to.be.rejectedWith(thrown);
      } finally {
        restore();
      }

      expect(hook.errors).to.have.length(1);
    });

    it('keeps the result of a job when even the logger fails', async () => {
      const restore = refuse('ok');
      try {
        expect(await new BrokenLogHook().aroundHandle(Object.assign(new RunPayout(), { MessageId: 'm-14' }), async () => 'paid')).to.eq('paid');
      } finally {
        restore();
      }
    });

    it('keeps the result of a job on a continue trail whose store fails', async () => {
      MemoryAuditStore.failNext(10);

      expect(await hook.aroundHandle(Object.assign(new SendReport(), { MessageId: 'm-12' }), async () => 'done')).to.eq('done');

      expect(await recorded('actions')).to.deep.eq([]);
      expect(hook.errors).to.deep.eq([]);
    });
  });

  describe('configuration', () => {
    it('refuses an action longer than the action column at decoration', () => {
      expect(() => Audited('a'.repeat(129))).to.throw(AuditConfigError, '@Audited action must be at most 128 characters');
      expect(() => Audited('a'.repeat(128))).to.not.throw();
    });

    it('refuses a second audited class of the same name, which the queue could not tell apart', () => {
      Audited('twin.run')(twin());

      expect(() => Audited('twin.run')(twin())).to.throw(AuditConfigError, 'another class named "Twin" is already audited');
    });

    it('refuses a mask path outside data at decoration', () => {
      expect(() => Audited('patient.export', { mask: ['fields.Email'] })).to.throw(AuditConfigError, 'is not maskable');
    });

    it('fails a delivery on a trail without a store before the handler, once, and lets onFailed run', async () => {
      const message = Object.assign(new Misrouted(), { MessageId: 'm-13' });
      let ran = false;
      let failedRan = false;

      await expect(
        hook.aroundHandle(message, async () => {
          ran = true;
        }),
      ).to.be.rejectedWith(AuditConfigError, 'no AuditStore is registered under that name');
      await hook.aroundHandle(message, async () => {
        failedRan = true;
      });

      expect(ran).to.eq(false);
      expect(failedRan).to.eq(true);
    });
  });

  it('leaves a message without @Audited alone', async () => {
    const message = new Plain();

    await hook.beforeEmit(message);
    await hook.aroundHandle(message, async () => undefined);

    expect(message.MessageId).to.eq(undefined);
    expect(await recorded('actions')).to.deep.eq([]);
  });
});
