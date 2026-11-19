import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { isWorkflowStatus, Workflow, WORKFLOW_STATUSES, WorkflowDefinition, WorkflowNotRetryable, WorkflowService, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { rejects } from './support/rows.js';

@Workflow('dt-approve')
export class DtApprove extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('prepare', () => 'ready');
    await ctx.waitForEvent('approved');
    return 'done';
  }
}

describe('WorkflowService.details and retry refusals', () => {
  let service: WorkflowService;

  beforeEach(async () => {
    await bootTestEnv();
    service = await DI.resolve(WorkflowService);
  });
  after(disposeTestEnv);

  it('returns the instance with its steps and its pending events, without payloads', async () => {
    const { id } = await service.start('dt-approve', null, { id: 'dt-1' });
    await (await engine()).tick();
    await service.signal(id, 'other', { secret: 1 }, { principal: 'user:u1' });
    const detail = await service.details(id);
    expect(detail?.status).to.equal('waiting');
    expect(detail?.steps.map((s) => [s.seq, s.key, s.kind, s.status])).to.deep.equal([
      [1, 'step:prepare#1', 'step', 'succeeded'],
      [2, 'wait:approved#1', 'wait', 'pending'],
    ]);
    expect(detail?.pendingEvents.map((e) => [e.name, e.principal])).to.deep.equal([['other', 'user:u1']]);
    expect(JSON.stringify(detail)).to.not.include('secret');
  });

  it('answers undefined for an unknown instance', async () => {
    expect(await service.details('nope')).to.equal(undefined);
  });

  it('refuses to retry an instance that is not failed with WorkflowNotRetryable, still an InvalidOperation', async () => {
    const { id } = await service.start('dt-approve', null);
    const err = await rejects(service.retry(id));
    expect(err).to.be.instanceOf(WorkflowNotRetryable);
    expect(err).to.be.instanceOf(InvalidOperation);
  });

  it('lists every status once, and isWorkflowStatus tells a status from any other string', () => {
    expect([...WORKFLOW_STATUSES].sort()).to.deep.equal(['cancelled', 'compensated', 'compensating', 'completed', 'failed', 'running', 'sleeping', 'waiting']);
    expect([isWorkflowStatus('waiting'), isWorkflowStatus('exploded')]).to.deep.equal([true, false]);
  });
});
