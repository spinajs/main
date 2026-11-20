import 'mocha';
import { expect } from 'chai';
import { WorkflowIdConflict, WorkflowNotRegistered, WorkflowNotRetryable, WorkflowStartConflict, type WorkflowStepView } from '@spinajs/workflow';

import { asRole, bootHttp, req, stopHttp, TEST_USER_UUID } from './common.js';
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

  describe('POST /workflow/instances', () => {
    it('starts an instance: 201 when created, 200 when the id existed', async () => {
      const created = await req().post('workflow/instances').set(asRole('workflow-admin')).send({ workflow: 'order', input: { order: 'A-1' }, id: 'wf-9' });
      expect(created).to.have.status(201);
      expect(created.body).to.deep.equal({ id: 'wf-9', created: true });
      expect(fake.callsTo('start')[0]).to.deep.equal(['order', { order: 'A-1' }, { id: 'wf-9' }]);
      fake.created = false;
      expect(await req().post('workflow/instances').set(asRole('workflow-admin')).send({ workflow: 'order', id: 'wf-9' })).to.have.status(200);
    });

    it('answers 400 for an unknown workflow and 403 without workflow:manage', async () => {
      fake.failWith = new WorkflowNotRegistered('nope');
      expect(await req().post('workflow/instances').set(asRole('workflow-admin')).send({ workflow: 'nope' })).to.have.status(400);
      expect(await req().post('workflow/instances').set(asRole('workflow-signaler')).send({ workflow: 'order' })).to.have.status(403);
    });

    it('answers 400 to a body with unknown fields', async () => {
      const res = await req().post('workflow/instances').set(asRole('workflow-admin')).send({ workflow: 'order', input: { order: 'A-1' }, extra: 1 });
      expect(res).to.have.status(400);
      expect(JSON.stringify(res.body)).to.not.include('A-1');
      expect(fake.callsTo('start')).to.deep.equal([]);
    });

    it('answers 400 to a start without a body', async () => {
      expect(await req().post('workflow/instances').set(asRole('workflow-admin'))).to.have.status(400);
      expect(fake.callsTo('start')).to.deep.equal([]);
    });

    it('answers 409 when the id belongs to another workflow or a concurrent start holds it, without the input', async () => {
      for (const conflict of [new WorkflowIdConflict('wf-9', 'refund', 'order'), new WorkflowStartConflict('wf-9')]) {
        fake.failWith = conflict;
        const res = await req().post('workflow/instances').set(asRole('workflow-admin')).send({ workflow: 'order', input: { order: 'A-1' }, id: 'wf-9' });
        expect(res).to.have.status(409);
        expect(res.body).to.not.have.any.keys('stack', 'details', 'input');
        expect(JSON.stringify(res.body)).to.not.include('A-1');
      }
    });
  });

  describe('POST /workflow/instances/:id/signals/:name', () => {
    it('stores the signal with the caller as principal and answers 202', async () => {
      const res = await req().post(`workflow/instances/${INSTANCE_ID}/signals/approved`).set(asRole('workflow-signaler')).send({ payload: { ok: true }, dedupKey: 'k-1' });
      expect(res).to.have.status(202);
      expect(res.body).to.deep.equal({ accepted: true });
      expect(fake.callsTo('signal')[0]).to.deep.equal([INSTANCE_ID, 'approved', { ok: true }, { principal: `user:${TEST_USER_UUID}`, dedupKey: 'k-1' }]);
    });

    it('takes a signal without a body as one without a payload', async () => {
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/signals/approved`).set(asRole('workflow-signaler'))).to.have.status(202);
      expect(fake.callsTo('signal')[0]).to.deep.equal([INSTANCE_ID, 'approved', null, { principal: `user:${TEST_USER_UUID}` }]);
    });

    it('refuses a restricted credential with 403 and a name with # with 400', async () => {
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/signals/approved`).set(asRole('workflow-signaler', { 'x-test-scoped': '1' })).send({})).to.have.status(403);
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/signals/a%23b`).set(asRole('workflow-signaler')).send({})).to.have.status(400);
      expect(fake.callsTo('signal')).to.deep.equal([]);
    });

    it('answers 403 without workflow:signal and 404 for an unknown instance', async () => {
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/signals/approved`).set(asRole('workflow-reader')).send({})).to.have.status(403);
      expect(await req().post('workflow/instances/nope/signals/approved').set(asRole('workflow-signaler')).send({})).to.have.status(404);
    });
  });

  describe('cancel and retry', () => {
    it('cancels with a reason and answers 202 with the instance', async () => {
      const res = await req().post(`workflow/instances/${INSTANCE_ID}/cancel`).set(asRole('workflow-admin')).send({ reason: 'customer left' });
      expect(res).to.have.status(202);
      expect(res.body).to.containSubset({ id: INSTANCE_ID });
      expect(res.body).to.not.have.any.keys('input', 'result');
      expect(fake.callsTo('cancel')[0]).to.deep.equal([INSTANCE_ID, 'customer left']);
    });

    it('cancels without a body with the service default reason', async () => {
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/cancel`).set(asRole('workflow-admin'))).to.have.status(202);
      expect(fake.callsTo('cancel')[0]).to.deep.equal([INSTANCE_ID, undefined]);
    });

    it('retries and answers 409 when the instance is not retryable', async () => {
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/retry`).set(asRole('workflow-admin'))).to.have.status(202);
      fake.failWith = new WorkflowNotRetryable("workflow instance 'wf-1' is waiting; only a failed instance can be retried");
      const refused = await req().post(`workflow/instances/${INSTANCE_ID}/retry`).set(asRole('workflow-admin'));
      expect(refused).to.have.status(409);
      expect(refused.body).to.not.have.any.keys('stack', 'details');
    });

    it('answers 404 to a cancel of an unknown instance and 403 without workflow:manage', async () => {
      expect(await req().post('workflow/instances/nope/cancel').set(asRole('workflow-admin')).send({})).to.have.status(404);
      expect(await req().post(`workflow/instances/${INSTANCE_ID}/cancel`).set(asRole('workflow-signaler')).send({})).to.have.status(403);
    });
  });
});
