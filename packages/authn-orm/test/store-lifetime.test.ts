import { expect } from 'chai';
import 'mocha';

import { DbAuthnAuditSink, DbAuthnThrottle, DbIdentityLinkStore, DbMfaEnrolments, DbMfaStore, DbNonceStore, DbSecretStore } from '../src/index.js';
import { TestDb, bootDb } from './support/db.js';

describe('authn-orm stores per child container', function () {
  this.timeout(60000);

  let a: TestDb;
  let b: TestDb;

  before(async function () {
    a = await bootDb(this, 'sqlite', 'lifetime-a');
    b = await bootDb(this, 'sqlite', 'lifetime-b');
  });

  after(async () => {
    await a?.dispose();
    await b?.dispose();
  });

  it('gives each container its own instance and keeps it', async () => {
    for (const type of [DbAuthnAuditSink, DbIdentityLinkStore, DbMfaStore, DbNonceStore, DbSecretStore, DbAuthnThrottle, DbMfaEnrolments]) {
      const inA = await a.container.resolve<object>(type);
      expect(inA, type.name).to.not.eq(await b.container.resolve<object>(type));
      expect(inA, type.name).to.eq(await a.container.resolve<object>(type));
    }
  });
});
