import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { resetUploads } from '../support/env.js';
import { Seen } from './support/calls.js';
import { uploadApp } from './support/app.js';
import type { UploadErrorBody } from '../../src/http/index.js';
import { bodyOf, call } from './support/client.js';

const OWN = '/guarded/uploads';

describe('UploadController with a subclass @OnError guarded by answeredAsServerError', function () {
  this.timeout(30000);

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
  });
  afterEach(() => sinon.restore());

  it('lets an UploadError reach the base handler: its own status and body, not 500', async () => {
    const res = await call('get', `${OWN}/00000000-0000-4000-8000-000000000000`);

    expect(Seen.guarded).to.deep.equal([{ name: 'UploadError', server: false }]);
    expect([res.status, bodyOf<UploadErrorBody>(res).code]).to.deep.equal([404, 'upload.not_found']);
  });

  it('answers a server error itself, which shows the handler is in the chain', async () => {
    const res = await call('post', OWN, { headers: { 'x-test-boom': '1' } }).send({ name: 'notes.txt', size: 10 });

    expect(Seen.guarded).to.deep.equal([{ name: 'Error', server: true }]);
    expect([res.status, res.body]).to.deep.equal([500, { code: 'app.failed', message: 'Failed' }]);
  });
});
