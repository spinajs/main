import { expect } from 'chai';
import 'mocha';
import { idempotencyOf } from '../src/index.js';
import type { MiddlewareRef } from '../src/index.js';

const gate = (...decoratorArgs: unknown[]): MiddlewareRef => ({ type: 'IdempotencyMiddleware', decoratorArgs });

describe('idempotencyOf', () => {
  it('answers nothing for a route without the gate', () => {
    expect(idempotencyOf([])).to.equal(undefined);
    expect(idempotencyOf([{ type: 'Audit', options: [] }])).to.equal(undefined);
  });

  it('reads required from the literal options of @Idempotent', () => {
    expect(idempotencyOf([{ type: 'Audit', options: [] }, gate({ required: true, ttl: '1h' })])).to.deep.equal({ required: true });
    expect(idempotencyOf([gate({ ttl: '1h' })])).to.deep.equal({ required: false });
    expect(idempotencyOf([gate({ required: false })])).to.deep.equal({ required: false });
  });

  it('counts a gate without options, or with options that are not a literal, as not required', () => {
    expect(idempotencyOf([gate()])).to.deep.equal({ required: false });
    expect(idempotencyOf([{ type: 'IdempotencyMiddleware' }])).to.deep.equal({ required: false });
  });

  it('takes the first of stacked gates, the one the runtime applies last', () => {
    expect(idempotencyOf([gate({ required: true }), gate()])).to.deep.equal({ required: true });
  });
});
