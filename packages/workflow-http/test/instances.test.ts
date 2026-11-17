import 'mocha';
import { expect } from 'chai';
import type { WorkflowStepView } from '@spinajs/workflow';

import { asRole, bootHttp, req, stopHttp } from './common.js';
import { FakeWorkflowService, INSTANCE_ID, makeInstance } from './fakes/fake-workflow.js';

describe('workflow-http: instances', function () {
  this.timeout(25000);

  let fake: FakeWorkflowService;

  before(async () => {
    fake = await bootHttp();
  });
  after(stopHttp);
  beforeEach(() => fake.reset());

  describe('GET /workflow/instances', () => {
    it('lists with the default page size and passes the filters', async () => {
      fake.instances.set('wf-2', makeInstance({ id: 'wf-2', error: { name: 'CardDeclined', message: 'declined', step: 'charge', stack: 'at charge (secret.ts:1)', details: { card: '4111' } } }));
      const res = await req().get('workflow/instances').query({ workflow: 'order', status: 'running,waiting', limit: 2, after: 'wf-0' }).set(asRole('workflow-reader'));
      expect(res).to.have.status(200);
      expect(fake.callsTo('list')[0][0]).to.deep.equal({ limit: 2, workflow: 'order', status: ['running', 'waiting'], after: 'wf-0' });
      expect(res.body).to.containSubset({ next: 'wf-2', items: [{ id: INSTANCE_ID, status: 'waiting' }, { id: 'wf-2', error: { name: 'CardDeclined', message: 'declined', step: 'charge' } }] });
      // the fake's instances carry the input { order: 'A-1' }
      expect(JSON.stringify(res.body)).to.not.match(/A-1|secret\.ts|4111/);
    });

    it('answers next: null on the last page', async () => {
      const res = await req().get('workflow/instances').set(asRole('workflow-reader'));
      expect(fake.callsTo('list')[0][0]).to.deep.equal({ limit: 50 });
      expect(res.body).to.containSubset({ next: null });
    });

    it('answers 400 to an unknown status', async () => {
      const res = await req().get('workflow/instances').query({ status: 'exploded' }).set(asRole('workflow-reader'));
      expect(res).to.have.status(400);
    });

    it('answers 401 without a sign-in and 403 without workflow:read', async () => {
      expect(await req().get('workflow/instances').set({ Accept: 'application/json', Connection: 'close' })).to.have.status(401);
      expect(await req().get('workflow/instances').set(asRole('nobody'))).to.have.status(403);
    });
  });

  describe('GET /workflow/instances/:id', () => {
    it('returns the instance with its steps, without its input, its result and the details of its errors', async () => {
      const steps: WorkflowStepView[] = [{ seq: 1, key: 'step:charge#1', kind: 'step', status: 'failed', attempt: 3, error: { name: 'StepBroke', message: 'm', stack: 'at step (secret.ts:2)', details: { card: '4111' } }, startedAt: 1, finishedAt: 2 }];
      fake.instances.set(INSTANCE_ID, makeInstance({ result: { total: 42 }, error: { name: 'CardDeclined', message: 'declined', step: 'charge', stack: 'at charge (secret.ts:1)', details: { card: '4111' } }, steps }));
      const res = await req().get(`workflow/instances/${INSTANCE_ID}`).set(asRole('workflow-reader'));
      expect(res).to.have.status(200);
      expect(res.body).to.containSubset({ id: INSTANCE_ID, steps: [{ key: 'step:charge#1', error: { name: 'StepBroke', message: 'm' } }], error: { name: 'CardDeclined', message: 'declined', step: 'charge' } });
      expect(res.body).to.not.have.any.keys('input', 'result');
      expect(JSON.stringify(res.body)).to.not.match(/A-1|secret\.ts|4111/);
    });

    it('answers 404 for an unknown instance', async () => {
      expect(await req().get('workflow/instances/nope').set(asRole('workflow-reader'))).to.have.status(404);
    });
  });

  describe('GET /workflow/instances/:id/payload', () => {
    it('returns the input, the result and the full errors to workflow:read-payload', async () => {
      fake.instances.set(INSTANCE_ID, makeInstance({ error: { name: 'CardDeclined', message: 'declined', stack: 'at charge (secret.ts:1)' } }));
      const res = await req().get(`workflow/instances/${INSTANCE_ID}/payload`).set(asRole('workflow-auditor'));
      expect(res).to.have.status(200);
      expect(res.body).to.containSubset({ id: INSTANCE_ID, input: { order: 'A-1' }, error: { stack: 'at charge (secret.ts:1)' }, steps: [{ key: 'wait:approved#1' }] });
    });

    it('answers 403 to workflow:read alone and to workflow:manage without it, and 404 for an unknown instance', async () => {
      expect(await req().get(`workflow/instances/${INSTANCE_ID}/payload`).set(asRole('workflow-reader'))).to.have.status(403);
      expect(await req().get(`workflow/instances/${INSTANCE_ID}/payload`).set(asRole('workflow-admin'))).to.have.status(403);
      expect(await req().get('workflow/instances/nope/payload').set(asRole('workflow-auditor'))).to.have.status(404);
      expect(fake.callsTo('details')).to.deep.equal([['nope']]);
    });
  });
});
