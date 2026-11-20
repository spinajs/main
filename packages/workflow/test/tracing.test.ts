import 'mocha';
import { expect } from 'chai';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import type { FakeClock } from '@spinajs/durable/testing';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext } from '../src/index.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { instance, seedInstance } from './support/rows.js';

class ChargeDeclined extends Error {}

@Workflow('trc-sum')
export class TrcSum extends WorkflowDefinition<{ a: number; b: number }, number> {
  public run(ctx: WorkflowContext<{ a: number; b: number }>): Promise<number> {
    return ctx.step('add', () => ctx.input.a + ctx.input.b);
  }
}

@Workflow('trc-park')
export class TrcPark extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('first', () => 1);
    await ctx.sleep(1000);
    return ctx.step('second', () => 'done');
  }
}

@Workflow('trc-fail')
export class TrcFail extends WorkflowDefinition<null, never> {
  public run(ctx: WorkflowContext<null>): Promise<never> {
    return ctx.step(
      'charge',
      () => {
        throw new ChargeDeclined('card secret-4111 declined');
      },
      { retry: { attempts: 1 } },
    );
  }
}

describe('workflow spans', function () {
  // boots a database per case; generous for a loaded machine
  this.timeout(180_000);

  let service: WorkflowService;
  let clock: FakeClock;
  let spans: InMemorySpans;

  beforeEach(async () => {
    spans = useInMemorySpans();
    ({ clock } = await bootTestEnv({}));
    service = await DI.resolve(WorkflowService);
  });
  afterEach(() => spans.detach());
  after(async () => {
    await disposeTestEnv();
    await resetTracing();
  });

  it('runs each activation as a root span linked to the start, with a span per executed step', async () => {
    const { id } = await withSpan('POST /orders', { kind: SpanKind.SERVER }, () => service.start('trc-sum', { a: 2, b: 3 }));
    await (await engine()).tick();

    const [server] = spans.byName('POST /orders');
    const [activation] = spans.byName('workflow trc-sum');
    expect(activation.parentSpanContext).to.equal(undefined);
    expect(activation.links.map((l) => l.context.spanId)).to.deep.equal([server.spanContext().spanId]);
    expect(activation.attributes).to.include({ 'spina.workflow.name': 'trc-sum', 'spina.workflow.instance_id': id, 'spina.workflow.version': 1 });
    expect(activation.status.code).to.equal(SpanStatusCode.UNSET);
    const [step] = spans.byName('step add');
    expect(step.parentSpanContext?.spanId).to.equal(activation.spanContext().spanId);
    expect(step.attributes).to.include({ 'spina.workflow.step': 'add', 'spina.workflow.step_attempt': 1 });
    expect((await instance(id)).TraceParent?.split('-')[2]).to.equal(server.spanContext().spanId);
  });

  it('gives a step served from the journal no span in a later activation', async () => {
    await service.start('trc-park', null);
    await (await engine()).tick();
    await clock.advance(1000);
    await (await engine()).tick();

    expect(spans.byName('workflow trc-park')).to.have.length(2);
    expect(spans.byName('step first')).to.have.length(1);
    expect(spans.byName('step second')).to.have.length(1);
  });

  it('starts an instance outside any span with no stored traceparent and an activation without links', async () => {
    const { id } = await service.start('trc-sum', { a: 1, b: 1 });
    await (await engine()).tick();
    expect((await instance(id)).TraceParent).to.equal(null);
    expect(spans.byName('workflow trc-sum')[0].links).to.deep.equal([]);
  });

  it('marks a failed step by its error class and a failed instance with the word failed, never the message', async () => {
    const { id } = await service.start('trc-fail', null);
    await (await engine()).tick();

    expect((await instance(id)).Status).to.equal('failed');
    const [step] = spans.byName('step charge');
    expect(step.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'ChargeDeclined' });
    expect(step.attributes['error.type']).to.equal('ChargeDeclined');
    const [activation] = spans.byName('workflow trc-fail');
    expect(activation.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'failed' });
    for (const span of [step, activation]) {
      expect(span.events).to.deep.equal([]);
      expect(JSON.stringify([span.status, span.attributes])).not.to.include('secret-4111');
    }
  });

  it('runs an activation whose stored traceparent is malformed without a link', async () => {
    // one activation per tick on SQLite
    for (const [n, TraceParent] of ['', 'not-a-traceparent', '00-00000000000000000000000000000000-0000000000000000-01', 'ff-x-y-z'].entries()) {
      await seedInstance(`bad-${n}`, { Workflow: 'trc-sum', Input: { a: n, b: 1 }, TraceParent });
      await (await engine()).tick();
    }

    const activations = spans.byName('workflow trc-sum');
    expect(activations).to.have.length(4);
    expect(activations.flatMap((s) => s.links)).to.deep.equal([]);
    for (let n = 0; n < 4; n++) expect((await instance(`bad-${n}`)).Status).to.equal('completed');
  });
});
