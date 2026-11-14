import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, TraceFlags, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { DI } from '@spinajs/di';
import { LogLevel, createLogMessageObject } from '@spinajs/log-common';

import { LogBotstrapper } from '../src/index.js';
import { activeTraceFields } from '../src/trace-context.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const local = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED });
const inSpan = <T>(fn: () => T, span: Span = local): T => context.with(trace.setSpan(ROOT_CONTEXT, span), fn);

describe('log trace correlation', () => {
  const testing = process.env.TESTING;

  before(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    // Keeps LogBotstrapper from installing process-wide exception handlers.
    process.env.TESTING = '1';
    DI.resolve(LogBotstrapper).bootstrap();
  });

  after(() => {
    context.disable();
    if (testing === undefined) delete process.env.TESTING;
    else process.env.TESTING = testing;
  });

  it('puts the ids of the active span on a log entry', () => {
    const entry = inSpan(() => createLogMessageObject('', 'in a span', LogLevel.Info, 'trace-test', {}));
    expect(entry.Variables).to.include({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('adds nothing outside a span', () => {
    const entry = createLogMessageObject('', 'no span', LogLevel.Info, 'trace-test', {});
    expect(entry.Variables).to.not.have.property('traceId');
  });

  it("ignores a remote span context: its span id is the caller's", () => {
    const remote = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED, isRemote: true });
    expect(inSpan(() => activeTraceFields(), remote)).to.deep.eq({});
  });

  it('lets explicit variables win over the active span', () => {
    const entry = inSpan(() => createLogMessageObject('', 'explicit', LogLevel.Info, 'trace-test', { traceId: 'explicit' }));
    expect(entry.Variables.traceId).to.eq('explicit');
  });
});
