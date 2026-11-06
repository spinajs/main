import 'mocha';
import { expect } from 'chai';
import { context, trace } from '@opentelemetry/api';
import type { Logger, LogRecord } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { DecisionRecord } from '@spinajs/authz';

import { OtelDecisionLog, OtelDecisionTraceContext, SPINA_AUTHZ_DECISION_ID } from '../src/decision-log.js';

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({ id: 'd-1', at: '2026-11-04T10:00:00.000Z', domain: 'root', principal: 'user:alice', permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, allowed: false, reason: 'no_access', cached: false, policyHash: 'unknown', modelVersions: {}, inputsHash: 'h', ...over });

describe('OtelDecisionLog', () => {
  it('emits one log record per decision record, a denial at WARN, with the decision id attribute', async () => {
    const emitted: LogRecord[] = [];
    const logger: Logger = { emit: (r) => void emitted.push(r) };
    await new OtelDecisionLog(logger).write([record(), record({ id: 'd-2', allowed: true, reason: undefined, traceId: 't', spanId: 's' })]);
    expect(emitted.map((r) => [r.severityText, r.attributes?.[SPINA_AUTHZ_DECISION_ID]])).to.deep.equal([
      ['WARN', 'd-1'],
      ['INFO', 'd-2'],
    ]);
    expect(emitted[0].attributes).to.include({ 'spina.authz.permission': 'doc:read', 'spina.authz.resource': 'doc:d1', 'spina.authz.reason': 'no_access' });
    expect(emitted[1].attributes).to.include({ trace_id: 't', span_id: 's' });
    expect((emitted[0].timestamp as Date).toISOString()).to.equal('2026-11-04T10:00:00.000Z');
  });
});

describe('OtelDecisionTraceContext', () => {
  const manager = new AsyncLocalStorageContextManager();

  before(() => {
    context.setGlobalContextManager(manager.enable());
  });

  after(() => {
    manager.disable();
    context.disable();
  });

  it('reads the active span and tags it with the decision id; outside a span it has nothing', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer('test');
    const ctx = new OtelDecisionTraceContext();
    expect(ctx.current()).to.equal(undefined);
    tracer.startActiveSpan('check', (span) => {
      expect(ctx.current()).to.deep.equal({ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId });
      ctx.annotate('d-1');
      span.end();
    });
    expect(exporter.getFinishedSpans()[0].attributes[SPINA_AUTHZ_DECISION_ID]).to.equal('d-1');
    expect(trace.getActiveSpan()).to.equal(undefined);
  });
});
