import 'mocha';
import { runAuthnBehaviour } from '@spinajs/authn-testing';

import { bootV3Db, shutdownV3Db } from './db.js';
import { tokenHarness } from './harness.js';

describe('authn-token behaviour', function () {
  before(async function () {
    this.timeout(15000);
    await bootV3Db();
  });

  after(() => {
    shutdownV3Db();
  });

  runAuthnBehaviour(['A14'], tokenHarness, { title: 'authn-token: A14', claim: ['A14/token'] });
});
