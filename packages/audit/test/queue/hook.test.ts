import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Job, PermanentJobFailure, QueueJob, QueueMessageHook, SystemTask } from '@spinajs/queue';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { AuditWriteFailed, audit } from '../../src/index.js';
import type { AuditEvent } from '../../src/index.js';
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
class Plain extends QueueJob {
  public async execute() {
    return 1;
  }
}

const shape = (e: AuditEvent) => [e.kind, e.action, e.outcome];
const dataOf = (e: AuditEvent) => e.data as Record<string, unknown>;
const stored = (trail: string): readonly AuditEvent[] => MemoryAuditStore.events(trail);

async function recorded(trail: string): Promise<readonly AuditEvent[]> {
  await audit().flush();
  return stored(trail);
}

describe('QueueAuditHook', function () {
  this.timeout(20000);

  let app: TestApp;
  const hook = new QueueAuditHook();

  before(async () => {
    app = await createTestApp({
      bootstrap: false,
      config: {
        logger: SILENT,
        audit: {
          trails: {
            actions: { store: 'MemoryAuditStore' },
            restricted: { store: 'MemoryAuditStore', onFailure: 'reject', retry: { attempts: 2, delay: '1ms' } },
          },
        },
      },
    });
  });

  after(() => app.dispose());

  beforeEach(() => MemoryAuditStore.clear());

  it('is a queue message hook', () => {
    expect(DI.getRegisteredTypes(QueueMessageHook)).to.include(QueueAuditHook);
  });

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

  it('records an execution after the handler, deferred on a continue trail', async () => {
    const message = Object.assign(new SendReport(), { MessageId: 'm-1' });

    expect(await hook.aroundHandle(message, async () => 'done')).to.eq('done');

    const [event] = await recorded('actions');
    expect(shape(event)).to.deep.eq(['action', 'report.send', 'ok']);
    expect(event.subject).to.deep.eq({ type: 'SendReport', id: 'm-1' });
    expect(dataOf(event).ms).to.be.a('number');
  });

  it('records a failed handler once: the onFailed pass of the same delivery is not an execution', async () => {
    const message = Object.assign(new SendReport(), { MessageId: 'm-2' });

    await expect(hook.aroundHandle(message, () => Promise.reject(new TypeError('boom')))).to.be.rejectedWith(TypeError);
    await hook.aroundHandle(message, async () => undefined);

    const events = await recorded('actions');
    expect(events.map(shape)).to.deep.eq([['action', 'report.send', 'failed']]);
    expect(dataOf(events[0]).error).to.eq('TypeError');
  });

  it('records a refused job as denied when it sees the refusal', async () => {
    const message = Object.assign(new SendReport(), { MessageId: 'm-3' });

    await expect(hook.aroundHandle(message, () => Promise.reject(new PermanentJobFailure('access_denied', 'no')))).to.be.rejectedWith(PermanentJobFailure);

    expect((await recorded('actions')).map(shape)).to.deep.eq([['action', 'report.send', 'denied']]);
  });

  it('a reject trail gets a confirmed attempt before the handler, and the handler does not run without it', async () => {
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

  it('leaves a message without @Audited alone', async () => {
    const message = new Plain();

    await hook.beforeEmit(message);
    await hook.aroundHandle(message, async () => undefined);

    expect(message.MessageId).to.eq(undefined);
    expect(await recorded('actions')).to.deep.eq([]);
  });
});
