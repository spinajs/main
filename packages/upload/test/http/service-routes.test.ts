import 'mocha';
import { expect } from 'chai';
import { answeredAsServerError } from '@spinajs/http';

import { UploadError } from '../../src/index.js';
import { uploadApp } from './support/app.js';
import { bodyOf, call } from './support/client.js';

// Outside UploadController the framework error map answers an application/problem+json document
const problemOf = (res: Parameters<typeof bodyOf>[0]): Record<string, unknown> => bodyOf<Record<string, unknown>>(res);

describe('UploadError outside UploadController', function () {
  this.timeout(30000);

  before(uploadApp);

  it('answers its own status and a problem document through the framework error map', async () => {
    const missing = await call('get', '/service-routes/missing');
    expect(missing.status).to.eq(404);
    expect(problemOf(missing)).to.deep.equal({
      type: 'about:blank',
      title: 'Upload Error',
      status: 404,
      detail: 'upload 42 not found',
      instance: '/service-routes/missing',
      code: 'upload.not_found',
    });

    const partsMissing = await call('get', '/service-routes/partsMissing');
    expect(partsMissing.status).to.eq(409);
    expect(problemOf(partsMissing)).to.deep.equal({
      type: 'about:blank',
      title: 'Upload Error',
      status: 409,
      detail: 'parts 2 and 3 are missing',
      instance: '/service-routes/partsMissing',
      code: 'upload.parts_missing',
      details: { parts: [2, 3] },
    });
  });

  it('is not answered as a server error', () => {
    expect(answeredAsServerError(new UploadError('upload.not_found'))).to.eq(false);
  });
});
