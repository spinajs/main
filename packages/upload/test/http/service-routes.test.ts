import 'mocha';
import { expect } from 'chai';
import { answeredAsServerError } from '@spinajs/http';

import { UploadError } from '../../src/index.js';
import type { UploadErrorBody } from '../../src/http/index.js';
import { uploadApp } from './support/app.js';
import { bodyOf, call } from './support/client.js';

describe('UploadError outside UploadController', function () {
  this.timeout(30000);

  before(uploadApp);

  it('answers its own status and the body UploadController answers, through the framework error map', async () => {
    const missing = await call('get', '/service-routes/missing');
    expect([missing.status, bodyOf<UploadErrorBody>(missing)]).to.deep.equal([404, { code: 'upload.not_found', message: 'upload 42 not found' }]);

    const partsMissing = await call('get', '/service-routes/partsMissing');
    expect([partsMissing.status, bodyOf<UploadErrorBody>(partsMissing)]).to.deep.equal([
      409,
      { code: 'upload.parts_missing', message: 'parts 2 and 3 are missing', details: { parts: [2, 3] } },
    ]);
  });

  it('is not answered as a server error', () => {
    expect(answeredAsServerError(new UploadError('upload.not_found'))).to.eq(false);
  });
});
