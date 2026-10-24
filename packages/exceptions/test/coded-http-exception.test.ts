import { expect } from 'chai';
import { CodedHttpException, Exception, InvalidArgument, UnexpectedServerError } from '../src/index.js';
import type { CodedErrorBody } from '../src/index.js';

type InvoiceCode = 'invoice.locked' | 'invoice.missing';

class InvoiceException extends CodedHttpException<InvoiceCode, { invoice: string }> {}

describe('CodedHttpException', () => {
  it('is an Exception with its status, code and message', () => {
    const err = new CodedHttpException(409, 'invoice.locked', 'The invoice is locked');

    expect(err).to.be.instanceOf(Exception);
    expect([err.status, err.code, err.message, err.name]).to.deep.equal([409, 'invoice.locked', 'The invoice is locked', 'CodedHttpException']);
  });

  it('uses the code as the message when none is given', () => {
    expect(new CodedHttpException(400, 'input.invalid').message).to.equal('input.invalid');
  });

  it('keeps status, code and given details as its only own enumerable fields', () => {
    const cause = new Error('ECONNREFUSED 10.0.0.7:9000');

    expect({ ...new InvoiceException(409, 'invoice.locked', 'locked', { invoice: '2026-0042' }, cause) }).to.deep.equal({
      status: 409,
      code: 'invoice.locked',
      details: { invoice: '2026-0042' },
    });
    expect(Object.keys(new CodedHttpException(404, 'invoice.missing'))).to.have.members(['status', 'code']);
  });

  it('keeps the cause as inner and cause', () => {
    const cause = new Error('ECONNREFUSED 10.0.0.7:9000');
    const err = new CodedHttpException(503, 'storage.unavailable', undefined, undefined, cause);

    expect([err.inner, err.cause]).to.deep.equal([cause, cause]);
  });

  it('names a subclass after itself', () => {
    const err = new InvoiceException(404, 'invoice.missing');

    expect(err.name).to.equal('InvoiceException');
    expect(err).to.be.instanceOf(CodedHttpException);
  });

  it('refuses a status that is not a 4xx or 5xx with an error answered as a server error, not a client one', () => {
    for (const status of [200, 302, 399, 600, 404.5, NaN]) {
      expect(() => new CodedHttpException(status, 'input.invalid'), String(status))
        .to.throw(UnexpectedServerError)
        .and.not.be.instanceOf(InvalidArgument);
    }
  });

  it('types the answer body', () => {
    const body: CodedErrorBody<InvoiceCode, { invoice: string }> = { code: 'invoice.locked', message: 'locked', details: { invoice: '2026-0042' } };

    expect(body.code).to.equal('invoice.locked');
  });
});
