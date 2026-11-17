import 'mocha';
import { expect } from 'chai';
import { IDEMPOTENCY_DOC, IdempotencyMiddleware, idempotencyDocumentation, parseIdempotencyKey, resolveIdempotentOptions } from '../src/index.js';

describe('idempotency documentation', () => {
  it('documents the key header, the replay header and the gate answers', () => {
    const doc = idempotencyDocumentation(false);
    expect(doc.requestHeaders).to.deep.equal({ 'Idempotency-Key': { description: IDEMPOTENCY_DOC.keyDescription, required: false, schema: { type: 'string', minLength: 1, maxLength: 512 } } });
    expect(doc.headers).to.deep.equal({ 'Idempotent-Replayed': { description: IDEMPOTENCY_DOC.replayedDescription, type: 'string' } });
    expect(Object.keys(doc.responses ?? {})).to.deep.equal(['400', '409', '422']);
    expect(doc.responses?.['400'].headers).to.equal(undefined);
    expect(doc.responses?.['409'].headers).to.deep.equal({ 'Retry-After': { description: IDEMPOTENCY_DOC.retryAfterDescription, type: 'integer' } });
    expect(doc.responses?.['422'].contentType).to.equal('application/problem+json');
  });

  it('documents a length the longest valid header fits: 255 escaped characters in quotes', () => {
    const longest = `"${'\\"'.repeat(255)}"`;
    expect(parseIdempotencyKey(longest)).to.equal('"'.repeat(255));
    expect(longest).to.have.length(IDEMPOTENCY_DOC.keySchema.maxLength);
  });

  it('is what the middleware @Idempotent mounts documents, required as the route says', () => {
    const middleware = new IdempotencyMiddleware(resolveIdempotentOptions({ required: true }));
    expect(middleware.documentation().requestHeaders?.['Idempotency-Key'].required).to.equal(true);
  });
});
