import 'mocha';
import { expect } from 'chai';
import { CodedHttpException } from '@spinajs/exceptions';

import { UploadError } from '../src/index.js';

describe('UploadError', () => {
  it('is a CodedHttpException with the status of its code', () => {
    const err = new UploadError('upload.expired', 'upload 42 expired');

    expect(err).to.be.instanceOf(CodedHttpException);
    expect([err.status, err.code, err.message, err.name]).to.deep.equal([410, 'upload.expired', 'upload 42 expired', 'UploadError']);
  });

  it('keeps empty details readable but off its own enumerable fields, so no answer carries details: {}', () => {
    const err = new UploadError('upload.not_found');

    expect(err.details).to.deep.equal({});
    expect({ ...err }).to.deep.equal({ status: 404, code: 'upload.not_found' });
  });

  it('spreads details that name parts', () => {
    expect({ ...new UploadError('upload.parts_missing', 'missing', { parts: [2] }) }).to.deep.equal({ status: 409, code: 'upload.parts_missing', details: { parts: [2] } });
  });
});
