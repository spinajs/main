import 'mocha';
import { expect } from 'chai';
import { SpanStatusCode } from '@opentelemetry/api';

import { errorTypeOf, markSpanError, markSpanErrorType, tracer, withSpan } from '../src/index.js';
import { resetTracing, useInMemorySpans } from '../src/testing.js';
import type { InMemorySpans } from '../src/testing.js';

class BindingError extends Error {}

const SECRET = 'params: secret-binding-42';

async function failing(recordError?: Parameters<typeof withSpan>[3]): Promise<unknown> {
  return withSpan(
    'guarded',
    {},
    () => {
      throw new BindingError(SECRET);
    },
    recordError,
  ).then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe('type-only error recording', () => {
  let spans: InMemorySpans;

  beforeEach(() => {
    spans = useInMemorySpans();
  });

  afterEach(() => spans.detach());

  after(() => resetTracing());

  it('names the class of an error and the type of anything else', () => {
    expect(errorTypeOf(new BindingError('x'))).to.eq('BindingError');
    expect(errorTypeOf('boom')).to.eq('string');
    expect(errorTypeOf(undefined)).to.eq('undefined');
  });

  it('marks a span ERROR with the class only', () => {
    const span = tracer().startSpan('direct');
    markSpanErrorType(span, new BindingError(SECRET));
    span.end();

    const [ended] = spans.byName('direct');
    expect(ended.status).to.deep.eq({ code: SpanStatusCode.ERROR, message: 'BindingError' });
    expect(ended.attributes['error.type']).to.eq('BindingError');
    expect(ended.events).to.deep.eq([]);
  });

  it('withSpan records with the recorder it is given and rethrows', async () => {
    expect(await failing(markSpanErrorType)).to.be.instanceOf(BindingError);

    const [ended] = spans.byName('guarded');
    expect(ended.status).to.deep.eq({ code: SpanStatusCode.ERROR, message: 'BindingError' });
    expect(JSON.stringify({ status: ended.status, attributes: ended.attributes, events: ended.events })).to.not.contain('secret-binding-42');
  });

  it('withSpan keeps the message for a caller that passes markSpanError', async () => {
    await failing(markSpanError);

    const [ended] = spans.byName('guarded');
    expect(ended.status.message).to.eq(SECRET);
    expect(ended.events.map((e) => e.name)).to.deep.eq(['exception']);
  });
});
